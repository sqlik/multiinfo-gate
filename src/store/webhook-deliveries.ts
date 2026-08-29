import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface DeliveryRow {
  id: number; apiKeyId: number; event: string; payload: string; url: string;
  attempts: number; nextRetryAt: string | null; status: DeliveryStatus;
  lastResponse: string | null; createdAt: string; deliveredAt: string | null;
  /** Wiadomość przychodząca, której dotyczy dostawa message.received. */
  inboundId: string | null;
  /** Po stanie końcowym treść w payloadzie ma zostać zastąpiona skrótem. */
  scrubAfter: 0 | 1;
}

export interface DeliveryInput {
  apiKeyId: number; event: string; payload: string; url: string; createdAt: Date;
  inboundId?: string | null; scrubAfter?: boolean;
}

interface Raw {
  id: number; api_key_id: number; event: string; payload: string; url: string;
  attempts: number; next_retry_at: string | null; status: DeliveryStatus;
  last_response: string | null; created_at: string; delivered_at: string | null;
  inbound_id: string | null; scrub_after: 0 | 1;
}

const toRow = (r: Raw): DeliveryRow => ({
  id: r.id, apiKeyId: r.api_key_id, event: r.event, payload: r.payload, url: r.url,
  attempts: r.attempts, nextRetryAt: r.next_retry_at, status: r.status,
  lastResponse: r.last_response, createdAt: r.created_at, deliveredAt: r.delivered_at,
  inboundId: r.inbound_id, scrubAfter: r.scrub_after,
});

/** Odpowiedź odbiorcy skracamy - w bazie ma zostać diagnoza, nie strona HTML. */
const RESPONSE_CHARS = 300;

export class WebhookDeliveriesRepo {
  constructor(private readonly db: Database) {}

  insert(input: DeliveryInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO webhook_deliveries (api_key_id, event, payload, url, created_at, inbound_id, scrub_after)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.apiKeyId, input.event, input.payload, input.url, input.createdAt.toISOString(),
        input.inboundId ?? null, input.scrubAfter ? 1 : 0,
      );
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

  /**
   * Po zakończeniu dostawy z konta bez przechowywania treści zostaje skrót zamiast treści.
   * Do tej chwili treść musi być w payloadzie, bo ponowienia wysyłają dokładnie to, co podpisano.
   */
  scrub(id: number): void {
    const row = this.get(id);
    if (!row) return;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const content = typeof payload.text === 'string' ? payload.text : typeof payload.hex === 'string' ? payload.hex : null;
    if (content === null) return;
    delete payload.text;
    delete payload.hex;
    payload.bodyHash = createHash('sha256').update(content, 'utf8').digest('hex');
    this.db.prepare('UPDATE webhook_deliveries SET payload = ?, scrub_after = 0 WHERE id = ?').run(JSON.stringify(payload), id);
  }

  listForInbound(inboundId: string): DeliveryRow[] {
    const rows = this.db.prepare('SELECT * FROM webhook_deliveries WHERE inbound_id = ? ORDER BY id').all(inboundId) as Raw[];
    return rows.map(toRow);
  }

  /** Odebrane, których choć jedna dostawa czeka albo się nie udała - plakietka przy „Odebrane”. */
  troubledInboundCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(DISTINCT inbound_id) AS n FROM webhook_deliveries WHERE inbound_id IS NOT NULL AND status IN ('pending', 'failed')`)
      .get() as { n: number };
    return row.n;
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
