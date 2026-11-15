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
import { measureText, type EncodingRequest } from '../text/measure.ts';
import { InvalidPhoneError, normalizePhone, normalizeRecipient } from '../text/phone.ts';
import { segmentText } from '../text/segment.ts';
import type { AgentScope, GroupMember, SmsGroupConfig } from './config.ts';
import { foldText } from './group/prefix.ts';
import { buildAgentGroupContext, dispatch, renderGroupText, type Noter, type PipelineDeps, type SmsGroupIntegration } from './pipeline.ts';
import { payloadForLog } from './power-automate.ts';
import { TemplateError } from './templates.ts';

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
/** Pozostałe wysyłki i odbiorcy w oknie ochrony przed burzą; `recipients` null, gdy integracja nie liczy odbiorców (grupa SMS). */
export interface GuardLeft { calls: number; recipients: number | null; resetsAt: string | null }

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

export interface GroupPreview {
  draftId: string; expiresAt: string; group: { id: number; name: string }; groups: string[]; recipients: number;
  text: string; parts: number; characters: number; encoding: 'gsm' | 'ucs2'; truncated: boolean; guard: GuardLeft; groupGuard: GuardLeft;
  /** Nadawca wysyłki do grupy; null oznacza numer usługi `service`. */
  orig: string | null; service: ServiceOption;
}

export type SendOutcome =
  | { kind: 'messages'; ids: string[]; repeated: boolean }
  | { kind: 'package'; id: string; recipients: number; repeated: boolean }
  | { kind: 'group'; ids: string[]; group: string; repeated: boolean };

/** Wynik przygotowania: klucz potwierdzenia trafia wyłącznie do `_meta` wyniku narzędzia, nigdy do podglądu. */
export interface Prepared<T> { confirm: string | null; preview: T }
/** Odbiorca szkicu SMS-a po normalizacji, z identyfikatorem klienta z kampanii, jeżeli był podany przy wysyłce. */
export interface SmsRecipient { phone: string; clientId: string | null }

/** Szkic SMS-a: odbiorcy po normalizacji, treść przed skróceniem i wszystko, czego wymaga wysyłka. */
interface SmsDraftPayload {
  route: 'messages' | 'package'; to: string[]; text: string; links: LinkRequest; serviceId: string; orig: string | null; encoding: EncodingRequest;
}
interface ReplyDraftPayload { inboundId: string; to: string; group: string; text: string; serviceId: string; orig: string | null }
/** Szkic grupy: odbiorcy i treść po szablonie grupy w chwili przygotowania, tak jak widział je człowiek. */
interface GroupDraftPayload { groupId: number; group: string; to: string[]; text: string }
type StoredOutcome = { kind: 'messages'; ids: string[] } | { kind: 'package'; id: string; recipients: number } | { kind: 'group'; ids: string[]; group: string };

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

/** Stan okna ochrony przed burzą bez zapisu; limit odbiorców tylko dla integracji, która go ma. */
function windowLeft(deps: AgentDeps, integrationId: number, throttle: { limit: number; windowMinutes: number; recipients?: number }, now: Date): GuardLeft {
  const window = deps.guards.peek(integrationId, throttle.windowMinutes, now);
  return {
    calls: Math.max(0, throttle.limit - window.count),
    recipients: throttle.recipients === undefined ? null : Math.max(0, throttle.recipients - window.recipients),
    resetsAt: window.windowStart === null ? null : new Date(Date.parse(window.windowStart) + throttle.windowMinutes * MIN).toISOString(),
  };
}

/** Ile wysyłek i odbiorców zostało w bieżącym oknie ochrony przed burzą integracji agenta. */
export function guardLeft(deps: AgentDeps, ctx: ConnectionContext, now: Date): GuardLeft {
  return windowLeft(deps, ctx.integration.id, ctx.integration.config.throttle, now);
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

/** Powód odmowy ochrony przed burzą integracji agenta w dzienniku. */
function throttleReason(ctx: ConnectionContext, by: 'calls' | 'recipients'): string {
  const { limit, windowMinutes, recipients } = ctx.integration.config.throttle;
  return by === 'calls' ? `ponad ${limit} w ${windowMinutes} min` : `ponad ${recipients} odbiorców w ${windowMinutes} min`;
}

/** Zgłoszenie burzy integracji agenta administratorowi, wysyłane raz w oknie. */
function notifyThrottled(deps: AgentDeps, ctx: ConnectionContext, by: 'calls' | 'recipients', now: Date): void {
  const { limit, windowMinutes, recipients } = ctx.integration.config.throttle;
  deps.notifier?.notify('integration_throttled', `integration:${ctx.integration.id}`,
    `${ctx.integration.name}: przekroczony limit ${by === 'calls' ? `${limit}` : `${recipients} odbiorców`} w ${windowMinutes} min`, now);
}

/**
 * Szkic, który przekroczyłby okno ochrony, odpada już przy przygotowaniu. Odmowa zapisuje wpis w dzienniku
 * i zgłasza burzę jak odmowa przy wysyłce, ale nie zużywa limitu (spec 4.5).
 */
function checkWindow(deps: AgentDeps, ctx: ConnectionContext, n: number, now: Date): GuardLeft {
  const left = guardLeft(deps, ctx, now);
  const by = left.calls < 1 ? 'calls' : left.recipients !== null && left.recipients < n ? 'recipients' : null;
  if (by === null) return left;
  const integration = ctx.integration;
  deps.integrationEvents.record({
    integrationId: integration.id, at: now, result: 'throttled', reason: `podgląd: ${throttleReason(ctx, by)}`,
    sourceIp: `MCP · ${ctx.connection.name}`, payload: null, logLimit: integration.config.eventLogLimit,
  });
  if (deps.guards.refuse(integration.id, integration.config.throttle.windowMinutes, now).notify) notifyThrottled(deps, ctx, by, now);
  throw throttledError(ctx, by, n, left.resetsAt, now);
}

/**
 * Podgląd do grupy z wyczerpanym limitem: wpisy w dziennikach grupy i agenta oraz zgłoszenie burzy grupy raz
 * w oknie, bez zużycia limitów, tak jak przy odmowie szkicu agenta.
 */
function refuseGroup(deps: AgentDeps, ctx: ConnectionContext, group: SmsGroupIntegration, resetsAt: string | null, now: Date): never {
  const { limit, windowMinutes } = group.config.throttle;
  const reason = `ponad ${limit} w ${windowMinutes} min`;
  deps.integrationEvents.record({
    integrationId: group.id, at: now, result: 'throttled', reason: `podgląd: ${reason}`,
    sourceIp: `agent ${ctx.integration.name} · ${ctx.connection.name}`, payload: null, logLimit: group.config.eventLogLimit,
  });
  deps.integrationEvents.record({
    integrationId: ctx.integration.id, at: now, result: 'throttled', reason: `podgląd: ochrona grupy ${group.name}: ${reason}`,
    sourceIp: `MCP · ${ctx.connection.name}`, payload: null, logLimit: ctx.integration.config.eventLogLimit,
  });
  if (deps.guards.refuse(group.id, windowMinutes, now).notify) {
    deps.notifier?.notify('integration_throttled', `integration:${group.id}`, `${group.name}: przekroczony limit ${limit} w ${windowMinutes} min`, now);
  }
  throw groupThrottledError(group, resetsAt, now);
}

/** Odmowa ochrony przed burzą grupy SMS, która liczy wyłącznie wysyłki. */
function groupThrottledError(group: SmsGroupIntegration, resetsAt: string | null, now: Date): AgentError {
  const { limit, windowMinutes } = group.config.throttle;
  return new AgentError('throttled', `Grupa ${group.name} wykorzystała limit ${limit} wysyłek na ${windowMinutes} min.`,
    resetsAt === null ? undefined : secondsUntil(resetsAt, now));
}

/** Limit części i zachowanie przy nadmiarze; `whose` nazywa właściciela limitu w komunikacie. */
interface PartsLimit { maxParts: number; overflow: 'truncate' | 'reject'; whose: string }

/** Limit części wysyłki agenta: limit integracji, ale nigdy więcej niż limit klucza. */
function agentLimit(ctx: ConnectionContext): PartsLimit {
  const { maxParts, overflow } = ctx.integration.config;
  return { maxParts: Math.min(maxParts, ctx.key.maxParts), overflow, whose: maxParts <= ctx.key.maxParts ? 'integracji' : 'klucza API' };
}

/** Wysyłka do grupy stosuje limit części grupy i jej zachowanie przy zbyt długiej treści, nigdy ponad limit klucza. */
function groupLimit(ctx: ConnectionContext, group: SmsGroupIntegration): PartsLimit {
  const { maxParts, overflow } = group.config;
  return { maxParts: Math.min(maxParts, ctx.key.maxParts), overflow, whose: maxParts <= ctx.key.maxParts ? `grupy ${group.name}` : 'klucza API' };
}

interface Shaped { template: PreparedText; prepared: PreparedText; parts: number; characters: number; encoding: 'gsm' | 'ucs2'; truncated: boolean }

/**
 * Treść tak, jak ją wyśle bramka: skracanie linków według klucza, kodowanie (rozsyłka ma jedno kodowanie),
 * limit części z zachowaniem przy nadmiarze. Rzuca `ApiError` skracacza i `AgentError` limitu części.
 */
function shape(
  deps: AgentDeps, ctx: ConnectionContext, text: string, links: LinkRequest, encoding: EncodingRequest, route: 'messages' | 'package',
  limits: PartsLimit = agentLimit(ctx),
): Shaped {
  if (text.trim() === '') throw new AgentError('empty_text', 'Treść SMS-a jest pusta.');
  const template = prepareLinks(onceSettings(deps), ctx.key.id, text, links, {});
  const enc: EncodingRequest = route === 'package' ? packageEncoding([template.text], encoding) : encoding;
  const limit = limits.maxParts;
  const fitted = fitPrepared(template, limit, enc);
  if (fitted.over && limits.overflow === 'reject') {
    const needed = segmentText(template.text, measureText(template.text, enc), Number.MAX_SAFE_INTEGER).parts;
    throw new AgentError('too_many_parts', `Treść wymaga ${needed} części, a limit ${limits.whose} wynosi ${limit}. Skróć treść.`);
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

const scopeError = (scope: AgentScope): AgentError =>
  new AgentError('scope', `Połączenie nie ma uprawnienia „${SCOPE_LABELS[scope]}”. Uprawnienia nadaje administrator bramki w integracji Agent AI.`);

/**
 * Numery odbiorców kampanii klucza według otwarcia linku (zakresy `campaigns` i `send`). Agent otrzymuje tylko
 * ich liczbę, a szkic przechowuje numery. Po usunięciu szczegółów kampanii listy nie można odtworzyć.
 */
function campaignRecipients(
  deps: AgentDeps, ctx: ConnectionContext, ref: NonNullable<PrepareSmsInput['campaignRecipients']>,
): Array<{ dest: string; clientId: string | null }> {
  if (!ctx.scopes.has('campaigns')) throw scopeError('campaigns');
  const campaign = deps.campaigns.byName(ctx.key.id, ref.campaign);
  if (!campaign) throw new AgentError('campaign_unknown', `Kampania „${ref.campaign}” nie istnieje w kluczu integracji.`);
  if (campaign.detailsPurgedAt !== null) {
    throw new AgentError('campaign_purged', 'Szczegóły kampanii zostały usunięte po okresie przechowywania, dlatego listy odbiorców nie można odtworzyć.');
  }
  const list = deps.shortLinks.recipients(campaign.id, ref.segment);
  if (list.length === 0) {
    throw new AgentError('no_recipient', ref.segment === 'unopened'
      ? `Wszyscy odbiorcy kampanii ${campaign.name} otworzyli link.`
      : `Żaden odbiorca kampanii ${campaign.name} nie otworzył linku.`);
  }
  return list;
}

/** Włączone grupy SMS klucza integracji agenta, w kolejności nazw. */
function agentGroups(deps: AgentDeps, ctx: ConnectionContext): SmsGroupIntegration[] {
  return deps.integrations.listForKey(ctx.key.id).filter((i) => i.kind === 'sms_group' && i.enabled === 1) as SmsGroupIntegration[];
}

/** Grupa po nazwie, a gdy żadna nazwa nie pasuje, po prefiksie; bez rozróżniania wielkości liter i polskich znaków. */
function findGroup(deps: AgentDeps, ctx: ConnectionContext, query: string): { group: SmsGroupIntegration; names: string[] } {
  const groups = agentGroups(deps, ctx);
  const names = groups.map((g) => g.name);
  const wanted = foldText(query.trim());
  const byName = groups.filter((g) => foldText(g.name) === wanted);
  const found = byName.length > 0 ? byName : groups.filter((g) => g.config.prefix !== '' && foldText(g.config.prefix) === wanted);
  if (found.length === 1) return { group: found[0]!, names };
  if (found.length > 1) {
    throw new AgentError('group_ambiguous', `Nazwa „${query}” pasuje do kilku grup: ${found.map((g) => g.name).join(', ')}. Podaj pełną nazwę grupy.`);
  }
  throw new AgentError('group_unknown', groups.length === 0
    ? 'Klucz integracji nie ma włączonych grup SMS. Grupy zakłada administrator bramki.'
    : `Grupa „${query}” nie istnieje albo jest wyłączona. Dostępne grupy: ${names.join(', ')}.`);
}

/** Odbiorcy jak w `runSmsGroup`: lista odbiorców w trybie dwóch list, wszyscy członkowie w trybie wspólnej listy. */
function groupMembers(config: SmsGroupConfig): GroupMember[] {
  const seen = new Set<string>();
  return (config.mode === 'closed' ? config.members : config.recipients).filter((m) => !seen.has(m.phone) && seen.add(m.phone));
}

/**
 * Nadawca i usługa wysyłki do grupy, tak jak ustala je `dispatch`: nadpis i usługa grupy, a bez nich ustawienia
 * klucza i konta. Bez żadnego nadpisu SMS wychodzi z numeru usługi.
 */
function groupSender(deps: AgentDeps, ctx: ConnectionContext, group: SmsGroupIntegration): { orig: string | null; service: ServiceOption } {
  const serviceId = group.serviceId ? group.serviceId : ctx.auth.defaultServiceId ?? '';
  const label = deps.accounts.services(ctx.account.id).find((s) => s.id === serviceId)?.label ?? serviceId;
  return { orig: group.orig ? group.orig : keyOrigs(ctx.auth, ctx.account, deps.accounts).fallback, service: { id: serviceId, label } };
}

/**
 * SMS do grupy: odbiorcy i treść według ustawień grupy, bez warunku grupy, który dotyczy odebranego SMS-a.
 * Agent otrzymuje liczbę odbiorców, a numery i nazwy trafiają wyłącznie do widoku przez `recipients`.
 * Podgląd sprawdza okna ochrony integracji agenta i grupy.
 */
export function prepareGroup(
  deps: AgentDeps, ctx: ConnectionContext, input: { group: string; text: string }, now: Date, opts: { apps?: boolean } = {},
): { preview: GroupPreview; recipients: GroupMember[]; confirm: string | null } {
  const { group, names } = findGroup(deps, ctx, input.group);
  const members = groupMembers(group.config);
  if (members.length === 0) {
    throw new AgentError('group_empty', `Grupa ${group.name} nie ma odbiorców. Listę uzupełnia administrator w panelu bramki.`);
  }
  const body = input.text.trim();
  if (body === '') throw new AgentError('empty_text', 'Treść SMS-a jest pusta.');
  const phones = members.map((m) => m.phone);
  let text: string;
  try {
    text = renderGroupText(deps.engine, group.config, buildAgentGroupContext(body, ctx.connection.name, phones, group.config, group, now));
  } catch (e) {
    if (e instanceof TemplateError) throw new AgentError('template', `Szablon treści grupy ${group.name} zawiera błąd: ${e.message}`);
    throw e;
  }
  if (text === '') throw new AgentError('empty_text', `Szablon treści grupy ${group.name} nie tworzy żadnego tekstu.`);
  const shaped = shape(deps, ctx, text, {}, 'auto', 'messages', groupLimit(ctx, group));
  const guard = checkWindow(deps, ctx, members.length, now);
  const groupGuard = windowLeft(deps, group.id, group.config.throttle, now);
  if (groupGuard.calls < 1) refuseGroup(deps, ctx, group, groupGuard.resetsAt, now);

  const confirm = newConfirm(opts.apps);
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS);
  const payload: GroupDraftPayload = { groupId: group.id, group: group.name, to: phones, text };
  const draftId = deps.drafts.insert({ connectionId: ctx.connection.id, kind: 'group', payload, createdAt: now, expiresAt, confirmHash: confirm?.hash ?? null });
  return {
    confirm: confirm?.value ?? null,
    recipients: members,
    preview: {
      draftId, expiresAt: expiresAt.toISOString(), group: { id: group.id, name: group.name }, groups: names, recipients: members.length,
      text: shaped.prepared.text, parts: shaped.parts, characters: shaped.characters, encoding: shaped.encoding, truncated: shaped.truncated,
      guard, groupGuard, ...groupSender(deps, ctx, group),
    },
  };
}

/**
 * Przygotowanie SMS-a: sprawdza wszystko, co sprawdziłaby wysyłka, i zapisuje szkic ważny 30 minut. Niczego
 * nie wysyła. W sesji z widokami szkic otrzymuje jednorazowy klucz potwierdzenia. Podgląd zawiera liczbę
 * odbiorców, a numery po normalizacji wynik zwraca osobno w `recipients`, dla widoku.
 */
export function prepareSms(
  deps: AgentDeps, ctx: ConnectionContext, input: PrepareSmsInput, now: Date, opts: { apps?: boolean } = {},
): Prepared<SmsPreview> & { recipients: SmsRecipient[] } {
  if (input.campaignRecipients !== undefined && (input.to?.length ?? 0) > 0) {
    throw new AgentError('invalid', 'Podaj numery odbiorców albo odbiorców kampanii, a nie oba rodzaje naraz.');
  }
  const raw = input.campaignRecipients === undefined
    ? (input.to ?? []).map((dest) => ({ dest, clientId: null }))
    : campaignRecipients(deps, ctx, input.campaignRecipients);
  if (raw.length === 0) throw new AgentError('no_recipient', 'Podaj co najmniej jeden numer odbiorcy.');
  const clients = new Map<string, string | null>();
  for (const r of raw) {
    const phone = normalize(r.dest, ctx.account.defaultCountryCode);
    if (!clients.has(phone)) clients.set(phone, r.clientId);
  }
  const to = [...clients.keys()];
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
    recipients: to.map((phone) => ({ phone, clientId: clients.get(phone) ?? null })),
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

/**
 * Ochrona przed burzą integracji agenta: wywołania i odbiorcy w oknie. Odmowa zapisuje wpis w dzienniku,
 * pierwsza w oknie zgłasza `integration_throttled`, a agent otrzymuje czas do ponowienia.
 */
function throttleAgent(deps: AgentDeps, ctx: ConnectionContext, count: number, note: Noter, now: Date): void {
  const integration = ctx.integration;
  const { limit, windowMinutes, recipients } = integration.config.throttle;
  const gate = deps.guards.throttle(integration.id, limit, windowMinutes, now, { count, limit: recipients });
  if (gate.allowed) return;
  const by = gate.by ?? 'calls';
  note('throttled', { reason: throttleReason(ctx, by) });
  if (gate.notify) notifyThrottled(deps, ctx, by, now);
  throw throttledError(ctx, by, count, guardLeft(deps, ctx, now).resetsAt, now);
}

/**
 * Wysyłka szkicu grupy: integracja agenta i integracja grupy liczą własne limity i zapisują własne wpisy. Grupa
 * wyczerpana nie zużywa okna agenta, dlatego okno agenta jest sprawdzane przed grupą, a zużywane po niej.
 * Wysyłka idzie przez `dispatch` z usługą i nadpisem grupy, bez potwierdzenia SMS-em zwrotnym.
 */
function sendGroup(deps: AgentDeps, ctx: ConnectionContext, draftId: string, payload: GroupDraftPayload, note: Noter, now: Date): SendOutcome {
  const row = deps.integrations.get(payload.groupId);
  if (!row || row.kind !== 'sms_group' || row.enabled !== 1 || row.apiKeyId !== ctx.key.id) {
    throw new AgentError('group_unknown', `Grupa ${payload.group} nie istnieje albo jest wyłączona. Przygotuj wysyłkę ponownie.`);
  }
  const group = row as SmsGroupIntegration;
  const count = payload.to.length;
  const label = `Wyślij SMS do grupy ${group.name}`;
  const groupNote: Noter = (result, extra = {}) => {
    deps.integrationEvents.record({
      integrationId: group.id, at: now, result, sourceIp: `agent ${ctx.integration.name} · ${ctx.connection.name}`,
      payload: group.storePayloads === 1 ? payloadForLog(payload) : null, logLimit: group.config.eventLogLimit, ...extra,
    });
  };

  const left = guardLeft(deps, ctx, now);
  if (left.calls < 1 || (left.recipients !== null && left.recipients < count)) throttleAgent(deps, ctx, count, note, now);
  const { limit, windowMinutes } = group.config.throttle;
  const gate = deps.guards.throttle(group.id, limit, windowMinutes, now);
  if (!gate.allowed) {
    groupNote('throttled', { reason: `ponad ${limit} w ${windowMinutes} min` });
    note('throttled', { reason: `ochrona grupy ${group.name}: ponad ${limit} w ${windowMinutes} min` });
    if (gate.notify) {
      deps.notifier?.notify('integration_throttled', `integration:${group.id}`, `${group.name}: przekroczony limit ${limit} w ${windowMinutes} min`, now);
    }
    throw groupThrottledError(group, windowLeft(deps, group.id, group.config.throttle, now).resetsAt, now);
  }
  throttleAgent(deps, ctx, count, note, now);

  const outcome = deps.messages.transaction(() => {
    const sent = dispatch(deps, group, ctx.key, payload.text, payload.to, groupLimit(ctx, group), groupNote, now, {
      agentConnectionId: ctx.connection.id, requestedBy: ctx.connection.name, idempotencyKey: draftId,
    });
    if (sent.kind === 'error') return sent;
    const result: StoredOutcome = { kind: 'group', ids: sent.messageIds, group: group.name };
    deps.drafts.markSent(draftId, result, now);
    return result;
  });
  if (outcome.kind === 'error') {
    note('error', { reason: `${label}: ${outcome.detail}` });
    const summary = outcome.code === 'invalid_phone' ? 'nieprawidłowy numer odbiorcy' : outcome.detail;
    deps.notifier?.notify('integration_error', `integration:${ctx.integration.id}`, `${ctx.integration.name}: ${label}: ${summary}`, now);
    throw new AgentError(outcome.code, outcome.detail);
  }
  // Wysyłka jest już w kolejce, dlatego błąd zapisu wpisu nie może zamienić wyniku w błąd.
  try {
    note('sent', { reason: `${label}, ${recipientsWord(count)}`, ...(outcome.kind === 'group' ? { messageId: outcome.ids[0]! } : {}) });
  } catch (error) {
    deps.log?.error('integracja.dziennik_blad', { integrationId: ctx.integration.id, error });
  }
  return { ...(outcome as Extract<StoredOutcome, { kind: 'group' }>), repeated: false };
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

  const resolved = deps.connections.resolve(ctx.connection.id, now);
  if (!resolved.ok) {
    throw new AgentError('unavailable', `Połączenie jest chwilowo niedostępne: ${resolved.reason}. Dostęp przywraca administrator bramki.`);
  }
  const fresh = resolved.ctx;
  const scope: AgentScope = draft.kind === 'reply' ? 'reply' : draft.kind === 'group' ? 'send_group' : 'send';
  if (!fresh.scopes.has(scope)) throw scopeError(scope);

  const integration = fresh.integration;
  const config = integration.config;
  const stored = integration.storePayloads === 1 ? payloadForLog(draft.payload) : null;
  const note: Noter = (result, extra = {}) => {
    deps.integrationEvents.record({
      integrationId: integration.id, at: now, result, sourceIp: `MCP · ${fresh.connection.name}`, payload: stored, logLimit: config.eventLogLimit, ...extra,
    });
  };
  if (draft.kind === 'group') return sendGroup(deps, fresh, draft.id, draft.payload as GroupDraftPayload, note, now);

  const sms = draft.kind === 'sms' ? draft.payload as SmsDraftPayload : null;
  const reply = draft.kind === 'reply' ? draft.payload as ReplyDraftPayload : null;
  const count = sms ? sms.to.length : 1;
  const label = sms ? 'Wyślij SMS' : `Odpowiedź na ${reply!.inboundId}`;
  const subject = `integration:${integration.id}`;
  throttleAgent(deps, fresh, count, note, now);

  const via = {
    integrationId: integration.id, agentConnectionId: fresh.connection.id, requestedBy: fresh.connection.name,
    campaignFallback: integration.name, idempotencyKey: draft.id, maxParts: agentLimit(fresh).maxParts,
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
      reason: truncated ? `${reason}; skrócono do ${agentLimit(fresh).maxParts} części` : reason,
      ...(outcome.kind === 'package' ? { packageId: outcome.id } : { messageId: outcome.ids[0]! }),
    });
  } catch (error) {
    deps.log?.error('integracja.dziennik_blad', { integrationId: integration.id, error });
  }
  return { ...outcome, repeated: false };
}
