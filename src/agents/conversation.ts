import { packageStatusLabel, statusLabel } from '../admin/views/status-labels.ts';
import { AgentError } from '../integrations/agent.ts';
import { sourceLabel } from '../integrations/source-label.ts';
import type { InboundRow } from '../store/inbound-messages.ts';
import type { MessageRow } from '../store/messages.ts';
import type { PackageRow, RecipientRow } from '../store/packages.ts';
import type { ConnectionContext } from './connections.ts';
import { answersTo, instant, phone, recipientState, stamp, type ReadDeps, type Stamp } from './reads.ts';

/**
 * Rozmowa z numerem (spec 6.1): SMS-y odebrane od numeru w usługach klucza oraz wiadomości wysłane przez klucz na ten
 * numer, według czasu. Połączenie bez odczytu wysłanych widzi z wysłanych tylko odpowiedzi i wysyłkę, na którą
 * odpowiada pierwszy odebrany SMS. Rozmowa powstaje z istniejących tabel, bez zmian w bazie.
 */
export const CONVERSATION_WINDOW_MS = 30 * 86_400_000;
export const CONVERSATION_MAX = 100;

export interface ConversationItem {
  kind: 'in' | 'out'; id: string; at: Stamp; text: string | null; stored: boolean;
  status: string | null; statusLabel: string | null; source: string | null; packageId: string | null;
}

export interface ConversationData {
  phone: string; items: ConversationItem[]; hasEarlier: boolean; earliest: string | null; lastInboundId: string | null; sent: 'all' | 'replies';
}

const EPOCH = new Date(0);
/** Stany rozsyłki, w których odbiorca bez pozycji w raporcie nie czeka na raport, więc pozycja podaje stan rozsyłki. */
const PACKAGE_STATE: ReadonlySet<PackageRow['status']> = new Set(['scheduled', 'overdue', 'cancelled', 'failed']);

const iso = (ms: number): string => new Date(ms).toISOString();

/** Odebrany SMS widoczny dla klucza: konto i usługi klucza, bez odpowiedzi na SMS-y powiadomień bramki. */
const visible = (ctx: ConnectionContext, r: InboundRow): boolean =>
  r.system === 0 && r.accountId === ctx.account.id && ctx.auth.allowedServiceIds.includes(r.serviceId);

function inItem(r: InboundRow): ConversationItem {
  return {
    kind: 'in', id: r.id, at: stamp(r.receivedAt), text: r.kind === 'text' ? r.body : null, stored: r.body !== null,
    status: null, statusLabel: null, source: null, packageId: null,
  };
}

function messageItem(deps: ReadDeps, m: MessageRow): ConversationItem {
  return {
    kind: 'out', id: m.id, at: stamp(m.createdAt), text: m.body, stored: m.body !== null,
    status: m.status, statusLabel: statusLabel(m.status), source: sourceLabel(deps, m), packageId: null,
  };
}

function recipientItem(deps: ReadDeps, p: PackageRow, r: RecipientRow): ConversationItem {
  const text = r.text ?? p.defaultText;
  const state = r.status === null && PACKAGE_STATE.has(p.status)
    ? { status: p.status, statusLabel: packageStatusLabel(p.status) }
    : recipientState(r, p.reportStatus === 'ready');
  return { kind: 'out', id: `${p.id}#${r.seq}`, at: stamp(p.createdAt), text, stored: text !== null, ...state, source: sourceLabel(deps, p), packageId: p.id };
}

/** Numer rozmowy z wejścia: nadawca odebranego SMS-a albo podany numer; oba muszą wskazywać ten sam numer. */
function phoneOf(deps: ReadDeps, ctx: ConnectionContext, q: { phone?: string | undefined; inboundId?: string | undefined }): string {
  if (q.inboundId === undefined) {
    if (q.phone === undefined) throw new AgentError('invalid', 'Podaj numer klienta albo identyfikator odebranego SMS-a.');
    return phone(ctx, q.phone);
  }
  const row = deps.inbound.get(q.inboundId);
  if (!row || !visible(ctx, row)) {
    throw new AgentError('inbound_unknown', `Odebrany SMS ${q.inboundId} nie istnieje albo nie należy do usług klucza integracji.`);
  }
  if (q.phone !== undefined && phone(ctx, q.phone) !== row.sender) {
    throw new AgentError('invalid', `Odebrany SMS ${q.inboundId} pochodzi z innego numeru niż podany. Podaj numer albo identyfikator odebranego SMS-a.`);
  }
  return row.sender;
}

/**
 * Rozmowa z numerem. Bez `before` okno obejmuje 30 dni przed chwilą odczytu. Z `before` okno kończy się przed tą
 * chwilą i obejmuje 30 dni przed najnowszym wcześniejszym SMS-em, dzięki czemu przerwa w rozmowie nie daje pustej
 * strony. Wynik zawiera najwyżej 100 najnowszych pozycji okna w kolejności rosnącej, a `earliest` jest wartością
 * `before` dla przycisku „Wcześniejsze”.
 */
export function conversation(deps: ReadDeps, ctx: ConnectionContext, q: { phone?: string | undefined; inboundId?: string | undefined; before?: string | undefined }, now: Date): ConversationData {
  const dest = phoneOf(deps, ctx, q);
  const all = ctx.scopes.has('read_sent');
  const key = ctx.key.id;
  const inboundBase = { accountId: ctx.account.id, serviceIds: ctx.auth.allowedServiceIds, sender: dest };

  /** Chwila najnowszej pozycji rozmowy przed `t`, z wysłanych tylko tych, które połączenie widzi; null, gdy brak. */
  const newestBefore = (t: string): string | null => {
    const until = iso(Date.parse(t) - 1);
    const found = [
      deps.inbound.list({ ...inboundBase, until, limit: 1, offset: 0 })[0]?.receivedAt,
      deps.messages.list({ apiKeyId: key, dest, until, ...(all ? {} : { replies: true }), limit: 1, offset: 0 })[0]?.createdAt,
      all ? deps.packages.lastRecipientBefore(key, dest, new Date(t), EPOCH)?.createdAt : undefined,
    ].filter((v): v is string => v !== undefined);
    return found.length === 0 ? null : found.reduce((a, b) => (a > b ? a : b));
  };

  const empty: ConversationData = { phone: dest, items: [], hasEarlier: false, earliest: null, lastInboundId: null, sent: all ? 'all' : 'replies' };
  let until = now.toISOString();
  let anchor = until;
  if (q.before !== undefined) {
    const before = instant('before', q.before);
    until = iso(Date.parse(before) - 1);
    const newest = newestBefore(before);
    if (newest === null) return empty;
    anchor = newest;
  }
  const since = iso(Date.parse(anchor) - CONVERSATION_WINDOW_MS);
  const limit = CONVERSATION_MAX + 1;

  const received = deps.inbound.list({ ...inboundBase, since, until, limit, offset: 0 });
  const candidates = new Map<string, ConversationItem>(received.map((r) => [r.id, inItem(r)]));
  const add = (item: ConversationItem): void => { if (!candidates.has(item.id)) candidates.set(item.id, item); };
  const packages = new Map<string, PackageRow>();
  const packageOf = (id: string): PackageRow => {
    let p = packages.get(id);
    if (!p) {
      p = deps.packages.get(id)!;
      packages.set(id, p);
    }
    return p;
  };

  for (const m of deps.messages.list({ apiKeyId: key, dest, from: since, until, ...(all ? {} : { replies: true }), limit, offset: 0 })) add(messageItem(deps, m));
  if (all) {
    for (const r of deps.packages.recipientsTo(key, dest, since, until).slice(0, limit)) add(recipientItem(deps, packageOf(r.packageId), r));
  } else {
    // Wysyłka, na którą odpowiada pierwszy odebrany SMS okna: bez niej rozmowa nie pokazuje, od czego się zaczęła.
    const first = received.reduce<InboundRow | null>((a, r) => (a === null || r.receivedAt < a.receivedAt ? r : a), null);
    const answer = first === null ? null : answersTo(deps, key, first);
    if (answer !== null && 'messageId' in answer) {
      add(messageItem(deps, deps.messages.get(answer.messageId)!));
    } else if (answer !== null) {
      const p = packageOf(answer.packageId);
      const r = deps.packages.recipientsTo(key, dest, p.createdAt, p.createdAt).find((x) => x.packageId === p.id);
      if (r) add(recipientItem(deps, p, r));
    }
  }

  const sorted = [...candidates.values()].sort((a, b) => b.at.at.localeCompare(a.at.at) || b.id.localeCompare(a.id));
  const full = sorted.length > CONVERSATION_MAX;
  const items = sorted.slice(0, CONVERSATION_MAX).reverse();
  const oldest = items[0]?.at.at;
  const cursor = full ? oldest! : oldest !== undefined && oldest < since ? oldest : since;
  const hasEarlier = full || newestBefore(cursor) !== null;
  return {
    ...empty, items, hasEarlier, earliest: hasEarlier ? cursor : null,
    lastInboundId: items.findLast((i) => i.kind === 'in')?.id ?? null,
  };
}
