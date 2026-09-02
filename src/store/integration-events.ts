import type { Database } from 'better-sqlite3';
import { decryptSecret, encryptSecret } from '../secrets/crypto.ts';

export type EventResult = 'sent' | 'skipped' | 'rejected' | 'throttled' | 'error' | 'delivered' | 'undelivered' | 'duplicate';

export interface IntegrationEventRow {
  id: number; integrationId: number; at: string; result: EventResult; reason: string | null; sourceIp: string | null;
  messageId: string | null; inboundId: string | null; deliveryId: number | null; payload: string | null; response: string | null;
}

export interface IntegrationEventInput {
  integrationId: number; at: Date; result: EventResult; reason?: string; sourceIp?: string; messageId?: string;
  inboundId?: string; deliveryId?: number; payload?: string | null; response?: string;
  /** `eventLogLimit` integracji - wpisy ponad limit znikają przy zapisie. */
  logLimit: number;
}

interface Raw {
  id: number; integration_id: number; at: string; result: EventResult; reason: string | null; source_ip: string | null;
  message_id: string | null; inbound_id: string | null; delivery_id: number | null; payload_enc: string | null; response: string | null;
}

const RESPONSE_CHARS = 300;
const REASON_CHARS = 500;

/** Wyniki liczone jako powodzenie i jako kłopot - te same zestawy w liczniku integracji i kafelku przeglądu. */
export const OK_RESULTS: EventResult[] = ['sent', 'delivered'];
export const TROUBLE_RESULTS: EventResult[] = ['error', 'rejected', 'undelivered', 'throttled'];

export class IntegrationEventsRepo {
  constructor(private readonly db: Database, private readonly masterKey: Buffer) {}

  record(e: IntegrationEventInput): number {
    return this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT INTO integration_events (integration_id, at, result, reason, source_ip, message_id, inbound_id, delivery_id, payload_enc, response)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.integrationId, e.at.toISOString(), e.result, e.reason?.slice(0, REASON_CHARS) ?? null, e.sourceIp ?? null,
        e.messageId ?? null, e.inboundId ?? null, e.deliveryId ?? null,
        e.payload ? encryptSecret(e.payload, this.masterKey) : null, e.response?.slice(0, RESPONSE_CHARS) ?? null);
      this.db.prepare('UPDATE integrations SET last_event_at = ? WHERE id = ?').run(e.at.toISOString(), e.integrationId);
      // Rotacja przy zapisie: dziennik ma stały rozmiar, nie rośnie do sprzątania nocnego.
      this.db.prepare(
        `DELETE FROM integration_events WHERE integration_id = ? AND id NOT IN
           (SELECT id FROM integration_events WHERE integration_id = ? ORDER BY id DESC LIMIT ?)`,
      ).run(e.integrationId, e.integrationId, e.logLimit);
      return Number(info.lastInsertRowid);
    })();
  }

  private toRow(r: Raw): IntegrationEventRow {
    return {
      id: r.id, integrationId: r.integration_id, at: r.at, result: r.result, reason: r.reason, sourceIp: r.source_ip,
      messageId: r.message_id, inboundId: r.inbound_id, deliveryId: r.delivery_id,
      payload: r.payload_enc === null ? null : decryptSecret(r.payload_enc, this.masterKey), response: r.response,
    };
  }

  get(id: number): IntegrationEventRow | undefined {
    const row = this.db.prepare('SELECT * FROM integration_events WHERE id = ?').get(id) as Raw | undefined;
    return row ? this.toRow(row) : undefined;
  }

  list(integrationId: number, limit: number): IntegrationEventRow[] {
    const rows = this.db.prepare('SELECT * FROM integration_events WHERE integration_id = ? ORDER BY id DESC LIMIT ?').all(integrationId, limit) as Raw[];
    return rows.map((r) => this.toRow(r));
  }

  /** Ostatni wpis integracji - do listy w panelu. */
  latest(integrationId: number): IntegrationEventRow | undefined {
    return this.list(integrationId, 1)[0];
  }

  /** Ostatni przechowany ładunek - próbka do „Sprawdź szablon”. */
  latestPayload(integrationId: number): string | null {
    const row = this.db.prepare(
      'SELECT payload_enc FROM integration_events WHERE integration_id = ? AND payload_enc IS NOT NULL ORDER BY id DESC LIMIT 1',
    ).get(integrationId) as { payload_enc: string } | undefined;
    return row ? decryptSecret(row.payload_enc, this.masterKey) : null;
  }

  countsSince(integrationId: number, since: Date): { sent: number; errors: number } {
    const row = this.db.prepare(
      `SELECT SUM(CASE WHEN result IN ('sent', 'delivered') THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN result IN ('error', 'rejected', 'undelivered', 'throttled') THEN 1 ELSE 0 END) AS errors
         FROM integration_events WHERE integration_id = ? AND at >= ?`,
    ).get(integrationId, since.toISOString()) as { sent: number | null; errors: number | null };
    return { sent: row.sent ?? 0, errors: row.errors ?? 0 };
  }

  /** Ładunki starsze niż `at` znikają (7 dni); wpis zostaje. */
  scrubPayloadsBefore(at: Date): number {
    return this.db.prepare('UPDATE integration_events SET payload_enc = NULL WHERE payload_enc IS NOT NULL AND at < ?').run(at.toISOString()).changes;
  }
}
