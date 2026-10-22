import { ApiError } from '../api/errors.ts';
import { authFromKey, keyUsable, submitMessages, type SubmitDeps } from '../api/submit.ts';
import { silentLogger, type Logger } from '../log.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { IntegrationEventInput, IntegrationEventsRepo } from '../store/integration-events.ts';
import type { IntegrationGuardsRepo } from '../store/integration-guards.ts';
import type { IntegrationRow, IntegrationsRepo } from '../store/integrations.ts';
import { measureText } from '../text/measure.ts';
import { InvalidPhoneError, MAX_RECIPIENTS_PER_HOOK, normalizeRecipient, splitRecipients, TooManyRecipientsError } from '../text/phone.ts';
import { segmentText, TooManyPartsError } from '../text/segment.ts';
import type { InboundConfig, MailInConfig } from './config.ts';
import { matches } from './conditions.ts';
import { authResultsPass, domainOf } from './mail/auth-results.ts';
import { cleanText } from './mail/clean.ts';
import { FieldError, extractFields } from './mail/fields.ts';
import type { ParsedMail } from './mail/parse.ts';
import { pullRecipients } from './mail/recipients.ts';
import { matchSender } from './mail/senders.ts';
import { enrich, safeUrl, type EnrichGet } from './enrich.ts';
import { maskPath, readPath } from './paths.ts';
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
  | { kind: 'skipped'; reason?: 'invalid_recipient' | 'enrich' }
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

/**
 * Podgląd do „Sprawdź szablon” - bez zapisu, bez wysyłki, bez strażników. Podgląd nie pyta
 * aplikacji po sieci: gdy ustawienie ma zapytanie uzupełniające, podstawia jego przykładową
 * odpowiedź, tak samo jak zrobiłby to potok z prawdziwą.
 */
export function previewInbound(
  engine: TemplateEngine, config: InboundConfig, payload: unknown, countryCode: string, now: Date, enrichSample?: unknown,
): InboundPreview {
  const context = buildInboundContext(payload, { name: 'podgląd' }, now);
  if (config.enrich && enrichSample !== undefined) {
    context[config.enrich.as] = enrichSample;
    context.p = withEnriched(payload, config.enrich.as, enrichSample);
  }
  try {
    const ok = matches(config.condition, context, engine);
    const raw = rawRecipients(config, context.p, null).list;
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

import type { AccountRow } from '../store/accounts.ts';
import type { ApiKeyRow } from '../store/api-keys.ts';

/** Zapis wpisu dziennika integracji dla bieżącego zdarzenia; każdy potok składa go po swojemu. */
export type Noter = (result: IntegrationEventInput['result'], extra?: Partial<IntegrationEventInput>) => void;

/** Klucz i konto integracji; powody niedostępności słowami, do wpisu dziennika. */
export function resolveKeyAccount(deps: PipelineDeps, integration: IntegrationRow, now: Date):
  { ok: true; key: ApiKeyRow; account: AccountRow } | { ok: false; detail: string } {
  const key = deps.apiKeys.get(integration.apiKeyId);
  if (!key) return { ok: false, detail: 'klucz API nie istnieje' };
  const usable = keyUsable(key, now);
  if (!usable.ok) return { ok: false, detail: usable.reason };
  const account = deps.accounts.get(key.accountId);
  if (!account) return { ok: false, detail: 'konto nie istnieje' };
  if (account.pausedReason !== null) return { ok: false, detail: `konto wstrzymane: ${account.pausedReason}` };
  return { ok: true, key, account };
}

/**
 * Filtr warunku oraz ochrona przed burzą, z wpisami dziennika. `between` to krok między nimi
 * (webhook sprawdza tam idempotencję): wynik inny niż null kończy potok.
 */
export function passGuards(
  deps: PipelineDeps, integration: IntegrationRow, config: { condition: InboundConfig['condition']; throttle: InboundConfig['throttle'] },
  context: Record<string, unknown>, note: Noter, between: (() => { kind: 'duplicate' } | null) | undefined, now: Date,
): { kind: 'ok' } | { kind: 'skipped' } | { kind: 'duplicate' } | { kind: 'throttled'; notify: boolean } {
  if (!matches(config.condition, context, deps.engine)) {
    note('skipped', { reason: 'warunek niespełniony' });
    return { kind: 'skipped' };
  }
  const stop = between?.();
  if (stop) return stop;
  const gate = deps.guards.throttle(integration.id, config.throttle.limit, config.throttle.windowMinutes, now);
  if (!gate.allowed) {
    note('throttled', { reason: `ponad ${config.throttle.limit} w ${config.throttle.windowMinutes} min` });
    return { kind: 'throttled', notify: gate.notify };
  }
  return { kind: 'ok' };
}

/** Limit części, wysyłka przez `submitMessages`, wpis `sent` albo `error`. */
export function dispatch(
  deps: PipelineDeps, integration: IntegrationRow, key: ApiKeyRow, text: string, recipients: string[],
  config: { maxParts: number; overflow: 'truncate' | 'reject' }, note: Noter, now: Date,
  extra: { inReplyTo?: string; sentReason?: string } = {},
): { kind: 'sent'; messageIds: string[]; parts: number; text: string } | { kind: 'error'; code: InboundErrorCode; detail: string } {
  const fitted = fitToParts(text, config.maxParts);
  if (fitted.over && config.overflow === 'reject') {
    const detail = `Treść wymaga więcej niż ${config.maxParts} części.`;
    note('error', { reason: detail });
    return { kind: 'error', code: 'too_many_parts', detail };
  }
  try {
    const results = submitMessages(deps, authFromKey(key), {
      to: recipients, text: fitted.text, integrationId: integration.id, maxParts: config.maxParts,
      ...(integration.serviceId ? { serviceId: integration.serviceId } : {}),
      ...(integration.orig ? { orig: integration.orig } : {}),
      ...(extra.inReplyTo ? { inReplyTo: extra.inReplyTo } : {}),
    }, now);
    const messageIds = results.map((r) => r.id);
    const reason = [messageIds.length > 1 ? `${messageIds.length} odbiorców` : null, extra.sentReason ?? null].filter((r) => r !== null).join('; ');
    note('sent', {
      ...(messageIds[0] ? { messageId: messageIds[0] } : {}),
      ...(extra.inReplyTo ? { inboundId: extra.inReplyTo } : {}),
      ...(reason !== '' ? { reason } : {}),
    });
    return { kind: 'sent', messageIds, parts: fitted.parts, text: fitted.text };
  } catch (e) {
    if (e instanceof ApiError) {
      const code: InboundErrorCode = e.code === 'invalid_phone' ? 'invalid_phone' : e.code === 'too_many_parts' ? 'too_many_parts' : 'service';
      note('error', { reason: e.message });
      return { kind: 'error', code, detail: e.message };
    }
    throw e;
  }
}

/**
 * Potok przychodzący: klucz i konto, filtr, idempotencja, burza, dopytanie, szablony, wysyłka przez
 * `submitMessages`, wpis w dzienniku. Każde wyjście zapisuje wpis; wołający zamienia wynik
 * na kod HTTP i ewentualne powiadomienie administratora.
 */
export async function runInbound(deps: PipelineDeps, integration: InboundIntegration, raw: unknown, meta: { sourceIp: string }, now: Date): Promise<InboundOutcome> {
  const log = deps.log ?? silentLogger;
  const config = integration.config;
  // Sekret z pola ładunku dalej nie jedzie: uwierzytelnienie już go sprawdziło w warstwie HTTP, a
  // ładunek stąd trafia do dziennika zdarzeń, do podglądu w panelu oraz do kontekstu szablonu.
  const payload = config.auth.payload === undefined ? raw : maskPath(raw, config.auth.payload.path);
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

  const resolved = resolveKeyAccount(deps, integration, now);
  if (!resolved.ok) return unavailable(resolved.detail);
  const { key, account } = resolved;

  // Odebrany SMS, do którego pasuje identyfikator zgłoszenia z ładunku (tylko z integracji tego klucza).
  const ref = ticketRef(config, payload);
  const original = ref === null ? undefined : deps.inbound.findByExternalRefForKey(integration.apiKeyId, ref);

  const context = buildInboundContext(payload, integration, now);
  /** Klucz zajęty przez dedup w tym przebiegu; zdejmujemy go, gdy prosimy aplikację o ponowienie. */
  let dedupKey: string | null = null;
  let text: string;
  let recipients: { list: string[]; fromPayload: boolean };
  try {
    const dedup = (): { kind: 'duplicate' } | null => {
      if (config.eventIdPath === undefined) return null;
      const eventId = readPath(payload, config.eventIdPath);
      if (eventId === undefined || eventId === null || String(eventId) === '') return null;
      if (!deps.guards.dedup(integration.id, String(eventId), now)) {
        note('duplicate', { reason: `identyfikator zdarzenia ${String(eventId)}` });
        return { kind: 'duplicate' };
      }
      dedupKey = String(eventId);
      return null;
    };
    const guard = passGuards(deps, integration, config, context, note, dedup, now);
    if (guard.kind !== 'ok') return guard;
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
          // Powód w odpowiedzi mówi aplikacji, że to nie warunek ją odsiał, tylko nieudane dopytanie.
          // Żeton dedupu zostaje zużyty: aplikacja dostaje 200, więc ponowienia nie będzie.
          return { kind: 'skipped', reason: 'enrich' };
        }
        // Odpowiadamy 422, czyli prosimy o ponowienie, więc żeton dedupu musi wrócić. Niedostępna
        // aplikacja to błąd przejściowy, inaczej niż błąd szablonu albo zły numer.
        if (dedupKey !== null) deps.guards.releaseDedup(integration.id, dedupKey);
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
    // Kartoteka klienta bywa bez komórki, a to dana z aplikacji, nie pomyłka administratora.
    // Dlatego przy numerze spod dopytania przełącznik „pomiń” obejmuje także brak numeru.
    const zDopytania = config.enrich !== undefined && config.to.path?.startsWith(`${config.enrich.as}.`) === true;
    if (zDopytania && config.invalidRecipient === 'skip') {
      note('skipped', { reason: 'odpowiedź dopytania nie ma numeru odbiorcy' });
      return { kind: 'skipped', reason: 'invalid_recipient' };
    }
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

  // Odpowiedź w wątku: zgłoszenie pasuje do odebranej, a jedyny odbiorca to jej nadawca.
  const inReplyTo = original && normalized.length === 1 && original.sender === normalized[0] ? original.id : undefined;

  const sent = dispatch(deps, integration, key, text, normalized, config, note, now, inReplyTo ? { inReplyTo } : {});
  if (sent.kind === 'error') {
    log.warn('integracja.blad', { integrationId: integration.id, code: sent.code });
    return sent;
  }
  return { kind: 'sent', messageIds: sent.messageIds };
}

// ---------------------------------------------------------------------------------------------
// Skrzynka pocztowa: ten sam potok co webhook, z własnym kontekstem i własnym wyznaczaniem numerów.
// ---------------------------------------------------------------------------------------------

export type MailInIntegration = IntegrationRow & { config: MailInConfig };
export type MailInSkipReason = 'sender_not_allowed' | 'auth_failed' | 'condition';
export type MailInOutcome =
  | { kind: 'sent'; messageIds: string[]; recipients: string[]; invalid: string[]; parts: number; text: string }
  | { kind: 'skipped'; reason: MailInSkipReason }
  | { kind: 'throttled'; notify: boolean }
  | { kind: 'error'; code: InboundErrorCode; detail: string }
  | { kind: 'unavailable'; detail: string };

export type RecipientsLevel = 'mail' | 'sender' | 'fallback' | 'none';

export interface MailInPreview {
  senderAllowed: boolean; recipients: string[]; recipientsLevel: RecipientsLevel; invalid: string[];
  fields: Record<string, string>; cleaned: string; text: string; parts: number; error: string | null;
}

/** Kontekst z sekcji 8.4 specu: pola maila po angielsku, do tego `now`, `integration.name` i cały kontekst pod `p`. */
export function buildMailContext(mail: ParsedMail, subject: string, text: string, fields: Record<string, string>, integration: { name: string }, now: Date): Record<string, unknown> {
  const p: Record<string, unknown> = {
    from: mail.from, from_name: mail.fromName, subject, text, text_full: mail.textFull, date: mail.date,
    to: mail.to, message_id: mail.messageId ?? '', fields: { ...fields },
  };
  return { ...p, now: now.toISOString(), integration: { name: integration.name }, p };
}

export function renderMailText(engine: TemplateEngine, config: MailInConfig, context: Record<string, unknown>): string {
  if (config.text.mode === 'liquid') return engine.render(config.text.template, context).trim();
  const subject = String(context.subject ?? '').trim();
  const text = String(context.text ?? '').trim();
  if (config.text.variant === 'subject') return subject;
  if (config.text.variant === 'text') return text;
  return [subject, text].filter((part) => part !== '').join('\n');
}

/**
 * Treść i odbiorcy maila przed strażnikami i wysyłką: czyszczenie, numery z maila, wycinki,
 * kontekst, trzy poziomy odbiorców. Wspólne dla potoku i podglądu, żeby podgląd pokazywał to,
 * co naprawdę pójdzie.
 */
function prepareMail(engine: TemplateEngine, config: MailInConfig, mail: ParsedMail, sender: { recipients: string[] } | null, countryCode: string, integration: { name: string }, now: Date): {
  context: Record<string, unknown>; cleaned: string; fields: Record<string, string>;
  level: RecipientsLevel; raw: string[]; recipients: string[]; invalid: string[]; render: () => string;
} {
  const cleaned = cleanText(mail.textFull, config.clean.cutFrom, mail.fromName);
  const pulled = config.recipientsFromMail.enabled ? pullRecipients(mail.subject, cleaned, config.recipientsFromMail.where) : { numbers: [], subject: mail.subject, text: cleaned };
  // Nadawca z listy może wskazać odbiorców, ale nie więcej, niż przyjmuje API w jednym żądaniu (spec 7.1: do 50).
  if (pulled.numbers.length > MAX_RECIPIENTS_PER_HOOK) throw new TooManyRecipientsError(pulled.numbers.length);
  const fields = extractFields(mail.textFull, config.fields);
  const context = buildMailContext(mail, pulled.subject, pulled.text, fields, integration, now);
  const level: RecipientsLevel = pulled.numbers.length > 0 ? 'mail' : (sender?.recipients.length ?? 0) > 0 ? 'sender' : config.to.fallback.length > 0 ? 'fallback' : 'none';
  const raw = level === 'mail' ? pulled.numbers : level === 'sender' ? sender!.recipients : level === 'fallback' ? config.to.fallback : [];
  const recipients: string[] = [];
  const invalid: string[] = [];
  for (const r of raw) {
    try {
      recipients.push(normalizeRecipient(r, countryCode));
    } catch (e) {
      if (!(e instanceof InvalidPhoneError)) throw e;
      invalid.push(r.trim());
    }
  }
  // Szablon liczy się dopiero po warunku i burzy (spec 3.2), żeby mail odrzucony warunkiem nie dawał błędu szablonu.
  return { context, cleaned, fields, level, raw, recipients: [...new Set(recipients)], invalid, render: () => renderMailText(engine, config, context) };
}

/**
 * Potok skrzynki według sekcji 3.2 specu, kroki 4-11: klucz i konto, nadawca, SPF/DKIM, treść,
 * warunek i burza, odbiorcy z trzech poziomów, wysyłka, wpis dziennika. Działanie na mailu
 * oraz odpowiedź do nadawcy robi wołający (poller), bo potok nie zna sesji IMAP.
 */
export async function runMailIn(deps: PipelineDeps, integration: MailInIntegration, mail: ParsedMail, now: Date): Promise<MailInOutcome> {
  const log = deps.log ?? silentLogger;
  const config = integration.config;
  const stored = integration.storePayloads === 1
    ? JSON.stringify({ from: mail.from, from_name: mail.fromName, subject: mail.subject, text_full: mail.textFull, date: mail.date, message_id: mail.messageId })
    : null;
  // Spec 4.5: podsumowanie wpisu to nadawca (w polu źródła) oraz temat ucięty do 80 znaków, dopisany po właściwym powodzie.
  const subject = mail.subject.trim() === '' ? 'temat (bez tematu)' : `temat „${mail.subject.trim().slice(0, 80)}”`;
  const note: Noter = (result, extra = {}) =>
    deps.integrationEvents.record({
      integrationId: integration.id, at: now, result, payload: stored, logLimit: config.eventLogLimit, ...(mail.from ? { sourceIp: mail.from } : {}), ...extra,
      reason: [extra.reason, subject].filter((r) => r !== undefined && r !== '').join(' · '),
    });
  const fail = (code: InboundErrorCode, detail: string): MailInOutcome => {
    note('error', { reason: detail });
    log.warn('integracja.blad', { integrationId: integration.id, code });
    return { kind: 'error', code, detail };
  };

  const resolved = resolveKeyAccount(deps, integration, now);
  if (!resolved.ok) {
    note('error', { reason: resolved.detail });
    log.warn('integracja.niedostepna', { integrationId: integration.id });
    return { kind: 'unavailable', detail: resolved.detail };
  }
  const { key, account } = resolved;

  const sender = matchSender(mail.from, config.senders);
  if (sender === null) {
    note('skipped', { reason: `nadawca spoza listy: ${mail.from || 'brak adresu'}` });
    return { kind: 'skipped', reason: 'sender_not_allowed' };
  }
  if (config.requireAuthResults && !authResultsPass(mail.authResults, domainOf(mail.from))) {
    note('skipped', { reason: 'brak potwierdzenia SPF/DKIM od serwera' });
    return { kind: 'skipped', reason: 'auth_failed' };
  }

  let prepared: ReturnType<typeof prepareMail>;
  try {
    prepared = prepareMail(deps.engine, config, mail, sender, account.defaultCountryCode, integration, now);
  } catch (e) {
    if (e instanceof FieldError || e instanceof TemplateError) return fail('template', e.message);
    if (e instanceof TooManyRecipientsError) return fail('too_many_recipients', e.message);
    throw e;
  }

  const guard = passGuards(deps, integration, config, prepared.context, note, undefined, now);
  if (guard.kind === 'skipped') return { kind: 'skipped', reason: 'condition' };
  if (guard.kind === 'throttled') return guard;

  if (prepared.level === 'none') return fail('no_recipient', 'Brak numeru odbiorcy: wiadomość go nie zawiera, nadawca nie ma przypisanych numerów, a stała lista jest pusta.');
  if (prepared.recipients.length === 0) {
    return fail('invalid_phone', prepared.level === 'mail'
      ? `Wszystkie numery podane w wiadomości są nieprawidłowe: ${prepared.invalid.join(', ')}.`
      : `Numer odbiorcy jest nieprawidłowy: ${prepared.invalid.join(', ')}.`);
  }
  // Na poziomie nadawcy i stałej listy numer wpisał administrator: pomyłka nie może zapaść w ciszę.
  if (prepared.level !== 'mail' && prepared.invalid.length > 0) return fail('invalid_phone', `Numer odbiorcy jest nieprawidłowy: ${prepared.invalid.join(', ')}.`);
  let text: string;
  try {
    text = prepared.render();
  } catch (e) {
    if (e instanceof TemplateError) return fail('template', e.message);
    throw e;
  }
  if (text === '') return fail('empty_text', 'Treść SMS-a jest pusta: wiadomość po usunięciu podpisu i cytatów nie zawiera treści.');

  const sentReason = prepared.invalid.length > 0 ? `pominięto nieprawidłowe numery: ${prepared.invalid.join(', ')}` : undefined;
  const sent = dispatch(deps, integration, key, text, prepared.recipients, config, note, now, sentReason ? { sentReason } : {});
  if (sent.kind === 'error') {
    log.warn('integracja.blad', { integrationId: integration.id, code: sent.code });
    return sent;
  }
  return { kind: 'sent', messageIds: sent.messageIds, recipients: prepared.recipients, invalid: prepared.invalid, parts: sent.parts, text: sent.text };
}

/** Podgląd do „Sprawdź szablon” dla skrzynki: nic nie wysyła, nic nie zapisuje. */
export function previewMailIn(engine: TemplateEngine, config: MailInConfig, mail: ParsedMail, countryCode: string, now: Date): MailInPreview {
  const sender = matchSender(mail.from, config.senders);
  try {
    const p = prepareMail(engine, config, mail, sender, countryCode, { name: 'podgląd' }, now);
    const text = p.render();
    const fitted = text === '' ? { text: '', parts: 0 } : fitToParts(text, config.overflow === 'truncate' ? config.maxParts : 9);
    return {
      senderAllowed: sender !== null, recipients: p.recipients, recipientsLevel: p.level, invalid: p.invalid, fields: p.fields, cleaned: p.cleaned,
      text: fitted.text, parts: fitted.parts, error: text === '' ? 'Treść SMS-a jest pusta.' : null,
    };
  } catch (e) {
    return { senderAllowed: sender !== null, recipients: [], recipientsLevel: 'none', invalid: [], fields: {}, cleaned: '', text: '', parts: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
