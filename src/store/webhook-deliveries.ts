import type { Database } from 'better-sqlite3';
import { decryptSecret, encryptSecret } from '../secrets/crypto.ts';
import { sha256Hex } from '../text/hash.ts';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface DeliveryRow {
  id: number; apiKeyId: number; event: string; payload: string; url: string;
  attempts: number; nextRetryAt: string | null; status: DeliveryStatus;
  lastResponse: string | null; createdAt: string; deliveredAt: string | null;
  /** Wiadomość przychodząca, której dotyczy dostawa message.received. */
  inboundId: string | null;
  /** Po stanie końcowym treść w payloadzie ma zostać zastąpiona skrótem. */
  scrubAfter: 0 | 1;
  /** Integracja wychodząca, z której pochodzi dostawa; `null` dla webhooka klucza. */
  integrationId: number | null;
  method: string;
  /** Identyfikator zgłoszenia wyciągnięty z odpowiedzi obcej aplikacji. */
  responseRef: string | null;
}

export interface DeliveryInput {
  apiKeyId: number; event: string; payload: string; url: string; createdAt: Date;
  inboundId?: string | null; scrubAfter?: boolean;
  integrationId?: number | null; method?: string;
  /** Nagłówki dostawy integracji; szyfrowane, bo bywa wśród nich token obcej aplikacji. */
  headers?: Record<string, string> | null;
}

interface Raw {
  id: number; api_key_id: number; event: string; payload: string; url: string;
  attempts: number; next_retry_at: string | null; status: DeliveryStatus;
  last_response: string | null; created_at: string; delivered_at: string | null;
  inbound_id: string | null; scrub_after: 0 | 1;
  integration_id: number | null; method: string; response_ref: string | null;
}

const toRow = (r: Raw): DeliveryRow => ({
  id: r.id, apiKeyId: r.api_key_id, event: r.event, payload: r.payload, url: r.url,
  attempts: r.attempts, nextRetryAt: r.next_retry_at, status: r.status,
  lastResponse: r.last_response, createdAt: r.created_at, deliveredAt: r.delivered_at,
  inboundId: r.inbound_id, scrubAfter: r.scrub_after,
  integrationId: r.integration_id, method: r.method, responseRef: r.response_ref,
});

/** Odpowiedź odbiorcy skracamy - w bazie ma zostać diagnoza, nie strona HTML. */
const RESPONSE_CHARS = 300;

/** Kolumna `headers_enc` nie jest tu wymieniona - nagłówki wychodzą z bazy tylko przez `headers()`. */
const COLUMNS = `id, api_key_id, event, payload, url, attempts, next_retry_at, status, last_response, created_at,
  delivered_at, inbound_id, scrub_after, integration_id, method, response_ref`;

export class WebhookDeliveriesRepo {
  constructor(private readonly db: Database, private readonly masterKey: Buffer) {}

  insert(input: DeliveryInput): number {
    const headers = input.headers && Object.keys(input.headers).length > 0
      ? encryptSecret(JSON.stringify(input.headers), this.masterKey) : null;
    const info = this.db
      .prepare(
        `INSERT INTO webhook_deliveries (api_key_id, event, payload, url, created_at, inbound_id, scrub_after, integration_id, method, headers_enc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.apiKeyId, input.event, input.payload, input.url, input.createdAt.toISOString(),
        input.inboundId ?? null, input.scrubAfter ? 1 : 0, input.integrationId ?? null, input.method ?? 'POST', headers,
      );
    return Number(info.lastInsertRowid);
  }

  get(id: number): DeliveryRow | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM webhook_deliveries WHERE id = ?`).get(id) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  /** Nagłówki dostawy integracji jawnie - tylko do wysyłki. Dostawa klucza ma pusty zestaw. */
  headers(id: number): Record<string, string> {
    const row = this.db.prepare('SELECT headers_enc FROM webhook_deliveries WHERE id = ?').get(id) as { headers_enc: string | null } | undefined;
    if (!row?.headers_enc) return {};
    return JSON.parse(decryptSecret(row.headers_enc, this.masterKey)) as Record<string, string>;
  }

  setResponseRef(id: number, ref: string): void {
    this.db.prepare('UPDATE webhook_deliveries SET response_ref = ? WHERE id = ?').run(ref.slice(0, 200), id);
  }

  markRetry(id: number, nextAt: Date, response: string): void {
    this.db
      .prepare('UPDATE webhook_deliveries SET attempts = attempts + 1, next_retry_at = ?, last_response = ? WHERE id = ?')
      .run(nextAt.toISOString(), response.slice(0, RESPONSE_CHARS), id);
  }

  /** Stan końcowy; dostawa ze znacznikiem `scrub_after` traci przy tym treść - nie ma już czego ponawiać. */
  markDelivered(id: number, at: Date, response: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, delivered_at = ?,
             next_retry_at = NULL, last_response = ? WHERE id = ?`,
        )
        .run(at.toISOString(), response.slice(0, RESPONSE_CHARS), id);
      this.scrubIfMarked(id);
    })();
  }

  /** Stan końcowy; jak `markDelivered`. */
  markFailed(id: number, response: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1,
             next_retry_at = NULL, last_response = ? WHERE id = ?`,
        )
        .run(response.slice(0, RESPONSE_CHARS), id);
      this.scrubIfMarked(id);
    })();
  }

  private scrubIfMarked(id: number): void {
    const row = this.db.prepare('SELECT scrub_after FROM webhook_deliveries WHERE id = ?').get(id) as { scrub_after: 0 | 1 } | undefined;
    if (row?.scrub_after === 1) this.scrub(id);
  }

  /**
   * Po zakończeniu dostawy z konta bez przechowywania treści zostaje skrót zamiast treści.
   * Do tej chwili treść musi być w payloadzie, bo ponowienia wysyłają dokładnie to, co podpisano.
   * Body dostawy integracji ma kształt obcej aplikacji - nie wiadomo, gdzie w nim treść, więc
   * znika całe.
   */
  scrub(id: number): void {
    const row = this.get(id);
    if (!row) return;
    if (row.integrationId !== null) {
      this.db.prepare('UPDATE webhook_deliveries SET payload = ?, scrub_after = 0 WHERE id = ?').run('{"scrubbed":true}', id);
      return;
    }
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const content = typeof payload.text === 'string' ? payload.text : typeof payload.hex === 'string' ? payload.hex : null;
    if (content === null) return;
    delete payload.text;
    delete payload.hex;
    payload.bodyHash = sha256Hex(content);
    this.db.prepare('UPDATE webhook_deliveries SET payload = ?, scrub_after = 0 WHERE id = ?').run(JSON.stringify(payload), id);
  }

  /** Nieudana dostawa wraca do kolejki jak nowa: bez prób i bez starej odpowiedzi. */
  requeue(id: number): void {
    this.db
      .prepare(`UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_retry_at = NULL,
                  last_response = NULL, delivered_at = NULL WHERE id = ?`)
      .run(id);
  }

  /** Dostawy zdarzeń o wysyłce (message.sent/delivered/failed) - identyfikator jest w payloadzie. */
  listForMessage(messageId: string): DeliveryRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM webhook_deliveries WHERE inbound_id IS NULL AND json_extract(payload, '$.id') = ? ORDER BY id`)
      .all(messageId) as Raw[];
    return rows.map(toRow);
  }

  listForInbound(inboundId: string): DeliveryRow[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM webhook_deliveries WHERE inbound_id = ? ORDER BY id`).all(inboundId) as Raw[];
    return rows.map(toRow);
  }

  listForIntegration(integrationId: number, limit: number): DeliveryRow[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM webhook_deliveries WHERE integration_id = ? ORDER BY id DESC LIMIT ?`)
      .all(integrationId, limit) as Raw[];
    return rows.map(toRow);
  }

  /**
   * Odebrane, których choć jedna dostawa czeka albo nie udała się od chwili `failedSince` -
   * plakietka przy „Odebrane”. Oczekujące zawsze; nieudane tylko z okna, żeby liczba gasła sama.
   */
  troubledInboundCount(failedSince: Date): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT inbound_id) AS n FROM webhook_deliveries
          WHERE inbound_id IS NOT NULL AND (status = 'pending' OR (status = 'failed' AND created_at >= ?))`,
      )
      .get(failedSince.toISOString()) as { n: number };
    return row.n;
  }

  /** Oczekujące zawsze, nieudane od chwili `failedSince` - jak w `troubledInboundCount`. */
  counts(failedSince: Date): { pending: number; failed: number } {
    const row = this.db
      .prepare(
        `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'failed' AND created_at >= ? THEN 1 ELSE 0 END) AS failed FROM webhook_deliveries`,
      )
      .get(failedSince.toISOString()) as { pending: number | null; failed: number | null };
    return { pending: row.pending ?? 0, failed: row.failed ?? 0 };
  }

  listRecent(limit: number): DeliveryRow[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM webhook_deliveries ORDER BY id DESC LIMIT ?`).all(limit) as Raw[];
    return rows.map(toRow);
  }
}
