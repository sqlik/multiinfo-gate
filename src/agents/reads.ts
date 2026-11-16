import { packageStatusLabel, stageLabel, statusLabel } from '../admin/views/status-labels.ts';
import { presentMessage } from '../api/messages.ts';
import { handoverAt } from '../api/schedule.ts';
import type { ApiDeps } from '../api/server.ts';
import { AgentError } from '../integrations/agent.ts';
import { sourceLabel } from '../integrations/source-label.ts';
import { groupTargets, type CampaignTarget } from '../links/campaigns.ts';
import { describeSubstatus } from '../multiinfo/status.ts';
import type { AgentConnectionsRepo } from '../store/agent-connections.ts';
import type { InboundRow } from '../store/inbound-messages.ts';
import { TRANSIT_STATUSES, type MessageRow } from '../store/messages.ts';
import type { PackageRow, PackageStatus, RecipientRow } from '../store/packages.ts';
import { InvalidPhoneError, normalizeRecipient } from '../text/phone.ts';
import { endOfWarsawDay, warsawCompactToIso, warsawDay, warsawShort, warsawStamp } from '../time/warsaw.ts';
import type { ConnectionContext } from './connections.ts';

/**
 * Odczyty dla agentów AI: te same repozytoria, z których korzysta API v1, w obrębie klucza integracji agenta,
 * bez wiadomości systemowych. Wyniki są gotowymi zestawieniami, a każdy czas ma postać ISO oraz czas polski.
 */
export type ReadDeps = Pick<ApiDeps, 'messages' | 'events' | 'packages' | 'campaigns' | 'shortLinks' | 'inbound' | 'integrations'>
  & { connectionsRepo: Pick<AgentConnectionsRepo, 'get'> };

export interface Page { offset: number; limit: number }
export interface Stamp { at: string; local: string }

export interface PackageStatusData {
  id: string; status: PackageStatus; statusLabel: string; final: boolean; recipients: number; remaining: number | null; created: Stamp; source: string;
  report: { byStatus: Record<string, number>; reasons: Array<{ description: string; count: number }>; deliveredByHour: Array<{ hour: string; count: number }> } | null;
  items: Array<{ to: string; clientId: string | null; status: string; statusLabel: string; changed: Stamp | null }>; hasMore: boolean;
  /** Termin rozsyłki; chwila przekazania wyłącznie w stanie `scheduled`. */
  schedule: { startAt: Stamp; handoverAt: Stamp | null } | null;
  /** Agent może anulować rozsyłkę: własna, czekająca na przekazanie, przy zakresie wysyłki. */
  cancellable: boolean;
}

export interface PackageListItem {
  id: string; status: PackageStatus; statusLabel: string; recipients: number; created: Stamp; startAt: Stamp | null; source: string;
}

export interface CampaignResultsData {
  name: string; sent: number; delivered: number; opens: number; clicks: number; bots: number; first: Stamp; last: Stamp; detailsPurged: boolean;
  opensByDay: Array<{ day: string; opens: number }>; clicksByHour: Array<{ hour: string; clicks: number }>; targets: CampaignTarget[];
  unopened: { total: number; items: Array<{ to: string; clientId: string | null }>; hasMore: boolean } | null;
}

export type AnswersTo = { messageId: string } | { packageId: string } | null;

export interface InboundItem { id: string; from: string; received: Stamp; text: string | null; source: 'external_sender'; answersTo: AnswersTo }

export interface TraceEntry {
  kind: 'message' | 'package_recipient'; id: string; to: string; status: string; statusLabel: string; source: string; created: Stamp;
  stages: Array<Stamp & { kind: string; label: string; detail: string | null }>; operator: { code: string; description: string } | null;
  cancellable: boolean; text: string | null; packageId: string | null;
  /** Wiadomość wysłana przez integrację agenta, wprost albo do grupy; tylko taką agent może anulować. */
  agentSent: boolean;
  /** Nadawca, usługa i kodowanie treści dla okna treści w widoku; `sender` null oznacza numer usługi, `parts` tylko przy wiadomości. */
  sender: string | null; serviceId: string; encoding: 'gsm' | 'ucs2'; parts: number | null;
}

const DAY = 86_400_000;
/** Odpowiedź przypisujemy do wysyłki najdalej 7 dni po niej (spec 6.3). */
const ANSWER_WINDOW_MS = 7 * DAY;
/** Przebieg doręczenia po numerze: domyślnie 7 ostatnich dni, najwyżej 20 pozycji od najnowszej. */
const TRACE_WINDOW_MS = 7 * DAY;
const TRACE_MAX = 20;
const PAGE_MAX = 200;
const PAGE_DEFAULT = 25;
/** Porcja odebranych przeglądanych przy zestawieniu odpowiedzi na jedną wysyłkę. */
const SCAN_BATCH = 500;
const FINAL_PACKAGE: ReadonlySet<PackageStatus> = new Set(['completed', 'cancelled', 'failed']);
/**
 * Stany przed przekazaniem do sieci operatora: kolejka bramki, status 0 Multiinfo i wstrzymanie limitem. Wiadomość
 * przekazaną do sieci Multiinfo odrzuca przy anulowaniu kodem -41, dlatego przebieg nie proponuje wtedy „Anuluj”.
 */
const BEFORE_NETWORK: ReadonlySet<string> = new Set(['queued', 'throttled']);

const stamp = (iso: string): Stamp => ({ at: new Date(iso).toISOString(), local: warsawShort(iso) });

/** Strona odczytu w granicach: `limit` od 1 do 200, domyślnie 25, `offset` nieujemny. */
function pageOf(p: Page): Page {
  const limit = Number.isInteger(p.limit) && p.limit >= 1 ? Math.min(p.limit, PAGE_MAX) : PAGE_DEFAULT;
  const offset = Number.isInteger(p.offset) && p.offset > 0 ? p.offset : 0;
  return { offset, limit };
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const ZONED_TIME = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Chwila z pola zapytania. Data i godzina bez strefy oznaczają czas polski, ponieważ agent przepisuje „od wczoraj
 * 14:00” z rozmowy. Sam dzień oznacza jego początek, a jako koniec przedziału koniec tego dnia w Polsce.
 */
export function instant(name: string, value: string, end = false): string {
  const v = value.trim();
  const local = LOCAL_TIME.exec(v);
  try {
    if (local) {
      const [, y, mo, d, h, mi, s] = local as unknown as [string, string, string, string, string | undefined, string | undefined, string | undefined];
      // endOfWarsawDay odrzuca nieistniejący dzień, na przykład 2026-02-30.
      const dayEnd = endOfWarsawDay(`${y}-${mo}-${d}`);
      if (h === undefined) return end ? dayEnd : warsawCompactToIso(`${y}${mo}${d}000000`);
      if (Number(h) > 23 || Number(mi) > 59 || Number(s ?? '0') > 59) throw new Error('godzina');
      return warsawCompactToIso(`${y}${mo}${d}${h}${mi}${s ?? '00'}`);
    }
    const time = Date.parse(v);
    if (ZONED_TIME.test(v) && !Number.isNaN(time)) return new Date(time).toISOString();
  } catch {
    // Niżej jeden komunikat dla każdej nieczytelnej daty.
  }
  throw new AgentError('invalid', `Pole ${name} musi być datą, na przykład 2026-11-14 albo 2026-11-14T14:00 w czasie polskim.`);
}

/** Numer w dowolnym zapisie do postaci, w jakiej bramka zapisuje odbiorców i nadawców. */
function phone(ctx: ConnectionContext, raw: string): string {
  try {
    return normalizeRecipient(raw, ctx.account.defaultCountryCode);
  } catch (e) {
    if (e instanceof InvalidPhoneError) throw new AgentError('invalid_phone', `${e.message}.`);
    throw e;
  }
}

/** Data stanu z raportu jest czasem polskim `RRRR-MM-DD GG:MM:SS`; zapis spoza tej postaci nie ma chwili. */
function reportStamp(raw: string | null): Stamp | null {
  const m = raw === null ? null : /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  return stamp(warsawCompactToIso(m.slice(1).join('')));
}

const countBy = (values: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};

const matchesStatus = (status: string, wanted: string | undefined): boolean =>
  wanted === undefined || (wanted === 'transit' ? (TRANSIT_STATUSES as readonly string[]).includes(status) : status === wanted);

/**
 * Wysłane wiadomości klucza, także z innych integracji, z filtrami jak `GET /v1/messages` oraz szkicem agenta.
 * Liczby w stanach obejmują wszystkie wiadomości spełniające filtry poza stanem, dzięki czemu agent widzi cały rozkład.
 */
export function listSent(deps: ReadDeps, ctx: ConnectionContext, q: { status?: string | undefined; to?: string | undefined; from?: string | undefined; until?: string | undefined; draftId?: string | undefined } & Page): {
  items: Array<ReturnType<typeof presentMessage> & { source: string }>; counts: Record<string, number>; hasMore: boolean;
} {
  const { offset, limit } = pageOf(q);
  const filter = {
    apiKeyId: ctx.key.id,
    ...(q.to !== undefined ? { dest: phone(ctx, q.to) } : {}),
    ...(q.from !== undefined ? { from: instant('from', q.from) } : {}),
    ...(q.until !== undefined ? { until: instant('until', q.until, true) } : {}),
  };
  const present = (m: MessageRow) => ({ ...presentMessage(m), source: sourceLabel(deps, m) });

  if (q.draftId !== undefined) {
    const all = deps.messages.forDraft(ctx.key.id, q.draftId).filter((m) => (filter.dest === undefined || m.dest === filter.dest)
      && (filter.from === undefined || m.createdAt >= filter.from) && (filter.until === undefined || m.createdAt <= filter.until));
    const matching = all.filter((m) => matchesStatus(m.status, q.status));
    return {
      items: matching.slice(offset, offset + limit).map(present),
      counts: countBy(all.map((m) => m.status)),
      hasMore: matching.length > offset + limit,
    };
  }
  const rows = deps.messages.list({ ...filter, ...(q.status !== undefined ? { status: q.status } : {}), limit: limit + 1, offset });
  return { items: rows.slice(0, limit).map(present), counts: deps.messages.statusCounts(filter), hasMore: rows.length > limit };
}

/** Etapy wiadomości z `message_events`; wiadomość sprzed zapisu zdarzeń dostaje trzy daty, jak w panelu. */
function messageStages(deps: ReadDeps, m: MessageRow): TraceEntry['stages'] {
  const events = deps.events.list(m.id);
  if (events.length > 0) return events.map((e) => ({ ...stamp(e.at), kind: e.kind, label: stageLabel(e.kind), detail: e.detail }));
  return [
    { ...stamp(m.createdAt), kind: 'queued', label: stageLabel('queued'), detail: null },
    ...(m.sentAt === null ? [] : [{ ...stamp(m.sentAt), kind: 'sent', label: stageLabel('sent'), detail: `identyfikatory ${m.miIds.join(', ')}` }]),
    ...(m.finalAt === null ? [] : [{ ...stamp(m.finalAt), kind: 'final', label: stageLabel('final'), detail: statusLabel(m.status) }]),
  ];
}

/** Wiadomość wysłana przez integrację agenta: wprost albo do grupy z połączenia tej integracji. */
export function sentByAgent(deps: Pick<ReadDeps, 'connectionsRepo'>, ctx: ConnectionContext, m: MessageRow): boolean {
  if (m.integrationId === ctx.integration.id) return true;
  return m.agentConnectionId !== null && deps.connectionsRepo.get(m.agentConnectionId)?.integrationId === ctx.integration.id;
}

/** Rozsyłka wysłana przez integrację agenta albo przez połączenie tej integracji, także do grupy; tylko taką agent anuluje. */
export function ownPackage(deps: Pick<ReadDeps, 'connectionsRepo'>, ctx: ConnectionContext, p: PackageRow): boolean {
  if (p.integrationId === ctx.integration.id) return true;
  return p.agentConnectionId !== null && deps.connectionsRepo.get(p.agentConnectionId)?.integrationId === ctx.integration.id;
}

function messageEntry(deps: ReadDeps, ctx: ConnectionContext, m: MessageRow): TraceEntry {
  const agentSent = sentByAgent(deps, ctx, m);
  return {
    kind: 'message', id: m.id, to: m.dest, status: m.status, statusLabel: statusLabel(m.status), source: sourceLabel(deps, m),
    created: stamp(m.createdAt), stages: messageStages(deps, m),
    operator: m.miStatus === null ? null : {
      code: `${m.miStatus}/${m.miSubstatus ?? 0}`, description: describeSubstatus(m.miStatus, m.miSubstatus ?? 0),
    },
    cancellable: ctx.scopes.has('send') && agentSent && BEFORE_NETWORK.has(m.status), agentSent, text: m.body, packageId: null,
    sender: m.orig, serviceId: m.serviceId, encoding: m.encoding, parts: m.parts,
  };
}

/** Stan odbiorcy rozsyłki: z raportu, a bez pozycji w raporcie - oczekiwanie na raport albo jego brak. */
function recipientState(r: RecipientRow, reported: boolean): { status: string; statusLabel: string } {
  if (r.status !== null) return { status: r.status, statusLabel: statusLabel(r.status) };
  return reported ? { status: 'unknown', statusLabel: 'brak w raporcie' } : { status: 'pending', statusLabel: 'czeka na raport' };
}

/** Odbiorca rozsyłki: przyjęcie rozsyłki, jej zakończenie i stan z raportu, bez kodu szczegółowego, którego raport nie zawiera. */
function recipientEntry(deps: ReadDeps, p: PackageRow, r: RecipientRow & { packageId: string }): TraceEntry {
  const stages: TraceEntry['stages'] = [{ ...stamp(p.createdAt), kind: 'package_queued', label: stageLabel('package_queued'), detail: null }];
  if (p.completedAt !== null) {
    const kind = p.status === 'completed' ? 'package_completed' : p.status === 'cancelled' ? 'package_cancelled' : 'package_failed';
    stages.push({ ...stamp(p.completedAt), kind, label: stageLabel(kind), detail: p.status === 'failed' ? p.error : null });
  }
  const changed = reportStamp(r.statusChangedAt);
  if (r.status !== null && changed !== null) {
    stages.push({ ...changed, kind: 'report', label: `${stageLabel('report')}: ${statusLabel(r.status)}`, detail: null });
  }
  return {
    kind: 'package_recipient', id: `${p.id}#${r.seq}`, to: r.dest, ...recipientState(r, p.reportStatus === 'ready'),
    source: sourceLabel(deps, p), created: stamp(p.createdAt), stages, operator: null, cancellable: false, agentSent: false,
    text: r.text ?? p.defaultText, packageId: p.id, sender: p.orig, serviceId: p.serviceId, encoding: p.encoding, parts: null,
  };
}

/**
 * Przebieg doręczenia po identyfikatorze wiadomości albo po numerze i przedziale czasu (domyślnie 7 ostatnich dni),
 * w obrębie wiadomości i odbiorców rozsyłek klucza, do 20 pozycji od najnowszej. Wiadomość innego klucza, systemowa
 * i nieznana dają pustą listę - nie potwierdzamy istnienia.
 */
export function deliveryTrace(deps: ReadDeps, ctx: ConnectionContext, q: { id?: string | undefined; to?: string | undefined; from?: string | undefined; until?: string | undefined }, now: Date): { entries: TraceEntry[] } {
  if (q.id !== undefined) {
    const m = deps.messages.get(q.id);
    if (!m || m.apiKeyId !== ctx.key.id || m.system === 1) return { entries: [] };
    return { entries: [messageEntry(deps, ctx, m)] };
  }
  if (q.to === undefined) throw new AgentError('invalid', 'Podaj identyfikator wiadomości albo numer odbiorcy.');
  const dest = phone(ctx, q.to);
  const from = q.from === undefined ? new Date(now.getTime() - TRACE_WINDOW_MS).toISOString() : instant('from', q.from);
  const until = q.until === undefined ? now.toISOString() : instant('until', q.until, true);

  const messages = deps.messages.list({ apiKeyId: ctx.key.id, dest, from, until, limit: TRACE_MAX, offset: 0 }).map((m) => messageEntry(deps, ctx, m));
  const packages = new Map<string, PackageRow>();
  const recipients = deps.packages.recipientsTo(ctx.key.id, dest, from, until).slice(0, TRACE_MAX).map((r) => {
    let p = packages.get(r.packageId);
    if (!p) {
      p = deps.packages.get(r.packageId)!;
      packages.set(p.id, p);
    }
    return recipientEntry(deps, p, r);
  });
  const entries = [...messages, ...recipients].sort((a, b) => b.created.at.localeCompare(a.created.at)).slice(0, TRACE_MAX);
  return { entries };
}

/**
 * Stan rozsyłki: w trakcie wysyłania postęp z `remaining_count` i stanu Multiinfo, po raporcie liczby w stanach,
 * przyczyny niedoręczeń z liczbami i doręczenia w kolejnych godzinach. Odbiorcy porcjami.
 */
export function packageStatus(deps: ReadDeps, ctx: ConnectionContext, packageId: string, page: Page): PackageStatusData {
  const p = deps.packages.get(packageId);
  if (!p || p.apiKeyId !== ctx.key.id) throw new AgentError('package_unknown', `Nie znaleziono rozsyłki ${packageId}.`);
  const { offset, limit } = pageOf(page);
  const reported = p.reportStatus === 'ready';
  const breakdown = reported ? deps.packages.reportBreakdown(p.id) : null;
  const rows = deps.packages.recipients(p.id, limit + 1, offset);
  return {
    id: p.id, status: p.status, statusLabel: packageStatusLabel(p.status), final: FINAL_PACKAGE.has(p.status),
    recipients: p.recipientsCount, remaining: p.remainingCount, created: stamp(p.createdAt), source: sourceLabel(deps, p),
    report: breakdown === null ? null : {
      byStatus: breakdown.byStatus,
      reasons: breakdown.reasons.map(({ description, count }) => ({ description, count })),
      deliveredByHour: breakdown.deliveredByHour,
    },
    items: rows.slice(0, limit).map((r) => ({
      to: r.dest, clientId: r.clientId, ...recipientState(r, reported), changed: r.status === null ? null : reportStamp(r.statusChangedAt),
    })),
    hasMore: rows.length > limit,
    schedule: p.startAt === null ? null : {
      startAt: stamp(p.startAt), handoverAt: p.status === 'scheduled' ? stamp(handoverAt(p.startAt, p.createdAt)) : null,
    },
    cancellable: (p.status === 'scheduled' || p.status === 'overdue') && (ctx.scopes.has('send') || ctx.scopes.has('send_group')) && ownPackage(deps, ctx, p),
  };
}

/** Rozsyłki klucza od najnowszej, z filtrem stanu i porcjami, na przykład zaplanowane na pytanie „Co mamy zaplanowane?”. */
export function listPackages(deps: ReadDeps, ctx: ConnectionContext, q: { status?: PackageStatus | undefined } & Page): { items: PackageListItem[]; hasMore: boolean } {
  const { offset, limit } = pageOf(q);
  const rows = deps.packages.list({ apiKeyId: ctx.key.id, ...(q.status === undefined ? {} : { statuses: [q.status] }), limit: limit + 1, offset });
  return {
    items: rows.slice(0, limit).map((p) => ({
      id: p.id, status: p.status, statusLabel: packageStatusLabel(p.status), recipients: p.recipientsCount, created: stamp(p.createdAt),
      startAt: p.startAt === null ? null : stamp(p.startAt), source: sourceLabel(deps, p),
    })),
    hasMore: rows.length > limit,
  };
}

/**
 * Kliknięcia ludzi w kolejnych godzinach polskich. Zestawienie godzinowe kampanii zapisuje godziny UTC, więc przy
 * zmianie czasu na zimowy dwie godziny UTC trafiają do tej samej godziny polskiej i sumują się.
 */
function clicksByHour(hours: Array<{ hour: string; clicks: number }>): Array<{ hour: string; clicks: number }> {
  const out = new Map<string, number>();
  for (const h of hours) {
    if (h.clicks === 0) continue;
    const local = `${warsawStamp(`${h.hour}:00:00.000Z`).slice(0, 13)}:00`;
    out.set(local, (out.get(local) ?? 0) + h.clicks);
  }
  return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([hour, clicks]) => ({ hour, clicks }));
}

/**
 * Wyniki kampanii: liczby, otwarcia dzień po dniu z pierwszych otwarć (do końca okresu przechowywania), kliknięcia
 * w kolejnych godzinach (zawsze), cele i odbiorcy bez otwarcia porcjami. Po usunięciu szczegółów zostają kliknięcia.
 */
export function campaignResults(deps: ReadDeps, ctx: ConnectionContext, name: string, page: Page): CampaignResultsData {
  const c = deps.campaigns.byName(ctx.key.id, name);
  if (!c) throw new AgentError('campaign_unknown', `Nie znaleziono kampanii „${name}”.`);
  const { offset, limit } = pageOf(page);
  const purged = c.detailsPurgedAt !== null;
  const opens = countBy(purged ? [] : deps.shortLinks.firstOpens(c.id).map(warsawDay));
  const unopened = purged ? null : deps.shortLinks.recipientsPage(c.id, 'unopened', offset, limit);
  return {
    name: c.name, sent: c.sent, delivered: deps.campaigns.delivered(c.id).delivered, opens: c.opens, clicks: c.clicks, bots: c.bots,
    first: stamp(c.firstSentAt), last: stamp(c.lastSentAt), detailsPurged: purged,
    opensByDay: Object.entries(opens).sort(([a], [b]) => a.localeCompare(b)).map(([day, n]) => ({ day, opens: n })),
    clicksByHour: clicksByHour(deps.campaigns.hours(c.id)),
    targets: groupTargets(deps.campaigns.targets(c.id)),
    unopened: unopened === null ? null : {
      total: unopened.total, items: unopened.items.map((r) => ({ to: r.dest, clientId: r.clientId })), hasMore: unopened.total > offset + limit,
    },
  };
}

/**
 * Wysyłka, na którą odpowiada odebrany SMS: najpóźniejsza wcześniejsza wysyłka klucza do tego numeru, najdalej 7 dni
 * przed odbiorem. Przybliżenie: bramka nie wie, na którą wiadomość abonent odpowiadał.
 */
export function answersTo(deps: Pick<ReadDeps, 'messages' | 'packages'>, apiKeyId: number, row: Pick<InboundRow, 'sender' | 'receivedAt'>): AnswersTo {
  const before = new Date(row.receivedAt);
  const since = new Date(before.getTime() - ANSWER_WINDOW_MS);
  const m = deps.messages.lastToBefore(apiKeyId, row.sender, before, since);
  const p = deps.packages.lastRecipientBefore(apiKeyId, row.sender, before, since);
  if (m && (!p || m.createdAt >= p.createdAt)) return { messageId: m.id };
  return p ? { packageId: p.packageId } : null;
}

/** Pozycja odebranego SMS-a dla agenta: treść tylko dla SMS-a tekstowego, zawsze oznaczona jako od zewnętrznego nadawcy. */
export function inboundItem(r: InboundRow, answer: AnswersTo): InboundItem {
  return { id: r.id, from: r.sender, received: stamp(r.receivedAt), text: r.kind === 'text' ? r.body : null, source: 'external_sender', answersTo: answer };
}

const sameAnswer = (a: AnswersTo, b: NonNullable<AnswersTo>): boolean =>
  a !== null && ('messageId' in b ? 'messageId' in a && a.messageId === b.messageId : 'packageId' in a && a.packageId === b.packageId);

/** Wysyłka z filtra odpowiedzi: jej odbiorcy i okno odpowiedzi; wysyłka innego klucza albo nieznana daje `null`. */
function answerTarget(deps: ReadDeps, ctx: ConnectionContext, q: { answersToPackage?: string | undefined; answersToMessage?: string | undefined }):
  { answer: NonNullable<AnswersTo>; dests: Set<string>; start: string; end: string } | null {
  const window = (start: string) => ({ start, end: new Date(Date.parse(start) + ANSWER_WINDOW_MS).toISOString() });
  if (q.answersToMessage !== undefined) {
    const m = deps.messages.get(q.answersToMessage);
    if (!m || m.apiKeyId !== ctx.key.id || m.system === 1) return null;
    return { answer: { messageId: m.id }, dests: new Set([m.dest]), ...window(m.createdAt) };
  }
  const p = deps.packages.get(q.answersToPackage!);
  if (!p || p.apiKeyId !== ctx.key.id) return null;
  return { answer: { packageId: p.id }, dests: new Set(deps.packages.recipients(p.id).map((r) => r.dest)), ...window(p.createdAt) };
}

/**
 * Odebrane SMS-y konta klucza w usługach klucza, jak `GET /v1/inbound`, bez systemowych. Każda pozycja jest oznaczona
 * jako tekst od zewnętrznego nadawcy i ma przypisaną wysyłkę według `answersTo`. Filtr odpowiedzi na wysyłkę przegląda
 * odebrane z okna 7 dni po wysyłce.
 */
export function listInbound(deps: ReadDeps, ctx: ConnectionContext, q: {
  since?: string | undefined; until?: string | undefined; sender?: string | undefined; answersToPackage?: string | undefined; answersToMessage?: string | undefined;
} & Page): { items: InboundItem[]; hasMore: boolean; until: string | null } {
  if (q.answersToPackage !== undefined && q.answersToMessage !== undefined) {
    throw new AgentError('invalid', 'Podaj jedną wysyłkę: rozsyłkę albo wiadomość.');
  }
  const { offset, limit } = pageOf(q);
  let since = q.since === undefined ? undefined : instant('since', q.since);
  let until = q.until === undefined ? undefined : instant('until', q.until, true);
  // Koniec przedziału podany przez agenta, przed zawężeniem do okna odpowiedzi, dla decyzji o odświeżeniu widoku.
  const requested = until ?? null;
  const sender = q.sender === undefined ? undefined : phone(ctx, q.sender);
  const base = { accountId: ctx.account.id, serviceIds: ctx.auth.allowedServiceIds };

  if (q.answersToPackage === undefined && q.answersToMessage === undefined) {
    const rows = deps.inbound.list({ ...base, ...(sender ? { sender } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}), limit: limit + 1, offset });
    return { items: rows.slice(0, limit).map((r) => inboundItem(r, answersTo(deps, ctx.key.id, r))), hasMore: rows.length > limit, until: requested };
  }

  const target = answerTarget(deps, ctx, q);
  if (target === null || (sender !== undefined && !target.dests.has(sender))) return { items: [], hasMore: false, until: requested };
  since = since === undefined || since < target.start ? target.start : since;
  until = until === undefined || until > target.end ? target.end : until;
  // Jeden odbiorca: zapytanie po nadawcy. Rozsyłka: przegląd odebranych z okna porcjami i wybór odbiorców rozsyłki.
  const only = sender ?? (target.dests.size === 1 ? [...target.dests][0] : undefined);
  const found: InboundItem[] = [];
  let skipped = 0;
  for (let at = 0; found.length <= limit; at += SCAN_BATCH) {
    const rows = deps.inbound.list({ ...base, ...(only ? { sender: only } : {}), since, until, limit: SCAN_BATCH, offset: at });
    for (const r of rows) {
      if (!target.dests.has(r.sender)) continue;
      const answer = answersTo(deps, ctx.key.id, r);
      if (!sameAnswer(answer, target.answer)) continue;
      if (skipped < offset) {
        skipped++;
        continue;
      }
      found.push(inboundItem(r, answer));
      if (found.length > limit) break;
    }
    if (rows.length < SCAN_BATCH) break;
  }
  return { items: found.slice(0, limit), hasMore: found.length > limit, until: requested };
}

