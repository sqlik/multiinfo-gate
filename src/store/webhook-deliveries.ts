import type { Database } from 'better-sqlite3';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface DeliveryRow {
  id: number; apiKeyId: number; event: string; payload: string; url: string;
  attempts: number; nextRetryAt: string | null; status: DeliveryStatus;
  lastResponse: string | null; createdAt: string; deliveredAt: string | null;
}

export interface DeliveryInput { apiKeyId: number; event: string; payload: string; url: string; createdAt: Date }

interface Raw {
  id: number; api_key_id: number; event: string; payload: string; url: string;
  attempts: number; next_retry_at: string | null; status: DeliveryStatus;
  last_response: string | null; created_at: string; delivered_at: string | null;
}

const toRow = (r: Raw): DeliveryRow => ({
  id: r.id, apiKeyId: r.api_key_id, event: r.event, payload: r.payload, url: r.url,
  attempts: r.attempts, nextRetryAt: r.next_retry_at, status: r.status,
  lastResponse: r.last_response, createdAt: r.created_at, deliveredAt: r.delivered_at,
});

/** Odpowiedź odbiorcy skracamy - w bazie ma zostać diagnoza, nie strona HTML. */
const RESPONSE_CHARS = 300;

export class WebhookDeliveriesRepo {
  constructor(private readonly db: Database) {}

  insert(input: DeliveryInput): number {
    const info = this.db
      .prepare('INSERT INTO webhook_deliveries (api_key_id, event, payload, url, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.apiKeyId, input.event, input.payload, input.url, input.createdAt.toISOString());
    return Number(info.lastInsertRowid);
  }

  get(id: number): DeliveryRow | undefined {
    const row = this.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  markRetry(id: number, nextAt: Date, response: string): void {
    this.db
      .prepare('UPDATE webhook_deliveries SET attempts = attempts + 1, next_retry_at = ?, last_response = ? WHERE id = ?')
      .run(nextAt.toISOString(), response.slice(0, RESPONSE_CHARS), id);
  }

  markDelivered(id: number, at: Date, response: string): void {
    this.db
      .prepare(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, delivered_at = ?,
           next_retry_at = NULL, last_response = ? WHERE id = ?`,
      )
      .run(at.toISOString(), response.slice(0, RESPONSE_CHARS), id);
  }

  markFailed(id: number, response: string): void {
    this.db
      .prepare(
        `UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1,
           next_retry_at = NULL, last_response = ? WHERE id = ?`,
      )
      .run(response.slice(0, RESPONSE_CHARS), id);
  }

  counts(): { pending: number; failed: number } {
    const row = this.db
      .prepare(
        `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM webhook_deliveries`,
      )
      .get() as { pending: number | null; failed: number | null };
    return { pending: row.pending ?? 0, failed: row.failed ?? 0 };
  }

  listRecent(limit: number): DeliveryRow[] {
    const rows = this.db.prepare('SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT ?').all(limit) as Raw[];
    return rows.map(toRow);
  }
}
