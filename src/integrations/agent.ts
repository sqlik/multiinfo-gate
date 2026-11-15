import { timingSafeEqual } from 'node:crypto';
import { generateSecret, hashSecret } from '../agents/codes.ts';
import type { ConnectionContext, ConnectionService } from '../agents/connections.ts';
import { SCOPE_LABELS } from '../agents/scopes.ts';
import { ApiError } from '../api/errors.ts';
import { MESSAGE_RECIPIENTS_MAX } from '../api/messages.ts';
import { keyOrigs, resolveOrig } from '../api/orig.ts';
import { PACKAGE_RECIPIENTS_MAX } from '../api/packages.ts';
import type { ApiDeps } from '../api/server.ts';
import { packageEncoding, submitPackage } from '../api/submit-package.ts';
import { submitMessages } from '../api/submit.ts';
import { findLinks } from '../links/detect.ts';
import { fitPrepared, onceSettings, prepareLinks, type LinkRequest, type PreparedText } from '../links/shortener.ts';
import type { AgentDraftsRepo } from '../store/agent-drafts.ts';
import type { LinkMode } from '../store/api-keys.ts';
import type { IntegrationEventInput } from '../store/integration-events.ts';
import { measureText, type EncodingRequest } from '../text/measure.ts';
import { InvalidPhoneError, normalizePhone, normalizeRecipient } from '../text/phone.ts';
import { segmentText } from '../text/segment.ts';
import type { AgentScope } from './config.ts';
import type { PipelineDeps } from './pipeline.ts';
import { payloadForLog } from './power-automate.ts';

/**
 * Błąd potoku agenta z komunikatem dla człowieka. Narzędzie MCP zamienia go na błąd narzędzia, a przy limicie
 * dopisuje czas do ponowienia.
 */
export class AgentError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterSec?: number) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * Zależności potoku: wspólna droga wysyłki, rozsyłki, dziennik i powiadomienia, szkice oraz rozstrzyganie
 * połączenia. Wysyłka szkicu sprawdza połączenie ponownie, ponieważ widok mógł powstać przed zmianą uprawnień.
 */
export type AgentDeps = PipelineDeps & Pick<ApiDeps, 'packages' | 'log' | 'notifier'> & {
  drafts: AgentDraftsRepo;
  connections: Pick<ConnectionService, 'resolve'>;
};

export const DRAFT_TTL_MS = 30 * 60_000;
/** Najwięcej odpowiedzi przygotowanych w jednym wywołaniu. */
export const REPLIES_MAX = 50;
/** Przedrostek klucza potwierdzenia; bramka zapisuje wyłącznie skrót. */
const CONFIRM_PREFIX = 'mig_cf_';
const MIN = 60_000;

export interface SenderOption { value: string | null; label: string }
export interface ServiceOption { id: string; label: string }
export interface GuardLeft { calls: number; recipients: number; resetsAt: string | null }

export interface PrepareSmsInput {
  to?: string[];
  campaignRecipients?: { campaign: string; segment: 'unopened' | 'opened' };
  text: string;
  serviceId?: string;
  orig?: string | null;
  encoding?: EncodingRequest;
  links?: LinkRequest;
}

export interface SmsPreview {
  draftId: string; expiresAt: string; recipients: number; duplicatesRemoved: number; route: 'messages' | 'package';
  text: string; parts: number; characters: number; encoding: 'gsm' | 'ucs2'; truncated: boolean;
  serviceId: string; services: ServiceOption[]; orig: string | null; senders: SenderOption[];
  links: { shortened: number; domain: string | null; domains: string[]; campaign: string | null; utm: boolean; mode: LinkMode; notice: string | null } | null;
  guard: GuardLeft;
}

export interface ReplyItem { inboundId: string; group: string; text: string }
export interface ReplyDraft { draftId: string; inboundId: string; to: string; group: string; text: string; parts: number; characters: number; expiresAt: string }

export type SendOutcome = { kind: 'messages'; ids: string[]; repeated: boolean } | { kind: 'package'; id: string; recipients: number; repeated: boolean };

/** Wynik przygotowania: klucz potwierdzenia trafia wyłącznie do `_meta` wyniku narzędzia, nigdy do podglądu. */
export interface Prepared<T> { confirm: string | null; preview: T }

/** Szkic SMS-a: odbiorcy po normalizacji, treść przed skróceniem i wszystko, czego wymaga wysyłka. */
interface SmsDraftPayload {
  route: 'messages' | 'package'; to: string[]; text: string; links: LinkRequest; serviceId: string; orig: string | null; encoding: EncodingRequest;
}
interface ReplyDraftPayload { inboundId: string; to: string; group: string; text: string; serviceId: string; orig: string | null }
type StoredOutcome = { kind: 'messages'; ids: string[] } | { kind: 'package'; id: string; recipients: number };

const recipientsWord = (n: number): string => `${n} ${n === 1 ? 'odbiorca' : 'odbiorców'}`;
const serviceLabel = (s: ServiceOption): string => (s.label === s.id ? s.id : `${s.label} (${s.id})`);

/**
 * Usługi klucza z nazwami z konta oraz nadawcy z `keyOrigs`. Wartością domyślną nadawcy jest nadpis integracji,
 * potem klucza, potem konta. Numer usługi jest pozycją listy tylko wtedy, gdy żaden z nich nie istnieje.
 */
export function senderOptions(deps: AgentDeps, ctx: ConnectionContext): { senders: SenderOption[]; orig: string | null; services: ServiceOption[]; serviceId: string } {
  const labels = new Map(deps.accounts.services(ctx.account.id).map((s) => [s.id, s.label]));
  const services = ctx.auth.allowedServiceIds.map((id) => ({ id, label: labels.get(id) ?? id }));
  const serviceId = ctx.integration.serviceId ?? ctx.auth.defaultServiceId ?? services[0]?.id ?? '';
  const { allowed, fallback } = keyOrigs(ctx.auth, ctx.account, deps.accounts);
  const orig = ctx.integration.orig ?? fallback;
  const values = new Set(allowed);
  if (ctx.integration.orig) values.add(ctx.integration.orig);
  const senders: SenderOption[] = [...values].sort().map((value) => ({ value, label: value }));
  if (orig === null) {
    const service = services.find((s) => s.id === serviceId) ?? { id: serviceId, label: serviceId };
    senders.unshift({ value: null, label: `numer usługi ${serviceLabel(service)}` });
  }
  return { senders, orig, services, serviceId };
}

/** Ile wysyłek i odbiorców zostało w bieżącym oknie ochrony przed burzą integracji agenta. */
export function guardLeft(deps: AgentDeps, ctx: ConnectionContext, now: Date): GuardLeft {
  const { limit, windowMinutes, recipients } = ctx.integration.config.throttle;
  const window = deps.guards.peek(ctx.integration.id, windowMinutes, now);
  return {
    calls: Math.max(0, limit - window.count), recipients: Math.max(0, recipients - window.recipients),
    resetsAt: window.windowStart === null ? null : new Date(Date.parse(window.windowStart) + windowMinutes * MIN).toISOString(),
  };
}

/** Sekundy do końca okna ochrony, najmniej jedna. */
const secondsUntil = (iso: string, now: Date): number => Math.max(1, Math.ceil((Date.parse(iso) - now.getTime()) / 1000));

/** Odmowa ochrony przed burzą dla `n` odbiorców: według limitu wywołań albo odbiorców, z czasem do końca okna. */
function throttledError(ctx: ConnectionContext, by: 'calls' | 'recipients', n: number, resetsAt: string | null, now: Date): AgentError {
  const { limit, windowMinutes, recipients } = ctx.integration.config.throttle;
  const name = ctx.integration.name;
  if (by === 'calls') {
    return new AgentError('throttled', `Integracja ${name} wykorzystała limit ${limit} wysyłek na ${windowMinutes} min.`,
      resetsAt === null ? undefined : secondsUntil(resetsAt, now));
  }
  // Wysyłka większa niż cały limit odbiorców nie zmieści się w żadnym oknie, dlatego bez czasu ponowienia.
  if (n > recipients) {
    return new AgentError('throttled',
      `Wysyłka do ${recipientsWord(n)} przekracza limit integracji ${name}, który wynosi ${recipients} odbiorców na ${windowMinutes} min. Limit zmienia administrator bramki.`);
  }
  return new AgentError('throttled', `Wysyłka do ${recipientsWord(n)} przekroczyłaby limit integracji ${name}, który wynosi ${recipients} odbiorców na ${windowMinutes} min.`,
    resetsAt === null ? undefined : secondsUntil(resetsAt, now));
}

/** Szkic, który przekroczyłby okno ochrony, odpada już przy przygotowaniu. */
function checkWindow(deps: AgentDeps, ctx: ConnectionContext, n: number, now: Date): GuardLeft {
  const left = guardLeft(deps, ctx, now);
  if (left.calls < 1) throw throttledError(ctx, 'calls', n, left.resetsAt, now);
  if (left.recipients < n) throw throttledError(ctx, 'recipients', n, left.resetsAt, now);
  return left;
}

/** Limit części wysyłki agenta: limit integracji, ale nigdy więcej niż limit klucza. */
const partsLimit = (ctx: ConnectionContext): number => Math.min(ctx.integration.config.maxParts, ctx.key.maxParts);

interface Shaped { template: PreparedText; prepared: PreparedText; parts: number; characters: number; encoding: 'gsm' | 'ucs2'; truncated: boolean }

/**
 * Treść tak, jak ją wyśle bramka: skracanie linków według klucza, kodowanie (rozsyłka ma jedno kodowanie),
 * limit części z zachowaniem integracji przy nadmiarze. Rzuca `ApiError` skracacza i `AgentError` limitu części.
 */
function shape(deps: AgentDeps, ctx: ConnectionContext, text: string, links: LinkRequest, encoding: EncodingRequest, route: 'messages' | 'package'): Shaped {
  if (text.trim() === '') throw new AgentError('empty_text', 'Treść SMS-a jest pusta.');
  const template = prepareLinks(onceSettings(deps), ctx.key.id, text, links, {});
  const enc: EncodingRequest = route === 'package' ? packageEncoding([template.text], encoding) : encoding;
  const limit = partsLimit(ctx);
  const fitted = fitPrepared(template, limit, enc);
  if (fitted.over && ctx.integration.config.overflow === 'reject') {
    const needed = segmentText(template.text, measureText(template.text, enc), Number.MAX_SAFE_INTEGER).parts;
    const whose = limit === ctx.integration.config.maxParts ? 'integracji' : 'klucza API';
    throw new AgentError('too_many_parts', `Treść wymaga ${needed} części, a limit ${whose} wynosi ${limit}. Skróć treść.`);
  }
  const measured = measureText(fitted.prepared.text, enc);
  return { template, prepared: fitted.prepared, parts: fitted.parts, characters: measured.characters, encoding: measured.encoding, truncated: fitted.over };
}

function normalize(raw: string, countryCode: string): string {
  try {
    // Zapis z przedrostkiem 00 i z wiodącym zerem, jak w integracjach: agent przepisuje numery z arkuszy i CRM-ów.
    return normalizeRecipient(raw, countryCode);
  } catch (e) {
    if (e instanceof InvalidPhoneError) throw new AgentError('invalid_phone', `${e.message}.`);
    throw e;
  }
}

function checkService(ctx: ConnectionContext, serviceId: string): void {
  if (!ctx.auth.allowedServiceIds.includes(serviceId)) {
    throw new AgentError('service_not_allowed',
      `Klucz integracji nie ma dostępu do usługi ${serviceId}. Dostępne usługi: ${ctx.auth.allowedServiceIds.join(', ')}.`);
  }
}

/** Nadawca szkicu: pominięty to wartość domyślna, null to numer usługi, tekst to nadpis z listy klucza. */
function pickOrig(deps: AgentDeps, ctx: ConnectionContext, input: string | null | undefined, fallback: string | null): string | null {
  if (input === undefined) return fallback;
  if (input === null) {
    if (fallback !== null) {
      throw new AgentError('orig_not_allowed', `Wysyłka z numeru usługi nie jest dostępna, ponieważ integracja wysyła z nadpisem ${fallback}.`);
    }
    return null;
  }
  resolveOrig(input, ctx.auth, ctx.account, deps.accounts);
  return input;
}

const newConfirm = (apps: boolean | undefined) => (apps ? generateSecret(CONFIRM_PREFIX) : null);

/**
 * Przygotowanie SMS-a: sprawdza wszystko, co sprawdziłaby wysyłka, i zapisuje szkic ważny 30 minut. Niczego
 * nie wysyła. W sesji z widokami szkic otrzymuje jednorazowy klucz potwierdzenia.
 */
export function prepareSms(deps: AgentDeps, ctx: ConnectionContext, input: PrepareSmsInput, now: Date, opts: { apps?: boolean } = {}): Prepared<SmsPreview> {
  if (input.campaignRecipients !== undefined) {
    throw new AgentError('invalid', 'Wysyłka do odbiorców kampanii nie jest jeszcze dostępna. Podaj numery odbiorców.');
  }
  const raw = input.to ?? [];
  if (raw.length === 0) throw new AgentError('no_recipient', 'Podaj co najmniej jeden numer odbiorcy.');
  const to = [...new Set(raw.map((r) => normalize(r, ctx.account.defaultCountryCode)))];
  if (to.length > PACKAGE_RECIPIENTS_MAX) {
    throw new AgentError('too_many_recipients',
      `Wysyłka może objąć najwyżej ${PACKAGE_RECIPIENTS_MAX} odbiorców, a lista bez powtórzeń zawiera ${to.length} numerów.`);
  }
  const route = to.length <= MESSAGE_RECIPIENTS_MAX ? 'messages' : 'package';
  const options = senderOptions(deps, ctx);
  const serviceId = input.serviceId ?? options.serviceId;
  checkService(ctx, serviceId);
  const orig = pickOrig(deps, ctx, input.orig, options.orig);
  const encoding = input.encoding ?? 'auto';
  const links = input.links ?? {};
  const shaped = shape(deps, ctx, input.text, links, encoding, route);
  const guard = checkWindow(deps, ctx, to.length, now);

  const settings = deps.apiKeys.linkSettings(ctx.key.id);
  const domains = settings.domainIds.map((id) => deps.linkDomains.get(id)).filter((d) => d?.enabled === 1).map((d) => d!.domain);
  const info = shaped.template.info;
  const confirm = newConfirm(opts.apps);
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS);
  const payload: SmsDraftPayload = { route, to, text: input.text, links, serviceId, orig, encoding };
  const draftId = deps.drafts.insert({ connectionId: ctx.connection.id, kind: 'sms', payload, createdAt: now, expiresAt, confirmHash: confirm?.hash ?? null });
  return {
    confirm: confirm?.value ?? null,
    preview: {
      draftId, expiresAt: expiresAt.toISOString(), recipients: to.length, duplicatesRemoved: raw.length - to.length, route,
      text: shaped.prepared.text, parts: shaped.parts, characters: shaped.characters, encoding: shaped.encoding, truncated: shaped.truncated,
      serviceId, services: options.services, orig, senders: options.senders,
      links: findLinks(input.text).length === 0 ? null : {
        shortened: shaped.prepared.slots.length, domain: info?.domain ?? null, domains,
        campaign: info === null ? null : info.campaign ?? ctx.integration.name, utm: settings.utm, mode: settings.mode, notice: shaped.template.notice,
      },
      guard,
    },
  };
}

/**
 * Odpowiedzi na odebrane SMS-y: odbiorcą jest zawsze nadawca odebranego SMS-a, jeden szkic na pozycję.
 * Wszystkie pozycje przechodzą sprawdzenie, zanim powstanie którykolwiek szkic.
 */
export function prepareReplies(deps: AgentDeps, ctx: ConnectionContext, items: ReplyItem[], now: Date, opts: { apps?: boolean } = {}): { confirm: string | null; drafts: ReplyDraft[] } {
  if (items.length === 0 || items.length > REPLIES_MAX) {
    throw new AgentError('invalid', `Jedno wywołanie przygotowuje od 1 do ${REPLIES_MAX} odpowiedzi.`);
  }
  checkWindow(deps, ctx, 1, now);
  const orig = senderOptions(deps, ctx).orig;
  const checked = items.map((item) => {
    const original = deps.inbound.get(item.inboundId);
    // SMS powiadomień bramki i SMS spoza usług klucza są dla agenta niewidoczne, tak jak w API.
    if (!original || original.system === 1 || original.accountId !== ctx.account.id || !ctx.auth.allowedServiceIds.includes(original.serviceId)) {
      throw new AgentError('inbound_unknown', `Odebrany SMS ${item.inboundId} nie istnieje albo nie należy do usług klucza integracji.`);
    }
    try {
      normalizePhone(original.sender, ctx.account.defaultCountryCode);
    } catch {
      throw new AgentError('invalid_phone', `Na SMS ${item.inboundId} nie można odpowiedzieć, ponieważ nadawca ${original.sender} nie jest numerem telefonu.`);
    }
    return { item, original, shaped: shape(deps, ctx, item.text, {}, 'auto', 'messages') };
  });
  const confirm = newConfirm(opts.apps);
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS);
  return {
    confirm: confirm?.value ?? null,
    drafts: checked.map(({ item, original, shaped }) => {
      const payload: ReplyDraftPayload = { inboundId: original.id, to: original.sender, group: item.group, text: item.text, serviceId: original.serviceId, orig };
      const draftId = deps.drafts.insert({ connectionId: ctx.connection.id, kind: 'reply', payload, createdAt: now, expiresAt, confirmHash: confirm?.hash ?? null });
      return {
        draftId, inboundId: original.id, to: original.sender, group: item.group, text: shaped.prepared.text, parts: shaped.parts, characters: shaped.characters,
        expiresAt: expiresAt.toISOString(),
      };
    }),
  };
}

/** Porównanie klucza potwierdzenia ze skrótem w stałym czasie. */
function confirmMatches(hash: string, confirm: string | undefined): boolean {
  if (confirm === undefined) return false;
  const given = Buffer.from(hashSecret(confirm), 'hex');
  const stored = Buffer.from(hash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/**
 * Wysyłka szkicu: wychodzi dokładnie to, co człowiek widział w podglądzie. Szkic wysłany zwraca zapisany wynik
 * bez ochrony przed burzą i bez ponownej wysyłki. Każda wysyłka przechodzi przez potok integracji agenta:
 * połączenie i zakres sprawdzone ponownie, ochrona przed burzą, limit części, dziennik z nazwą połączenia.
 */
export function sendDraft(deps: AgentDeps, ctx: ConnectionContext, draftId: string, now: Date, confirm?: string): SendOutcome {
  const draft = deps.drafts.get(draftId, ctx.connection.id);
  if (!draft) throw new AgentError('draft_unknown', 'Szkic nie istnieje albo należy do innego połączenia. Przygotuj wysyłkę ponownie.');
  if (draft.confirmHash !== null && !confirmMatches(draft.confirmHash, confirm)) {
    throw new AgentError('confirm_required', 'Wysyłkę zatwierdza przycisk w widoku bramki.');
  }
  if (draft.sentAt !== null) return { ...(draft.result as StoredOutcome), repeated: true };
  if (Date.parse(draft.expiresAt) <= now.getTime()) {
    throw new AgentError('draft_expired', `Podgląd wygasł po 30 minutach. Przygotuj ${draft.kind === 'reply' ? 'odpowiedź' : 'SMS'} ponownie.`);
  }
  if (draft.kind === 'group') throw new AgentError('invalid', 'Wysyłka do grupy nie jest jeszcze dostępna.');

  const resolved = deps.connections.resolve(ctx.connection.id, now);
  if (!resolved.ok) {
    throw new AgentError('unavailable', `Połączenie jest chwilowo niedostępne: ${resolved.reason}. Dostęp przywraca administrator bramki.`);
  }
  const fresh = resolved.ctx;
  const scope: AgentScope = draft.kind === 'reply' ? 'reply' : 'send';
  if (!fresh.scopes.has(scope)) {
    throw new AgentError('scope', `Połączenie nie ma uprawnienia „${SCOPE_LABELS[scope]}”. Uprawnienia nadaje administrator bramki w integracji Agent AI.`);
  }

  const integration = fresh.integration;
  const config = integration.config;
  const sms = draft.kind === 'sms' ? draft.payload as SmsDraftPayload : null;
  const reply = draft.kind === 'reply' ? draft.payload as ReplyDraftPayload : null;
  const count = sms ? sms.to.length : 1;
  const label = sms ? 'Wyślij SMS' : `Odpowiedź na ${reply!.inboundId}`;
  const stored = integration.storePayloads === 1 ? payloadForLog(draft.payload) : null;
  const note = (result: IntegrationEventInput['result'], extra: Partial<IntegrationEventInput> = {}): void => {
    deps.integrationEvents.record({
      integrationId: integration.id, at: now, result, sourceIp: `MCP · ${fresh.connection.name}`, payload: stored, logLimit: config.eventLogLimit, ...extra,
    });
  };
  const subject = `integration:${integration.id}`;

  const { limit, windowMinutes, recipients: recipientLimit } = config.throttle;
  const gate = deps.guards.throttle(integration.id, limit, windowMinutes, now, { count, limit: recipientLimit });
  if (!gate.allowed) {
    const by = gate.by ?? 'calls';
    note('throttled', { reason: by === 'calls' ? `ponad ${limit} w ${windowMinutes} min` : `ponad ${recipientLimit} odbiorców w ${windowMinutes} min` });
    if (gate.notify) {
      deps.notifier?.notify('integration_throttled', subject,
        `${integration.name}: przekroczony limit ${by === 'calls' ? `${limit}` : `${recipientLimit} odbiorców`} w ${windowMinutes} min`, now);
    }
    throw throttledError(fresh, by, count, guardLeft(deps, fresh, now).resetsAt, now);
  }

  const via = {
    integrationId: integration.id, agentConnectionId: fresh.connection.id, requestedBy: fresh.connection.name,
    campaignFallback: integration.name, idempotencyKey: draft.id, maxParts: partsLimit(fresh),
  };
  let truncated = false;
  let outcome: StoredOutcome;
  try {
    // Wysyłka i oznaczenie szkicu w jednej transakcji: szkic bez wyniku nigdy nie zostaje po przyjętej wysyłce.
    outcome = deps.messages.transaction((): StoredOutcome => {
      let result: StoredOutcome;
      if (sms) {
        const shaped = shape(deps, fresh, sms.text, sms.links, sms.encoding, sms.route);
        truncated = shaped.truncated;
        const orig = sms.orig === null ? {} : { orig: sms.orig };
        if (sms.route === 'package') {
          const pkg = submitPackage(deps, fresh.auth, {
            recipients: sms.to.map((to) => ({ to })), defaultText: sms.text, deliveryReport: true, encoding: sms.encoding, links: sms.links,
            prepared: { defaultText: shaped.prepared, recipients: [] }, serviceId: sms.serviceId, ...orig, ...via,
          }, now);
          result = { kind: 'package', id: pkg.id, recipients: pkg.recipients };
        } else {
          const sent = submitMessages(deps, fresh.auth, {
            to: sms.to, text: sms.text, prepared: shaped.prepared, links: sms.links, encoding: sms.encoding, serviceId: sms.serviceId, ...orig, ...via,
          }, now);
          result = { kind: 'messages', ids: sent.map((m) => m.id) };
        }
      } else {
        const r = reply!;
        const shaped = shape(deps, fresh, r.text, {}, 'auto', 'messages');
        truncated = shaped.truncated;
        const sent = submitMessages(deps, fresh.auth, {
          to: [r.to], text: r.text, prepared: shaped.prepared, links: {}, serviceId: r.serviceId, inReplyTo: r.inboundId,
          ...(r.orig === null ? {} : { orig: r.orig }), ...via,
        }, now);
        result = { kind: 'messages', ids: sent.map((m) => m.id) };
      }
      deps.drafts.markSent(draft.id, result, now);
      return result;
    });
  } catch (e) {
    if (e instanceof ApiError || e instanceof AgentError) {
      note('error', { reason: `${label}: ${e.message}` });
      // Numer odbiorcy jest daną osobową, dlatego mail do administratora go nie zawiera.
      const summary = e.code === 'invalid_phone' ? 'nieprawidłowy numer odbiorcy' : e.message;
      deps.notifier?.notify('integration_error', subject, `${integration.name}: ${label}: ${summary}`, now);
    }
    throw e;
  }

  // Wysyłka jest już w kolejce, dlatego błąd zapisu wpisu nie może zamienić wyniku w błąd.
  try {
    const reason = sms ? `${label}, ${recipientsWord(count)}` : label;
    note('sent', {
      reason: truncated ? `${reason}; skrócono do ${partsLimit(fresh)} części` : reason,
      ...(outcome.kind === 'package' ? { packageId: outcome.id } : { messageId: outcome.ids[0]! }),
    });
  } catch (error) {
    deps.log?.error('integracja.dziennik_blad', { integrationId: integration.id, error });
  }
  return { ...outcome, repeated: false };
}
