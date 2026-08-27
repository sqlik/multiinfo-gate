import type { Database } from 'better-sqlite3';
import type { ProtocolTrace } from '../multiinfo/client.ts';
import type { GatewayStatus } from '../multiinfo/status.ts';

export interface MessageRow {
  id: string; apiKeyId: number; accountId: number; serviceId: string; dest: string;
  body: string | null; bodyHash: string;
  encoding: 'gsm' | 'ucs2'; parts: number; slots: number;
  orig: string | null; costCenter: string | null; validTo: string | null;
  miIds: string[]; status: GatewayStatus;
  miStatus: number | null; miSubstatus: number | null;
  providerCode: number | null; error: string | null;
  idempotencyKey: string | null;
  createdAt: string; sentAt: string | null; finalAt: string | null;
  /** Ślad ostatniego wywołania sendsmslong.aspx; brak przed przekazaniem do Multiinfo. */
  trace: ProtocolTrace | null;
}

export interface MessageInput {
  id: string; apiKeyId: number; accountId: number; serviceId: string; dest: string;
  body: string | null; bodyHash: string;
  encoding: 'gsm' | 'ucs2'; parts: number; slots: number;
  orig: string | null; costCenter: string | null; validTo: string | null;
  idempotencyKey: string | null;
  /** Czas przyjęcia z zegara bramki. Pominięcie oznacza zegar bazy - tylko dla testów. */
  createdAt?: string;
}

export interface MessageFilter {
  apiKeyId?: number; status?: string; dest?: string;
  from?: string; until?: string; limit: number; offset: number;
}

export interface StatusPatch {
  status: GatewayStatus;
  miStatus?: number; miSubstatus?: number;
  providerCode?: number; error?: string | null;
  /** Pominięte = bez zmiany; `null` = wyczyszczenie (wiadomość wraca do stanu nieostatecznego). */
  finalAt?: Date | null;
}

interface RawMessage {
  id: string; api_key_id: number; account_id: number; service_id: string; dest: string;
  body: string | null; body_hash: string;
  encoding: 'gsm' | 'ucs2'; parts: number; slots: number;
  orig: string | null; cost_center: string | null; valid_to: string | null;
  mi_ids: string; status: GatewayStatus;
  mi_status: number | null; mi_substatus: number | null;
  provider_code: number | null; error: string | null;
  idempotency_key: string | null;
  created_at: string; sent_at: string | null; final_at: string | null;
  trace: string | null;
}

/** Statusy, po których wiadomość nie zmieni już stanu i trafia na listę nieudanych. */
const FAILED_STATUSES = ['failed', 'blocked'] as const;

/** Statusy, w których wiadomość jeszcze się przemieszcza: czeka, poszła, jest dławiona. */
export const TRANSIT_STATUSES = ['queued', 'sent', 'throttled'] as const;

function toRow(r: RawMessage): MessageRow {
  return {
    id: r.id,
    apiKeyId: r.api_key_id,
    accountId: r.account_id,
    serviceId: r.service_id,
    dest: r.dest,
    body: r.body,
    bodyHash: r.body_hash,
    encoding: r.encoding,
    parts: r.parts,
    slots: r.slots,
    orig: r.orig,
    costCenter: r.cost_center,
    validTo: r.valid_to,
    miIds: JSON.parse(r.mi_ids) as string[],
    status: r.status,
    miStatus: r.mi_status,
    miSubstatus: r.mi_substatus,
    providerCode: r.provider_code,
    error: r.error,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    finalAt: r.final_at,
    trace: r.trace === null ? null : JSON.parse(r.trace) as ProtocolTrace,
  };
}

export class MessagesRepo {
  constructor(private readonly db: Database) {}

  /**
   * Wykonuje `fn` w jednej transakcji bazy - także zapisy innych repozytoriów na tym
   * samym połączeniu (kolejka, przebieg). Wyjątek wycofuje wszystko.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  insert(input: MessageInput): void {
    this.db
      .prepare(
        `INSERT INTO messages (
           id, api_key_id, account_id, service_id, dest, body, body_hash,
           encoding, parts, slots, orig, cost_center, valid_to, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
      )
      .run(
        input.id,
        input.apiKeyId,
        input.accountId,
        input.serviceId,
        input.dest,
        input.body,
        input.bodyHash,
        input.encoding,
        input.parts,
        input.slots,
        input.orig,
        input.costCenter,
        input.validTo,
        input.idempotencyKey,
        input.createdAt ?? null,
      );
  }

  get(id: string): MessageRow | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as RawMessage | undefined;
    return row ? toRow(row) : undefined;
  }

  /** Buduje warunek wyłącznie z pól obecnych w filtrze - brak pola nie zawęża wyniku. */
  list(filter: MessageFilter): MessageRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filter.apiKeyId !== undefined) {
      where.push('api_key_id = ?');
      params.push(filter.apiKeyId);
    }
    if (filter.status === 'transit') {
      // Zakładka „W drodze” panelu: jeden filtr, trzy statusy.
      where.push(`status IN (${TRANSIT_STATUSES.map(() => '?').join(', ')})`);
      params.push(...TRANSIT_STATUSES);
    } else if (filter.status !== undefined) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.dest !== undefined) {
      where.push('dest = ?');
      params.push(filter.dest);
    }
    if (filter.from !== undefined) {
      where.push('created_at >= ?');
      params.push(filter.from);
    }
    if (filter.until !== undefined) {
      where.push('created_at <= ?');
      params.push(filter.until);
    }

    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM messages${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit, filter.offset) as RawMessage[];
    return rows.map(toRow);
  }

  /**
   * Zapisuje identyfikatory części po przekazaniu do Multiinfo. Anulowania, które przyszło
   * w trakcie wywołania, nie nadpisuje - worker rozstrzyga je osobno, mając już identyfikatory.
   */
  setSent(id: string, miIds: string[], sentAt: Date): void {
    this.db
      .prepare(
        `UPDATE messages SET mi_ids = ?, sent_at = ?, error = NULL,
           status = CASE WHEN status = 'cancelled' THEN status ELSE 'sent' END
         WHERE id = ?`,
      )
      .run(JSON.stringify(miIds), sentAt.toISOString(), id);
  }

  setStatus(id: string, patch: StatusPatch): void {
    this.db
      .prepare(
        `UPDATE messages SET
           status = ?,
           mi_status = COALESCE(?, mi_status),
           mi_substatus = COALESCE(?, mi_substatus),
           provider_code = COALESCE(?, provider_code),
           error = ?,
           final_at = CASE WHEN ? = 1 THEN ? ELSE final_at END
         WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.miStatus ?? null,
        patch.miSubstatus ?? null,
        patch.providerCode ?? null,
        patch.error ?? null,
        patch.finalAt === undefined ? 0 : 1,
        patch.finalAt ? patch.finalAt.toISOString() : null,
        id,
      );
  }

  setTrace(id: string, trace: ProtocolTrace): void {
    this.db.prepare('UPDATE messages SET trace = ? WHERE id = ?').run(JSON.stringify(trace), id);
  }

  findByIdempotencyKey(apiKeyId: number, key: string): MessageRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE api_key_id = ? AND idempotency_key = ?')
      .get(apiKeyId, key) as RawMessage | undefined;
    return row ? toRow(row) : undefined;
  }

  countSince(since: Date): { total: number; delivered: number; failed: number; cancelled: number; transit: number } {
    const failed = FAILED_STATUSES.map(() => '?').join(', ');
    const transit = TRANSIT_STATUSES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN status IN (${failed}) THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
           SUM(CASE WHEN status IN (${transit}) THEN 1 ELSE 0 END) AS transit
         FROM messages WHERE created_at >= ?`,
      )
      .get(...FAILED_STATUSES, ...TRANSIT_STATUSES, since.toISOString()) as {
        total: number; delivered: number | null; failed: number | null;
        cancelled: number | null; transit: number | null;
      };
    return {
      total: row.total, delivered: row.delivered ?? 0, failed: row.failed ?? 0,
      cancelled: row.cancelled ?? 0, transit: row.transit ?? 0,
    };
  }

  recentFailures(limit: number): MessageRow[] {
    const placeholders = FAILED_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE status IN (${placeholders})
          ORDER BY COALESCE(final_at, created_at) DESC LIMIT ?`,
      )
      .all(...FAILED_STATUSES, limit) as RawMessage[];
    return rows.map(toRow);
  }

  /** Liczba wiadomości w drodze - to ona stoi przy „Wiadomości” w nawigacji panelu. */
  inTransitCount(): number {
    const placeholders = TRANSIT_STATUSES.map(() => '?').join(', ');
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE status IN (${placeholders})`)
      .get(...TRANSIT_STATUSES) as { n: number };
    return row.n;
  }
}
