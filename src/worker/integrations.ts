import { OUTBOUND_EVENTS, type OutboundConfig, type OutboundEvent } from '../integrations/config.ts';
import { matches } from '../integrations/conditions.ts';
import { runSmsGroup, type PipelineDeps, type ReceivedEvent, type SmsGroupIntegration } from '../integrations/pipeline.ts';
import { TemplateEngine, TemplateError } from '../integrations/templates.ts';
import { silentLogger, type Logger } from '../log.ts';
import type { AdminNotifier } from '../notifications/rules.ts';
import type { IntegrationEventsRepo } from '../store/integration-events.ts';
import type { IntegrationGuardsRepo } from '../store/integration-guards.ts';
import type { IntegrationsRepo } from '../store/integrations.ts';
import type { JobsRepo } from '../store/jobs.ts';
import type { WebhookDeliveriesRepo } from '../store/webhook-deliveries.ts';

/** Zależności wysyłki SMS dla grup; bez nich grupa zapisuje błąd zamiast rozsyłać. */
export type SmsGroupDeps = Pick<PipelineDeps, 'accounts' | 'apiKeys' | 'messages' | 'events' | 'jobs' | 'inbound'>;

export interface IntegrationEmitDeps {
  integrations: IntegrationsRepo;
  integrationEvents: IntegrationEventsRepo;
  guards: IntegrationGuardsRepo;
  deliveries: WebhookDeliveriesRepo;
  jobs: JobsRepo;
  engine: TemplateEngine;
  notifier?: AdminNotifier;
  log?: Logger;
  group?: SmsGroupDeps;
}

export interface EmitIntegrationsOptions {
  inboundId?: string;
  messageId?: string;
  /** Po stanie końcowym dostawy body ma zniknąć (konto bez przechowywania treści). */
  scrubAfter?: boolean;
}

export const isOutboundEvent = (event: string): event is OutboundEvent => (OUTBOUND_EVENTS as readonly string[]).includes(event);

/**
 * Kontekst szablonu wychodzącego: pola zdarzenia bramki na wierzchu (`from`, `text`, `status`...),
 * do tego `event`, `at`, `now`, `integration.name` i całe zdarzenie pod `p` - jak w przychodzącym.
 */
export function buildOutboundContext(event: OutboundEvent, payload: Record<string, unknown>, integration: { name: string }, now: Date): Record<string, unknown> {
  const at = now.toISOString();
  const full = { event, at, ...payload };
  return { ...full, p: full, now: at, integration: { name: integration.name } };
}

export interface RenderedOutbound { headers: Record<string, string>; body: string; contentType: string }

/**
 * Nagłówki i body dostawy. Sekretne nagłówki podstawiane poza silnikiem: szablon nie ma do nich
 * dostępu, a ich wartości nie trafiają do kontekstu. Body JSON musi się parsować - inaczej
 * obca aplikacja odrzuciłaby dostawę dopiero po pięciu ponowieniach.
 */
export function renderOutbound(engine: TemplateEngine, config: OutboundConfig, secrets: Record<string, string>, context: Record<string, unknown>): RenderedOutbound {
  const contentType = config.body.mode === 'json' ? 'application/json'
    : config.body.mode === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain; charset=utf-8';
  const headers: Record<string, string> = { 'Content-Type': contentType };
  for (const h of config.headers) {
    headers[h.name] = h.valueRef !== undefined ? (secrets[h.valueRef] ?? '') : engine.render(h.value ?? '', context);
  }
  let body: string;
  if (config.body.mode === 'json') {
    body = engine.render(config.body.template, context);
    try {
      JSON.parse(body);
    } catch {
      throw new TemplateError('Body po podstawieniu nie jest poprawnym JSON-em - użyj filtru json przy polach tekstowych.');
    }
  } else if (config.body.mode === 'form') {
    const params = new URLSearchParams();
    for (const f of config.body.fields) params.set(f.name, engine.render(f.template, context));
    body = params.toString();
  } else {
    body = engine.render(config.body.template, context);
  }
  return { headers, body, contentType };
}

/** Podgląd do „Sprawdź szablon”: sekretne nagłówki zamaskowane, body jak w dostawie. */
export function previewOutbound(engine: TemplateEngine, config: OutboundConfig, secretNames: string[], sample: Record<string, unknown>, now: Date): { headers: Record<string, string>; body: string; error: string | null } {
  const masked = Object.fromEntries(secretNames.map((n) => [n, '••••']));
  try {
    const event = (typeof sample.event === 'string' && isOutboundEvent(sample.event) ? sample.event : config.events[0]) ?? 'message.received';
    const out = renderOutbound(engine, config, masked, buildOutboundContext(event, sample, { name: 'podgląd' }, now));
    return { headers: out.headers, body: out.body, error: null };
  } catch (e) {
    return { headers: {}, body: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Dostawy do integracji wychodzących klucza dla zdarzenia; każda ma własną kolejkę i ponowienia.
 * Webhook klucza działa obok, niezależnie. Zwraca identyfikatory utworzonych dostaw.
 */
export function emitIntegrations(
  deps: IntegrationEmitDeps, apiKeyId: number, event: OutboundEvent, payload: Record<string, unknown>, now: Date,
  opts: EmitIntegrationsOptions = {},
): number[] {
  const log = deps.log ?? silentLogger;
  const ids: number[] = [];
  for (const integration of deps.integrations.listOutboundFor(apiKeyId, event)) {
    if (integration.kind === 'sms_group') {
      runGroup(deps, integration as SmsGroupIntegration, payload as unknown as ReceivedEvent, now);
      continue;
    }
    const config = integration.config as OutboundConfig;
    const context = buildOutboundContext(event, payload, integration, now);
    const stored = integration.storePayloads === 1 ? JSON.stringify(payload) : null;
    const note = (result: 'skipped' | 'throttled' | 'error' | 'sent', reason?: string, deliveryId?: number) =>
      deps.integrationEvents.record({
        integrationId: integration.id, at: now, result, payload: stored, logLimit: config.eventLogLimit,
        ...(reason !== undefined ? { reason } : {}),
        ...(deliveryId !== undefined ? { deliveryId } : {}),
        ...(opts.inboundId !== undefined ? { inboundId: opts.inboundId } : {}),
        ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
      });
    try {
      if (!matches(config.condition, context, deps.engine)) {
        note('skipped', 'warunek niespełniony');
        continue;
      }
      const gate = deps.guards.throttle(integration.id, config.throttle.limit, config.throttle.windowMinutes, now);
      if (!gate.allowed) {
        note('throttled', `ponad ${config.throttle.limit} w ${config.throttle.windowMinutes} min`);
        if (gate.notify) {
          deps.notifier?.notify('integration_throttled', `integration:${integration.id}`,
            `${integration.name}: przekroczony limit ${config.throttle.limit} w ${config.throttle.windowMinutes} min`, now);
        }
        continue;
      }
      const rendered = renderOutbound(deps.engine, config, deps.integrations.secrets(integration.id), context);
      const id = deps.deliveries.insert({
        apiKeyId, event, payload: rendered.body, url: config.url, createdAt: now, inboundId: opts.inboundId ?? null,
        scrubAfter: opts.scrubAfter === true, integrationId: integration.id, method: config.method, headers: rendered.headers,
      });
      deps.jobs.enqueue('webhook', { deliveryId: id }, now);
      note('sent', undefined, id);
      ids.push(id);
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      note('error', e.message);
      deps.notifier?.notify('integration_error', `integration:${integration.id}`, `${integration.name}: ${e.message}`, now);
      log.warn('integracja.szablon', { integrationId: integration.id });
    }
  }
  return ids;
}

/**
 * Grupa SMS zamiast dostawy HTTP: rozesłanie dzieje się od razu, synchronicznie, bo odbiornik czyści treść
 * odebranego SMS-a po powiadomieniach na koncie bez przechowywania treści. Proces bez zależności wysyłki
 * (sam panel) zapisuje błąd zamiast cicho pominąć grupę.
 */
function runGroup(deps: IntegrationEmitDeps, integration: SmsGroupIntegration, event: ReceivedEvent, now: Date): void {
  const notifyError = (detail: string) =>
    deps.notifier?.notify('integration_error', `integration:${integration.id}`, `${integration.name}: ${detail}`, now);
  if (!deps.group) {
    const detail = 'wysyłka SMS niedostępna w tym procesie';
    deps.integrationEvents.record({
      integrationId: integration.id, at: now, result: 'error', reason: detail, logLimit: integration.config.eventLogLimit,
      sourceIp: event.from, inboundId: event.id, payload: integration.storePayloads === 1 ? JSON.stringify(event) : null,
    });
    notifyError(detail);
    return;
  }
  const pipeline: PipelineDeps = {
    ...deps.group, integrations: deps.integrations, integrationEvents: deps.integrationEvents, guards: deps.guards, engine: deps.engine,
    ...(deps.log ? { log: deps.log } : {}),
  };
  const out = runSmsGroup(pipeline, integration, event, now);
  if (out.kind === 'throttled' && out.notify) {
    const { limit, windowMinutes } = integration.config.throttle;
    deps.notifier?.notify('integration_throttled', `integration:${integration.id}`, `${integration.name}: przekroczony limit ${limit} w ${windowMinutes} min`, now);
  }
  if (out.kind === 'error' || out.kind === 'unavailable') notifyError(out.detail);
}
