import { createHmac } from 'node:crypto';
import type { OutboundConfig } from '../integrations/config.ts';
import { readPath } from '../integrations/paths.ts';
import { silentLogger } from '../log.ts';
import { PRIVATE_TARGET_MESSAGE, systemResolver, webhookTarget } from '../net/private-address.ts';
import type { Job } from '../store/jobs.ts';
import type { DeliveryRow } from '../store/webhook-deliveries.ts';
import type { WorkerDeps } from './send.ts';

export type WebhookEvent = 'message.sent' | 'message.delivered' | 'message.failed' | 'package.completed' | 'message.received';

/** Tyle z zależności workera, ile trzeba do zakolejkowania dostawy - korzysta też odbiornik. */
export type WebhookEmitDeps = Pick<WorkerDeps, 'apiKeys' | 'deliveries' | 'jobs'>;

export interface EmitOptions {
  /** Wiadomość przychodząca, której dotyczy dostawa - do śladu w panelu i plakietki. */
  inboundId?: string;
  /** Po zakończeniu dostawy zastąpić treść skrótem (konto bez przechowywania treści). */
  scrubAfter?: boolean;
}

export type HttpPost = (
  url: string, headers: Record<string, string>, body: string, method?: string,
) => Promise<{ status: number; body: string }>;

/** Ponowienia z §6.3: 1 min, 5 min, 15 min, 1 h, 6 h. */
export const WEBHOOK_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;

const REQUEST_TIMEOUT_MS = 10_000;

/** Tyle odpowiedzi odbiorcy zachowujemy do diagnozy. */
const RESPONSE_CHARS = 300;

/** Tyle odpowiedzi czytamy z sieci - integracja może z niej wyciągać identyfikator zgłoszenia. */
export const RESPONSE_READ_CHARS = 65_536;

/** `sha256=` + HMAC-SHA256 z sekretu po `<znacznik czasu>.<body>`. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Bez podążania za przekierowaniami - podpisane body ma trafić dokładnie pod zapisany adres. */
export const httpPost: HttpPost = async (url, headers, body, method = 'POST') => {
  const res = await fetch(url, {
    method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'manual',
  });
  return { status: res.status, body: (await res.text()).slice(0, RESPONSE_READ_CHARS) };
};

/** Zapisuje dostawę i zadanie. Klucz bez adresu webhooka nic nie dostaje. */
export function emitWebhook(
  deps: WebhookEmitDeps, apiKeyId: number, event: WebhookEvent, payload: Record<string, unknown>, now: Date,
  opts: EmitOptions = {},
): number | null {
  const key = deps.apiKeys.get(apiKeyId);
  if (!key?.webhookUrl) return null;
  const body = JSON.stringify({ event, at: now.toISOString(), ...payload });
  const id = deps.deliveries.insert({
    apiKeyId, event, payload: body, url: key.webhookUrl, createdAt: now,
    inboundId: opts.inboundId ?? null, scrubAfter: opts.scrubAfter === true,
  });
  deps.jobs.enqueue('webhook', { deliveryId: id }, now);
  return id;
}

/** Integracja wychodząca, której dotyczy dostawa, z konfiguracją zawężoną do wychodzącej. */
interface DeliveryIntegration { id: number; name: string; config: OutboundConfig }

/** Stan końcowy dostawy integracji: wpis w dzienniku, przy porażce powiadomienie administratora. */
function closeIntegrationDelivery(deps: WorkerDeps, integration: DeliveryIntegration, delivery: DeliveryRow, now: Date, ok: boolean, response: string, reason?: string): void {
  deps.integrationEvents?.record({
    integrationId: integration.id, at: now, result: ok ? 'delivered' : 'undelivered', deliveryId: delivery.id,
    response: response.slice(0, RESPONSE_CHARS), logLimit: integration.config.eventLogLimit,
    ...(reason !== undefined ? { reason } : {}),
    ...(delivery.inboundId !== null ? { inboundId: delivery.inboundId } : {}),
  });
  if (!ok) {
    deps.notifier?.notify('webhook_undelivered', `integration:${integration.id}`, `${integration.name}: ${response.slice(0, 120)}`, now);
  }
}

export async function handleWebhook(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  const delivery = deps.deliveries.get(Number(job.payload.deliveryId));
  if (!delivery || delivery.status !== 'pending') {
    deps.jobs.complete(job.id);
    return;
  }

  // Dostawa integracji: adres, metoda i nagłówki z integracji, nie z klucza. Integracja usunięta
  // albo wyłączona po zakolejkowaniu kończy dostawę bez wywołania - administrator ją zgasił świadomie.
  let integration: DeliveryIntegration | null = null;
  if (delivery.integrationId !== null) {
    const row = deps.integrations?.get(delivery.integrationId);
    if (!row || row.enabled === 0 || row.kind !== 'webhook_out') {
      deps.deliveries.markFailed(delivery.id, 'integracja usunięta albo wyłączona');
      deps.jobs.complete(job.id);
      return;
    }
    integration = { id: row.id, name: row.name, config: row.config as OutboundConfig };
  }

  // Sekret klucza potrzebny dostawie klucza zawsze, integracji tylko z włączonym podpisem.
  const wantsSignature = integration === null || integration.config.sign;
  const secret = wantsSignature ? deps.apiKeys.webhookSecret(delivery.apiKeyId) : null;
  if (integration === null && secret === null) {
    deps.deliveries.markFailed(delivery.id, 'klucz nie ma już sekretu webhooka');
    deps.jobs.complete(job.id);
    return;
  }

  const fail = (response: string): void => {
    deps.deliveries.markFailed(delivery.id, response);
    deps.jobs.complete(job.id);
    if (integration) closeIntegrationDelivery(deps, integration, delivery, now, false, response);
    log.warn('webhook.nieudany', { deliveryId: delivery.id, event: delivery.event, response: response.slice(0, 120) });
  };
  const retry = (response: string, delay: number): void => {
    deps.deliveries.markRetry(delivery.id, new Date(now.getTime() + delay), response);
    deps.jobs.retry(job.id, new Date(now.getTime() + delay), response);
  };

  // Cel sprawdzamy przy każdej dostawie, nie tylko przy zapisie adresu: nazwa mogła zacząć
  // wskazywać sieć wewnętrzną później. Nazwa bez adresu to awaria sieci - ponawiamy.
  const target = await webhookTarget(delivery.url, deps.resolve ?? systemResolver);
  if (target.kind === 'private' && !deps.allowPrivateWebhooks) {
    fail(`${PRIVATE_TARGET_MESSAGE} (${target.address})`);
    log.warn('webhook.odmowa_sieci_wewnetrznej', { deliveryId: delivery.id, event: delivery.event, address: target.address });
    return;
  }
  if (target.kind === 'unresolved') {
    const response = `nazwa nie rozwiązuje się: ${target.reason}`;
    const delay = WEBHOOK_BACKOFF_MS[job.attempts];
    if (delay === undefined) fail(response);
    else retry(response, delay);
    return;
  }

  const headers: Record<string, string> = integration
    ? deps.deliveries.headers(delivery.id)
    : { 'Content-Type': 'application/json' };
  if (secret !== null) {
    const timestamp = Math.floor(now.getTime() / 1000);
    headers['X-MIG-Event'] = delivery.event;
    headers['X-MIG-Timestamp'] = String(timestamp);
    headers['X-MIG-Signature'] = signWebhook(secret, timestamp, delivery.payload);
  }

  let outcome: { status: number; body: string } | null = null;
  let failure = '';
  try {
    outcome = await (deps.post ?? httpPost)(delivery.url, headers, delivery.payload, delivery.method);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  if (outcome && outcome.status >= 200 && outcome.status < 300) {
    const response = `${outcome.status} ${outcome.body.slice(0, RESPONSE_CHARS)}`;
    deps.deliveries.markDelivered(delivery.id, now, response);
    deps.jobs.complete(job.id);
    if (integration) {
      // Identyfikator zgłoszenia z odpowiedzi: przy odebranej zapamiętany do odpowiedzi w wątku.
      let reason: string | undefined;
      const refPath = integration.config.responseRefPath;
      if (refPath !== undefined) {
        let ref: unknown;
        try {
          ref = readPath(JSON.parse(outcome.body), refPath);
        } catch {
          ref = undefined;
        }
        if (ref === undefined || ref === null || String(ref) === '' || typeof ref === 'object') {
          reason = `w odpowiedzi nie znaleziono pola ${refPath}`;
        } else {
          deps.deliveries.setResponseRef(delivery.id, String(ref));
          if (delivery.inboundId !== null) deps.inbound.setExternalRef(delivery.inboundId, integration.id, String(ref));
        }
      }
      closeIntegrationDelivery(deps, integration, delivery, now, true, response, reason);
    }
    log.info('webhook.dostarczony', { deliveryId: delivery.id, event: delivery.event, attempt: job.attempts + 1 });
    return;
  }

  const response = outcome ? `${outcome.status} ${outcome.body.slice(0, RESPONSE_CHARS)}` : failure;
  // 4xx to decyzja odbiorcy - ponawianie nic nie zmieni. 5xx i awarie sieci ponawiamy.
  const permanent = outcome !== null && outcome.status >= 400 && outcome.status < 500;
  const delay = WEBHOOK_BACKOFF_MS[job.attempts];
  if (permanent || delay === undefined) {
    fail(response);
    return;
  }
  retry(response, delay);
}
