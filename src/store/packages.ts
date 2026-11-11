import type { Database } from 'better-sqlite3';
import type { ReportRow } from '../multiinfo/report.ts';
import { mapStatus, type GatewayStatus } from '../multiinfo/status.ts';

export type PackageStatus = 'queued' | 'open' | 'sending' | 'completed' | 'cancelled' | 'failed';
export type ReportStatus = 'none' | 'pending' | 'ready' | 'failed';

export interface PackageRow {
  id: string; apiKeyId: number; accountId: number; serviceId: string;
  defaultText: string | null; orig: string | null; costCenter: string | null; startAt: string | null;
  deliveryReport: 0 | 1; encoding: 'gsm' | 'ucs2'; multipart: 0 | 1;
  miPackageId: string | null; recipientsCount: number; remainingCount: number | null; miStatus: number | null;
  status: PackageStatus; providerCode: number | null; error: string | null;
  reportStatus: ReportStatus; reportId: string | null; reportExpiresAt: string | null; reportPath: string | null;
  createdAt: string; completedAt: string | null;
  /** Integracja z Power Automate, która zleciła rozsyłkę; `null` dla żądań z API. */
  integrationId: number | null;
  /** Zlecający z przepływu Power Automate; `null` dla pozostałych źródeł. */
  requestedBy: string | null;
  /** Klucz idempotencji z nagłówka `Idempotency-Key` i skrót żądania, z którym go użyto. */
  idempotencyKey: string | null;
  requestHash: string | null;
  /** Kampania skracacza; tylko rozsyłki z co najmniej jednym krótkim linkiem. */
  campaignId: number | null;
}

export interface PackageInput {
  id: string; apiKeyId: number; accountId: number; serviceId: string;
  defaultText: string | null; orig: string | null; costCenter: string | null; startAt: string | null;
  deliveryReport: 0 | 1; encoding: 'gsm' | 'ucs2'; multipart: 0 | 1; createdAt: string;
  integrationId?: number | null; requestedBy?: string | null; idempotencyKey?: string | null; requestHash?: string | null;
  campaignId?: number | null;
}

export interface RecipientInput {
  dest: string; text: string | null; clientId: string | null;
  /** Liczba krótkich kodów w treści odbiorcy; pominięcie oznacza 0. */
  links?: number;
}

export interface RecipientRow extends RecipientInput {
  links: number;
  seq: number; miId: string | null; miStatus: number | null;
  status: GatewayStatus | null; statusChangedAt: string | null;
}

export interface PackageFilter { apiKeyId?: number; limit: number; offset: number }

export interface ReportPatch {
  status: ReportStatus; reportId?: string | null; expiresAt?: string | null; path?: string | null;
}

interface Raw {
  id: string; api_key_id: number; account_id: number; service_id: string;
  default_text: string | null; orig: string | null; cost_center: string | null; start_at: string | null;
  delivery_report: 0 | 1; encoding: 'gsm' | 'ucs2'; multipart: 0 | 1;
  mi_package_id: string | null; recipients_count: number; remaining_count: number | null; mi_status: number | null;
  status: PackageStatus; provider_code: number | null; error: string | null;
  report_status: ReportStatus; report_id: string | null; report_expires_at: string | null; report_path: string | null;
  created_at: string; completed_at: string | null; integration_id: number | null; requested_by: string | null;
  idempotency_key: string | null; request_hash: string | null; campaign_id: number | null;
}

interface RawRecipient {
  seq: number; dest: string; text: string | null; client_id: string | null; mi_id: string | null;
  mi_status: number | null; status: GatewayStatus | null; status_changed_at: string | null; links: number;
}

function toRow(r: Raw): PackageRow {
  return {
    id: r.id, apiKeyId: r.api_key_id, accountId: r.account_id, serviceId: r.service_id,
    defaultText: r.default_text, orig: r.orig, costCenter: r.cost_center, startAt: r.start_at,
    deliveryReport: r.delivery_report, encoding: r.encoding, multipart: r.multipart,
    miPackageId: r.mi_package_id, recipientsCount: r.recipients_count, remainingCount: r.remaining_count,
    miStatus: r.mi_status, status: r.status, providerCode: r.provider_code, error: r.error,
    reportStatus: r.report_status, reportId: r.report_id, reportExpiresAt: r.report_expires_at,
    reportPath: r.report_path, createdAt: r.created_at, completedAt: r.completed_at,
    integrationId: r.integration_id, requestedBy: r.requested_by,
    idempotencyKey: r.idempotency_key, requestHash: r.request_hash, campaignId: r.campaign_id,
  };
}

const toRecipient = (r: RawRecipient): RecipientRow => ({
  seq: r.seq, dest: r.dest, text: r.text, clientId: r.client_id, miId: r.mi_id,
  miStatus: r.mi_status, status: r.status, statusChangedAt: r.status_changed_at, links: r.links,
});

/** Statusy odbiorcy liczone w podsumowaniu jako nieudane. */
const FAILED_STATUSES: GatewayStatus[] = ['failed', 'blocked', 'expired', 'cancelled'];

/**
 * Raport rozsyłki nie niesie substatusu. Według §2.9 status 21 w raporcie oznacza
 * wiadomość doręczoną, więc dla niego przyjmujemy substatus 1 - inaczej `mapStatus`
 * uznałby każdą doręczoną za „wysłaną bez potwierdzenia”.
 */

export class PackagesRepo {
  constructor(private readonly db: Database) {}

  /** Zapis rozsyłki i dodanie zadania w jednej transakcji: przerwanie nie zostawia rozsyłki bez zadania. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Rozsyłki utworzone od `since` we wszystkich stanach i suma ich odbiorców, czyli liczba SMS-ów. */
  countSince(since: Date): { packages: number; recipients: number } {
    const row = this.db
      .prepare('SELECT COUNT(*) AS packages, COALESCE(SUM(recipients_count), 0) AS recipients FROM packages WHERE created_at >= ?')
      .get(since.toISOString()) as { packages: number; recipients: number };
    return { packages: row.packages, recipients: row.recipients };
  }

  findByIdempotencyKey(apiKeyId: number, key: string): PackageRow | undefined {
    const row = this.db.prepare('SELECT * FROM packages WHERE api_key_id = ? AND idempotency_key = ?').get(apiKeyId, key) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  insert(input: PackageInput, recipients: RecipientInput[]): void {
    const create = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO packages (id, api_key_id, account_id, service_id, default_text, orig, cost_center, start_at,
           delivery_report, encoding, multipart, recipients_count, created_at, integration_id, requested_by,
           idempotency_key, request_hash, campaign_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.apiKeyId, input.accountId, input.serviceId, input.defaultText, input.orig,
        input.costCenter, input.startAt, input.deliveryReport, input.encoding, input.multipart,
        recipients.length, input.createdAt, input.integrationId ?? null, input.requestedBy ?? null,
        input.idempotencyKey ?? null, input.requestHash ?? null, input.campaignId ?? null);
      const add = this.db.prepare(
        'INSERT INTO package_recipients (package_id, seq, dest, text, client_id, links) VALUES (?, ?, ?, ?, ?, ?)');
      recipients.forEach((r, i) => add.run(input.id, i + 1, r.dest, r.text, r.clientId, r.links ?? 0));
    });
    create();
  }

  get(id: string): PackageRow | undefined {
    const row = this.db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  list(filter: PackageFilter): PackageRow[] {
    const where = filter.apiKeyId === undefined ? '' : ' WHERE api_key_id = ?';
    const params: number[] = filter.apiKeyId === undefined ? [] : [filter.apiKeyId];
    const rows = this.db
      .prepare(`SELECT * FROM packages${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit, filter.offset) as Raw[];
    return rows.map(toRow);
  }

  recipients(id: string, limit = 100_000): RecipientRow[] {
    const rows = this.db
      .prepare('SELECT * FROM package_recipients WHERE package_id = ? ORDER BY seq LIMIT ?')
      .all(id, limit) as RawRecipient[];
    return rows.map(toRecipient);
  }

  setCreated(id: string, miPackageId: string): void {
    this.db
      .prepare("UPDATE packages SET mi_package_id = ?, status = 'open', mi_status = 1, error = NULL WHERE id = ?")
      .run(miPackageId, id);
  }

  setProgress(id: string, patch: { remaining: number | null; miStatus: number; status: PackageStatus }): void {
    this.db
      .prepare('UPDATE packages SET remaining_count = ?, mi_status = ?, status = ? WHERE id = ?')
      .run(patch.remaining, patch.miStatus, patch.status, id);
  }

  setCompleted(id: string, at: Date): void {
    this.db
      .prepare("UPDATE packages SET status = 'completed', remaining_count = 0, completed_at = ? WHERE id = ?")
      .run(at.toISOString(), id);
  }

  setCancelled(id: string, at: Date): void {
    this.db
      .prepare("UPDATE packages SET status = 'cancelled', completed_at = ? WHERE id = ?")
      .run(at.toISOString(), id);
  }

  setFailed(id: string, providerCode: number | null, error: string, at: Date): void {
    this.db
      .prepare("UPDATE packages SET status = 'failed', provider_code = ?, error = ?, completed_at = ? WHERE id = ?")
      .run(providerCode, error, at.toISOString(), id);
  }

  /** Pola pominięte w łacie zachowują dotychczasową wartość. */
  setReport(id: string, patch: ReportPatch): void {
    this.db
      .prepare(
        `UPDATE packages SET report_status = ?, report_id = COALESCE(?, report_id),
           report_expires_at = COALESCE(?, report_expires_at), report_path = COALESCE(?, report_path) WHERE id = ?`,
      )
      .run(patch.status, patch.reportId ?? null, patch.expiresAt ?? null, patch.path ?? null, id);
  }

  /**
   * Dopasowanie po numerze i identyfikatorze klienta. Wiersz z identyfikatorem pasuje tylko
   * do odbiorcy z tym samym; wiersz bez identyfikatora - do odbiorcy bez identyfikatora
   * o tym numerze, a gdy takiego nie ma (raport bez kolumny identyfikatora), do jednego
   * jeszcze niedopasowanego odbiorcy o tym numerze. Ten sam numer bywa w rozsyłce wiele
   * razy z różnymi identyfikatorami i każdy wiersz raportu ma własny `Id`, więc wiersz
   * bez identyfikatora nie może nadpisywać wszystkich. Wiersz bez dopasowania jest pomijany.
   */
  applyReport(id: string, rows: ReportRow[]): void {
    const set = 'UPDATE package_recipients SET mi_id = ?, mi_status = ?, status = ?, status_changed_at = ?';
    const byClientId = this.db.prepare(`${set} WHERE package_id = ? AND dest = ? AND client_id = ?`);
    const withoutClientId = this.db.prepare(`${set} WHERE package_id = ? AND dest = ? AND client_id IS NULL`);
    const firstUnmatched = this.db.prepare(
      `${set} WHERE rowid = (
         SELECT rowid FROM package_recipients WHERE package_id = ? AND dest = ? AND mi_id IS NULL ORDER BY seq LIMIT 1
       )`,
    );
    const apply = this.db.transaction(() => {
      for (const r of rows) {
        const values = [r.miId, r.miStatus, r.status, r.changedAt, id, r.dest] as const;
        if (r.clientId !== null) {
          byClientId.run(...values, r.clientId);
          continue;
        }
        if (withoutClientId.run(...values).changes === 0) firstUnmatched.run(...values);
      }
    });
    apply();
  }

  recipientSummary(id: string): { delivered: number; failed: number; other: number } {
    const placeholders = FAILED_STATUSES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN status IN (${placeholders}) THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status IS NULL OR status NOT IN ('delivered', ${placeholders}) THEN 1 ELSE 0 END) AS other
         FROM package_recipients WHERE package_id = ?`,
      )
      .get(...FAILED_STATUSES, ...FAILED_STATUSES, id) as
        { delivered: number | null; failed: number | null; other: number | null };
    return { delivered: row.delivered ?? 0, failed: row.failed ?? 0, other: row.other ?? 0 };
  }

  /** Treści to dane osobowe - konto bez `store_content` nie zostawia ich po przekazaniu do Multiinfo. */
  clearTexts(id: string): void {
    const clear = this.db.transaction(() => {
      this.db.prepare('UPDATE packages SET default_text = NULL WHERE id = ?').run(id);
      this.db.prepare('UPDATE package_recipients SET text = NULL WHERE package_id = ?').run(id);
    });
    clear();
  }
}
