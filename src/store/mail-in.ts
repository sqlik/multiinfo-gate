import type { Database } from './db.ts';

export type MailboxErrorKind = 'auth' | 'network' | 'folder' | 'other';

/** Stan skrzynki pocztowej integracji `mail_in`: jeden wiersz na integrację. */
export interface MailInState {
  integrationId: number;
  uidvalidity: number | null;
  /** Maile o UID nie wyższym niż próg są pomijane (zasada „od teraz”). */
  uidFloor: number;
  /** 1 oznacza: najbliższe odpytanie bierze też zaległe nieprzeczytane. */
  backlog: 0 | 1;
  lastPollAt: string | null;
  lastOkAt: string | null;
  nextPollAt: string;
  error: string | null;
  errorKind: MailboxErrorKind | null;
  errorSince: string | null;
  unseen: number | null;
  notifiedAt: string | null;
  /** Kolejne nieudane odpytania, do odstępu rosnącego. */
  failures: number;
}

export interface SeenKey { messageId: string | null; uidvalidity: number; uid: number }

export type SeenOutcome = 'sent' | 'skipped' | 'failed' | 'throttled';

export type PollRecord =
  | { ok: true; uidvalidity: number; unseen: number; at: Date; nextPollAt: Date }
  | { ok: false; error: string; errorKind: MailboxErrorKind; at: Date; nextPollAt: Date };

interface StateRow {
  integration_id: number; uidvalidity: number | null; uid_floor: number; backlog: number;
  last_poll_at: string | null; last_ok_at: string | null; next_poll_at: string;
  error: string | null; error_kind: string | null; error_since: string | null;
  unseen: number | null; notified_at: string | null; failures: number;
}

const toState = (r: StateRow): MailInState => ({
  integrationId: r.integration_id,
  uidvalidity: r.uidvalidity,
  uidFloor: r.uid_floor,
  backlog: r.backlog === 1 ? 1 : 0,
  lastPollAt: r.last_poll_at,
  lastOkAt: r.last_ok_at,
  nextPollAt: r.next_poll_at,
  error: r.error,
  errorKind: r.error_kind as MailboxErrorKind | null,
  errorSince: r.error_since,
  unseen: r.unseen,
  notifiedAt: r.notified_at,
  failures: r.failures,
});

/** Wiersze stanu istnieją wyłącznie dla integracji rodzaju mail_in, więc złączenie filtruje tylko po włączeniu. */
const ENABLED_JOIN = 'FROM mail_in_state s JOIN integrations i ON i.id = s.integration_id WHERE i.enabled = 1';

/** Stan skrzynek pocztowych oraz rejestr maili, które bramka już wzięła pod uwagę. */
export class MailInRepo {
  constructor(private readonly db: Database) {}

  ensureState(integrationId: number, now: Date): void {
    this.db.prepare('INSERT OR IGNORE INTO mail_in_state (integration_id, next_poll_at) VALUES (?, ?)').run(integrationId, now.toISOString());
  }

  /** Wiersz stanu dla każdej integracji mail_in, która go nie ma (założonej poza formularzem); zwraca liczbę dodanych. */
  ensureAll(now: Date): number {
    return this.db.prepare("INSERT OR IGNORE INTO mail_in_state (integration_id, next_poll_at) SELECT id, ? FROM integrations WHERE kind = 'mail_in'").run(now.toISOString()).changes;
  }

  state(integrationId: number): MailInState | undefined {
    const row = this.db.prepare('SELECT * FROM mail_in_state WHERE integration_id = ?').get(integrationId) as StateRow | undefined;
    return row ? toState(row) : undefined;
  }

  /** Identyfikatory włączonych integracji z terminem odpytania nie późniejszym niż teraz, najstarszy termin pierwszy. */
  due(now: Date): number[] {
    const rows = this.db.prepare(`SELECT s.integration_id ${ENABLED_JOIN} AND s.next_poll_at <= ? ORDER BY s.next_poll_at, s.integration_id`).all(now.toISOString()) as Array<{ integration_id: number }>;
    return rows.map((r) => r.integration_id);
  }

  recordPoll(integrationId: number, r: PollRecord): void {
    if (r.ok) {
      this.db.prepare(
        `UPDATE mail_in_state SET failures = 0, error = NULL, error_kind = NULL, error_since = NULL, notified_at = NULL,
           last_ok_at = ?, last_poll_at = ?, unseen = ?, uidvalidity = ?, next_poll_at = ? WHERE integration_id = ?`,
      ).run(r.at.toISOString(), r.at.toISOString(), r.unseen, r.uidvalidity, r.nextPollAt.toISOString(), integrationId);
      return;
    }
    this.db.prepare(
      `UPDATE mail_in_state SET failures = failures + 1, error = ?, error_kind = ?, error_since = COALESCE(error_since, ?),
         last_poll_at = ?, next_poll_at = ? WHERE integration_id = ?`,
    ).run(r.error, r.errorKind, r.at.toISOString(), r.at.toISOString(), r.nextPollAt.toISOString(), integrationId);
  }

  setFloor(integrationId: number, uidFloor: number, uidvalidity: number): void {
    this.db.prepare('UPDATE mail_in_state SET uid_floor = ?, uidvalidity = ? WHERE integration_id = ?').run(uidFloor, uidvalidity, integrationId);
  }

  setBacklog(integrationId: number, backlog: 0 | 1): void {
    this.db.prepare('UPDATE mail_in_state SET backlog = ? WHERE integration_id = ?').run(backlog, integrationId);
  }

  pollNow(integrationId: number, now: Date): void {
    this.db.prepare('UPDATE mail_in_state SET next_poll_at = ? WHERE integration_id = ?').run(now.toISOString(), integrationId);
  }

  markNotified(integrationId: number, at: Date): void {
    this.db.prepare('UPDATE mail_in_state SET notified_at = ? WHERE integration_id = ?').run(at.toISOString(), integrationId);
  }

  /** Włączone skrzynki z trwającym błędem. */
  failing(): MailInState[] {
    const rows = this.db.prepare(`SELECT s.* ${ENABLED_JOIN} AND s.error IS NOT NULL ORDER BY s.error_since`).all() as StateRow[];
    return rows.map(toState);
  }

  /** Liczba włączonych skrzynek oraz tych w błędzie. */
  counts(): { total: number; failing: number } {
    const row = this.db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN s.error IS NOT NULL THEN 1 ELSE 0 END) AS failing ${ENABLED_JOIN}`).get() as { total: number; failing: number | null };
    return { total: row.total, failing: row.failing ?? 0 };
  }

  /** Czy mail był już brany pod uwagę: po Message-ID albo po parze UIDVALIDITY i UID. */
  seen(integrationId: number, key: SeenKey): boolean {
    const byUid = this.db.prepare('SELECT 1 FROM mail_in_seen WHERE integration_id = ? AND uidvalidity = ? AND uid = ?').get(integrationId, key.uidvalidity, key.uid);
    if (byUid) return true;
    if (key.messageId === null) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM mail_in_seen WHERE integration_id = ? AND message_id = ?').get(integrationId, key.messageId));
  }

  /** Zapis przed wysyłką; powtórny zapis tej samej pary UID jest pomijany. */
  remember(integrationId: number, key: SeenKey, outcome: SeenOutcome, at: Date): void {
    this.db.prepare('INSERT OR IGNORE INTO mail_in_seen (integration_id, message_id, uidvalidity, uid, at, outcome) VALUES (?, ?, ?, ?, ?, ?)')
      .run(integrationId, key.messageId, key.uidvalidity, key.uid, at.toISOString(), outcome);
  }

  /** Wynik po przetworzeniu: wiersz powstaje przed wysyłką jako `skipped`, tu dostaje właściwy wynik. */
  setOutcome(integrationId: number, key: SeenKey, outcome: SeenOutcome): void {
    this.db.prepare('UPDATE mail_in_seen SET outcome = ? WHERE integration_id = ? AND uidvalidity = ? AND uid = ?').run(outcome, integrationId, key.uidvalidity, key.uid);
  }

  /** Wyniki zapamiętanych maili integracji, rosnąco po UID; do testów i diagnostyki. */
  outcomes(integrationId: number): Array<{ uid: number; outcome: SeenOutcome }> {
    return this.db.prepare('SELECT uid, outcome FROM mail_in_seen WHERE integration_id = ? ORDER BY uidvalidity, uid').all(integrationId) as Array<{ uid: number; outcome: SeenOutcome }>;
  }

  /** Sprzątanie w turze utrzymaniowej; zwraca liczbę usuniętych wierszy. */
  pruneSeenBefore(at: Date): number {
    return this.db.prepare('DELETE FROM mail_in_seen WHERE at < ?').run(at.toISOString()).changes;
  }
}
