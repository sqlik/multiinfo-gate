import { ApiError } from '../api/errors.ts';
import { authFromKey, keyUsable, submitMessages, type SubmitDeps } from '../api/submit.ts';
import { silentLogger, type Logger } from '../log.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { IntegrationEventInput, IntegrationEventsRepo } from '../store/integration-events.ts';
import type { IntegrationGuardsRepo } from '../store/integration-guards.ts';
import type { IntegrationRow, IntegrationsRepo } from '../store/integrations.ts';
import { measureText } from '../text/measure.ts';
import { InvalidPhoneError, normalizeRecipient, splitRecipients, TooManyRecipientsError } from '../text/phone.ts';
import { segmentText, TooManyPartsError } from '../text/segment.ts';
import type { InboundConfig } from './config.ts';
import { matches } from './conditions.ts';
import { enrich, safeUrl, type EnrichGet } from './enrich.ts';
import { readPath } from './paths.ts';
import { TemplateEngine, TemplateError } from './templates.ts';
import type { Resolver } from '../net/private-address.ts';

export interface PipelineDeps extends SubmitDeps {
  apiKeys: ApiKeysRepo;
  /** Sekrety integracji - zapytanie uzupełniające podstawia je poza szablonem. */
  integrations: IntegrationsRepo;
  integrationEvents: IntegrationEventsRepo;
  guards: IntegrationGuardsRepo;
  engine: TemplateEngine;
  /** Wysyłka zapytania uzupełniającego; testy podstawiają atrapę, produkcja bierze `httpGet`. */
  enrichGet?: EnrichGet;
  /** Rozwiązywanie nazwy celu zapytania uzupełniającego; testy podstawiają atrapę. */
  resolve?: Resolver;
  /** MIG_WEBHOOK_ALLOW_PRIVATE: zgoda na pytanie aplikacji w sieci wewnętrznej. */
  allowPrivateWebhooks?: boolean;
  log?: Logger;
}

export type InboundErrorCode = 'empty_text' | 'no_recipient' | 'invalid_phone' | 'too_many_recipients' | 'too_many_parts' | 'template' | 'enrich' | 'service';

export type InboundOutcome =
  | { kind: 'sent'; messageIds: string[] }
  /** Bez powodu: zdarzenie odsiał warunek. Z powodem: zadziałało odstępstwo opisane przy powodzie. */
  | { kind: 'skipped'; reason?: 'invalid_recipient' }
  | { kind: 'duplicate' }
  | { kind: 'throttled'; notify: boolean }
  | { kind: 'error'; code: InboundErrorCode; detail: string }
  | { kind: 'unavailable'; detail: string };

export type InboundIntegration = IntegrationRow & { config: InboundConfig };

export interface InboundPreview {
  matches: boolean; recipients: string[]; text: string; parts: number; error: string | null;
  /** Brak numeru w ładunku i na liście zapasowej, ale jest identyfikator zgłoszenia - odbiorcą będzie nadawca dopasowanej odebranej. */
  threadRecipient: boolean;
}

/** Kontekst szablonu: cały ładunek pod `p`, do tego chwila i nazwa integracji. Nic z sekretów. */
export function buildInboundContext(payload: unknown, integration: { name: string }, now: Date): Record<string, unknown> {
  return { p: payload, now: now.toISOString(), integration: { name: integration.name } };
}

export function renderInboundText(engine: TemplateEngine, config: InboundConfig, context: Record<string, unknown>): string {
  if (config.text.mode === 'path') {
    const value = readPath(context.p, config.text.path);
    return (value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)).trim();
  }
  return engine.render(config.text.template, context).trim();
}

/** Identyfikator zgłoszenia z ładunku (ścieżka `ticketRefPath`) jako tekst albo null. */
function ticketRef(config: InboundConfig, payload: unknown): string | null {
  if (config.ticketRefPath === undefined) return null;
  const ref = readPath(payload, config.ticketRefPath);
  return ref === undefined || ref === null || String(ref) === '' ? null : String(ref);
}

/**
 * Odbiorcy, surowi, przed normalizacją: ścieżka z ładunku, potem nadawca odebranego SMS-a
 * dopasowanego po identyfikatorze zgłoszenia (helpdeski nie przesyłają numeru w webhooku
 * odpowiedzi), na końcu lista zapasowa.
 */
/**
 * Odbiorcy wraz ze źródłem. Źródło rozstrzyga, czy zły numer jest daną z zewnątrz, czy pomyłką
 * administratora: lista zapasowa oraz nadawca wątku pochodzą z bramki, ładunek z obcej aplikacji.
 */
function rawRecipients(config: InboundConfig, payload: unknown, threadSender: string | null): { list: string[]; fromPayload: boolean } {
  const fromPayload = config.to.path === undefined ? [] : splitRecipients(readPath(payload, config.to.path));
  if (fromPayload.length > 0) return { list: fromPayload, fromPayload: true };
  if (threadSender !== null) return { list: [threadSender], fromPayload: false };
  return { list: config.to.fallback, fromPayload: false };
}

/**
 * Ładunek widziany przez ścieżki po dopytaniu: odpowiedź aplikacji siada w nim pod nazwą z `as`,
 * dzięki czemu `to.path` oraz tryb ścieżki czytają ją tak samo jak szablon czyta `{{ e.pole }}`.
 * Ładunek, który nie jest obiektem, zostaje bez zmian - nie ma do czego dopisać.
 */
function withEnriched(payload: unknown, as: string, value: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return { ...payload, [as]: value };
}

/** Przycięcie do `maxParts` części tym samym licznikiem, którym API dzieli wiadomości. */
export function fitToParts(text: string, maxParts: number): { text: string; parts: number; over: boolean } {
  const fits = (candidate: string): number | null => {
    try {
      return segmentText(candidate, measureText(candidate, 'auto'), maxParts).parts;
    } catch (e) {
      if (e instanceof TooManyPartsError) return null;
      throw e;
    }
  };
  const whole = fits(text);
  if (whole !== null) return { text, parts: whole, over: false };
  // Ucinamy po znakach, aż zmieści się w limicie; wielokropek liczy się jak znak.
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(`${chars.slice(0, mid).join('')}…`) !== null) lo = mid;
    else hi = mid - 1;
  }
  const cut = `${chars.slice(0, lo).join('')}…`;
  return { text: cut, parts: fits(cut) ?? maxParts, over: true };
}

/** Podgląd do „Sprawdź szablon” - bez zapisu, bez wysyłki, bez strażników. */
export function previewInbound(engine: TemplateEngine, config: InboundConfig, payload: unknown, countryCode: string, now: Date): InboundPreview {
  const context = buildInboundContext(payload, { name: 'podgląd' }, now);
  try {
    const ok = matches(config.condition, context, engine);
    const raw = rawRecipients(config, payload, null).list;
    // Podgląd nie sięga do bazy odebranych - mówi tylko, że odbiorca wyjdzie z wątku.
    const threadRecipient = raw.length === 0 && ticketRef(config, payload) !== null;
    const recipients = raw.map((r) => {
      try {
        return normalizeRecipient(r, countryCode);
      } catch {
        return `${r} (nieprawidłowy)`;
      }
    });
    const rendered = renderInboundText(engine, config, context);
    const fitted = rendered === '' ? { text: '', parts: 0 } : fitToParts(rendered, config.overflow === 'truncate' ? config.maxParts : 9);
    return { matches: ok, recipients, text: fitted.text, parts: fitted.parts, error: rendered === '' ? 'Szablon dał pustą treść.' : null, threadRecipient };
  } catch (e) {
    return { matches: false, recipients: [], text: '', parts: 0, error: e instanceof Error ? e.message : String(e), threadRecipient: false };
  }
}

/**
 * Potok przychodzący: klucz i konto, filtr, idempotencja, burza, dopytanie, szablony, wysyłka przez
 * `submitMessages`, wpis w dzienniku. Każde wyjście zapisuje wpis; wołający zamienia wynik
 * na kod HTTP i ewentualne powiadomienie administratora.
 */
export async function runInbound(deps: PipelineDeps, integration: InboundIntegration, payload: unknown, meta: { sourceIp: string }, now: Date): Promise<InboundOutcome> {
  const log = deps.log ?? silentLogger;
  const config = integration.config;
  const stored = integration.storePayloads === 1 ? JSON.stringify(payload) : null;
  const note = (result: IntegrationEventInput['result'], extra: Partial<IntegrationEventInput> = {}) =>
    deps.integrationEvents.record({ integrationId: integration.id, at: now, result, sourceIp: meta.sourceIp, payload: stored, logLimit: config.eventLogLimit, ...extra });
  const fail = (code: InboundErrorCode, detail: string): InboundOutcome => {
    note('error', { reason: detail });
    log.warn('integracja.blad', { integrationId: integration.id, code });
    return { kind: 'error', code, detail };
  };
  const unavailable = (detail: string): InboundOutcome => {
    note('error', { reason: detail });
    log.warn('integracja.niedostepna', { integrationId: integration.id });
    return { kind: 'unavailable', detail };
  };

  const key = deps.apiKeys.get(integration.apiKeyId);
  if (!key) return unavailable('klucz API nie istnieje');
  const usable = keyUsable(key, now);
  if (!usable.ok) return unavailable(usable.reason);
  const account = deps.accounts.get(key.accountId);
  if (!account) return unavailable('konto nie istnieje');
  if (account.pausedReason !== null) return unavailable(`konto wstrzymane: ${account.pausedReason}`);

  // Odebrany SMS, do którego pasuje identyfikator zgłoszenia z ładunku (tylko z integracji tego klucza).
  const ref = ticketRef(config, payload);
  const original = ref === null ? undefined : deps.inbound.findByExternalRefForKey(integration.apiKeyId, ref);

  const context = buildInboundContext(payload, integration, now);
  let text: string;
  let recipients: { list: string[]; fromPayload: boolean };
  try {
    if (!matches(config.condition, context, deps.engine)) {
      note('skipped', { reason: 'warunek niespełniony' });
      return { kind: 'skipped' };
    }
    if (config.eventIdPath !== undefined) {
      const eventId = readPath(payload, config.eventIdPath);
      if (eventId !== undefined && eventId !== null && String(eventId) !== '' && !deps.guards.dedup(integration.id, String(eventId), now)) {
        note('duplicate', { reason: `identyfikator zdarzenia ${String(eventId)}` });
        return { kind: 'duplicate' };
      }
    }
    const gate = deps.guards.throttle(integration.id, config.throttle.limit, config.throttle.windowMinutes, now);
    if (!gate.allowed) {
      note('throttled', { reason: `ponad ${config.throttle.limit} w ${config.throttle.windowMinutes} min` });
      return { kind: 'throttled', notify: gate.notify };
    }
    // Dopytanie dopiero tutaj: odsiane, zduplikowane oraz zdławione zdarzenie nie zajmuje aplikacji.
    if (config.enrich) {
      const wynik = await enrich({
        config: config.enrich, secrets: deps.integrations.secrets(integration.id), context, engine: deps.engine,
        ...(deps.resolve ? { resolve: deps.resolve } : {}),
        ...(deps.enrichGet ? { get: deps.enrichGet } : {}),
        ...(deps.allowPrivateWebhooks ? { allowPrivate: true } : {}),
      });
      if (!wynik.ok) {
        // Adres bez części zapytania: tam siedzi token do aplikacji.
        const opis = `dopytanie ${safeUrl(config.enrich.url)}: ${wynik.reason}`;
        if (config.enrich.onError === 'skip') {
          note('skipped', { reason: opis });
          return { kind: 'skipped' };
        }
        return fail('enrich', opis);
      }
      context[config.enrich.as] = wynik.value;
      context.p = withEnriched(payload, config.enrich.as, wynik.value);
    }
    text = renderInboundText(deps.engine, config, context);
    recipients = rawRecipients(config, context.p, original?.sender ?? null);
  } catch (e) {
    if (e instanceof TemplateError) return fail('template', e.message);
    if (e instanceof TooManyRecipientsError) return fail('too_many_recipients', e.message);
    throw e;
  }
  if (text === '') return fail('empty_text', 'Szablon dał pustą treść - sprawdź, czy ładunek ma oczekiwane pola.');
  if (recipients.list.length === 0) {
    return fail('no_recipient', ref !== null
      ? `Brak numeru odbiorcy w ładunku, zgłoszenie ${ref} nie pasuje do żadnego odebranego SMS-a, a lista zapasowa jest pusta.`
      : 'Brak numeru odbiorcy w ładunku i pusta lista zapasowa.');
  }

  let normalized: string[];
  try {
    normalized = recipients.list.map((r) => normalizeRecipient(r, account.defaultCountryCode));
  } catch (e) {
    if (e instanceof InvalidPhoneError) {
      // Ustawienie „pomiń” dotyczy wyłącznie numeru z ładunku. Numer z listy zapasowej wpisuje
      // administrator, więc jego błąd zostaje błędem, inaczej pomyłka w formularzu zapadłaby w ciszę.
      if (config.invalidRecipient === 'skip' && recipients.fromPayload) {
        note('skipped', { reason: 'numer odbiorcy w ładunku nie do odczytania' });
        return { kind: 'skipped', reason: 'invalid_recipient' };
      }
      return fail('invalid_phone', e.message);
    }
    throw e;
  }

  const fitted = fitToParts(text, config.maxParts);
  if (fitted.over && config.overflow === 'reject') return fail('too_many_parts', `Treść wymaga więcej niż ${config.maxParts} części.`);

  // Odpowiedź w wątku: zgłoszenie pasuje do odebranej, a jedyny odbiorca to jej nadawca.
  const inReplyTo = original && normalized.length === 1 && original.sender === normalized[0] ? original.id : undefined;

  try {
    const results = submitMessages(deps, authFromKey(key), {
      to: normalized, text: fitted.text, integrationId: integration.id, maxParts: config.maxParts,
      ...(integration.serviceId ? { serviceId: integration.serviceId } : {}),
      ...(integration.orig ? { orig: integration.orig } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
    }, now);
    const messageIds = results.map((r) => r.id);
    note('sent', {
      ...(messageIds[0] ? { messageId: messageIds[0] } : {}),
      ...(inReplyTo ? { inboundId: inReplyTo } : {}),
      ...(messageIds.length > 1 ? { reason: `${messageIds.length} odbiorców` } : {}),
    });
    return { kind: 'sent', messageIds };
  } catch (e) {
    if (e instanceof ApiError) {
      const code: InboundErrorCode = e.code === 'invalid_phone' ? 'invalid_phone' : e.code === 'too_many_parts' ? 'too_many_parts' : 'service';
      return fail(code, e.message);
    }
    throw e;
  }
}
