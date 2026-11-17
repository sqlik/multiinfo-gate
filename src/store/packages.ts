import type { Database } from 'better-sqlite3';
import type { ReportRow } from '../multiinfo/report.ts';
import { describeReportStatus, mapStatus, type GatewayStatus } from '../multiinfo/status.ts';

export type PackageStatus = 'scheduled' | 'overdue' | 'queued' | 'open' | 'sending' | 'completed' | 'cancelled' | 'failed';
/** Rozsyłki przechowywane przez bramkę przed przekazaniem do Multiinfo. */
export const PENDING_STATUSES: ReadonlySet<PackageStatus> = new Set(['scheduled', 'overdue']);
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
  /** Zlecający z przepływu Power Automate albo nazwa połączenia agenta AI; `null` dla pozostałych źródeł. */
  requestedBy: string | null;
  /** Połączenie agenta AI, które zleciło rozsyłkę; `null` dla pozostałych źródeł i po usunięciu połączenia. */
  agentConnectionId: number | null;
  /** Klucz idempotencji z nagłówka `Idempotency-Key` i skrót żądania, z którym go użyto. */
  idempotencyKey: string | null;
  requestHash: string | null;
  /** Kampania skracacza; tylko rozsyłki z co najmniej jednym krótkim linkiem. */
  campaignId: number | null;
  /** 1 dla nadpisu podanego jawnie, 0 dla nadpisu domyślnego klucza albo konta. */
  origExplicit: 0 | 1;
  /** Wysyłka z pliku, której częścią jest rozsyłka; `null` dla pozostałych rozsyłek. */
  fileSendId: string | null;
}

export interface PackageInput {
  id: string; apiKeyId: number; accountId: number; serviceId: string;
  defaultText: string | null; orig: string | null; costCenter: string | null; startAt: string | null;
  deliveryReport: 0 | 1; encoding: 'gsm' | 'ucs2'; multipart: 0 | 1; createdAt: string;
  integrationId?: number | null; requestedBy?: string | null; idempotencyKey?: string | null; requestHash?: string | null;
  campaignId?: number | null; agentConnectionId?: number | null; origExplicit?: 0 | 1; fileSendId?: string | null;
  /** Stan początkowy: `scheduled` dla rozsyłki z terminem, domyślnie `queued`. */
  status?: PackageStatus;
}

export interface RecipientInput {
  dest: string; text: string | null; clientId: string | null;
  /** Liczba krótkich kodów w treści odbiorcy; pominięcie oznacza 0. */
  links?: number;
  /** Numer wiersza w pliku wysyłki z pliku; pominięcie oznacza odbiorcę spoza pliku. */
  fileLine?: number | null;
}

export interface RecipientRow extends RecipientInput {
  links: number;
  fileLine: number | null;
  seq: number; miId: string | null; miStatus: number | null;
  status: GatewayStatus | null; statusChangedAt: string | null;
}

export interface PackageFilter { apiKeyId?: number; statuses?: PackageStatus[]; limit: number; offset: number }

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
  idempotency_key: string | null; request_hash: string | null; campaign_id: number | null; agent_connection_id: number | null;
  orig_explicit: 0 | 1; file_send_id: string | null;
}

interface RawRecipient {
  seq: number; dest: string; text: string | null; client_id: string | null; mi_id: string | null;
  mi_status: number | null; status: GatewayStatus | null; status_changed_at: string | null; links: number; file_line: number | null;
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
    integrationId: r.integration_id, requestedBy: r.requested_by, agentConnectionId: r.agent_connection_id,
    idempotencyKey: r.idempotency_key, requestHash: r.request_hash, campaignId: r.campaign_id, origExplicit: r.orig_explicit,
    fileSendId: r.file_send_id,
  };
}

const toRecipient = (r: RawRecipient): RecipientRow => ({
  seq: r.seq, dest: r.dest, text: r.text, clientId: r.client_id, miId: r.mi_id,
  miStatus: r.mi_status, status: r.status, statusChangedAt: r.status_changed_at, links: r.links, fileLine: r.file_line,
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
           idempotency_key, request_hash, campaign_id, agent_connection_id, status, orig_explicit, file_send_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.apiKeyId, input.accountId, input.serviceId, input.defaultText, input.orig,
        input.costCenter, input.startAt, input.deliveryReport, input.encoding, input.multipart,
        recipients.length, input.createdAt, input.integrationId ?? null, input.requestedBy ?? null,
        input.idempotencyKey ?? null, input.requestHash ?? null, input.campaignId ?? null, input.agentConnectionId ?? null,
        input.status ?? 'queued', input.origExplicit ?? 0, input.fileSendId ?? null);
      const add = this.db.prepare(
        'INSERT INTO package_recipients (package_id, seq, dest, text, client_id, links, file_line) VALUES (?, ?, ?, ?, ?, ?, ?)');
      recipients.forEach((r, i) => add.run(input.id, i + 1, r.dest, r.text, r.clientId, r.links ?? 0, r.fileLine ?? null));
    });
    create();
  }

  get(id: string): PackageRow | undefined {
    const row = this.db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  /** Rozsyłki wysyłki z pliku w kolejności utworzenia, czyli w kolejności pierwszych odbiorców w pliku. */
  listByFileSend(fileSendId: string): PackageRow[] {
    return (this.db.prepare('SELECT * FROM packages WHERE file_send_id = ? ORDER BY rowid').all(fileSendId) as Raw[]).map(toRow);
  }

  /** Pusta lista stanów oznacza wszystkie stany. */
  list(filter: PackageFilter): PackageRow[] {
    const conditions: string[] = [];
    const params: Array<number | string> = [];
    if (filter.apiKeyId !== undefined) {
      conditions.push('api_key_id = ?');
      params.push(filter.apiKeyId);
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      conditions.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
    const rows = this.db
      .prepare(`SELECT * FROM packages${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit, filter.offset) as Raw[];
    return rows.map(toRow);
  }

  countByStatus(status: PackageStatus): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM packages WHERE status = ?').get(status) as { n: number }).n;
  }

  /**
   * Zaplanowane i spóźnione rozsyłki integracji, na przykład przed jej usunięciem. Rozsyłka agenta do grupy ma
   * w `integration_id` grupę, dlatego integrację agenta obejmują także rozsyłki zlecone przez jej połączenia.
   */
  pendingOfIntegration(integrationId: number): PackageRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM packages
        WHERE (integration_id = ? OR agent_connection_id IN (SELECT id FROM agent_connections WHERE integration_id = ?))
          AND status IN ('scheduled', 'overdue') ORDER BY start_at, id`)
      .all(integrationId, integrationId) as Raw[];
    return rows.map(toRow);
  }

  /** Integracja agenta, którego połączenie zleciło rozsyłkę; `null` dla rozsyłki spoza agenta albo po usunięciu połączenia. */
  agentIntegrationOf(id: string): number | null {
    const row = this.db
      .prepare('SELECT c.integration_id AS integrationId FROM packages p JOIN agent_connections c ON c.id = p.agent_connection_id WHERE p.id = ?')
      .get(id) as { integrationId: number } | undefined;
    return row?.integrationId ?? null;
  }

  /*
   * Przejścia rozsyłki przechowywanej przez bramkę. Każde zmienia stan wyłącznie z oczekiwanego stanu
   * i zwraca, czy się powiodło, dlatego anulowanie i przekazanie w tej samej chwili nie mogą powieść się oba.
   */

  /** `scheduled → queued` tuż przed żądaniem `package.aspx`. */
  beginHandover(id: string): boolean {
    return this.db.prepare("UPDATE packages SET status = 'queued' WHERE id = ? AND status = 'scheduled'").run(id).changes === 1;
  }

  /**
   * `queued → scheduled`, gdy żądanie przekazania nie dotarło do Multiinfo. Wraca wyłącznie rozsyłka z terminem,
   * a rozsyłka z identyfikatorem Multiinfo nie wraca nigdy.
   */
  returnToScheduled(id: string): boolean {
    return this.db
      .prepare("UPDATE packages SET status = 'scheduled' WHERE id = ? AND status = 'queued' AND start_at IS NOT NULL AND mi_package_id IS NULL")
      .run(id).changes === 1;
  }

  /** `scheduled → overdue` dla rozsyłek z terminem wcześniejszym niż `startedBefore`; zwraca przeniesione rozsyłki. */
  markOverdue(startedBefore: Date): PackageRow[] {
    const rows = this.db
      .prepare("UPDATE packages SET status = 'overdue' WHERE status = 'scheduled' AND start_at < ? RETURNING *")
      .all(startedBefore.toISOString()) as Raw[];
    return rows.map(toRow).sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? '') || a.id.localeCompare(b.id));
  }

  /** `scheduled|overdue → cancelled` z chwilą zakończenia i powodem w polu `error`. */
  cancelPending(id: string, at: Date, reason: string | null): boolean {
    return this.db
      .prepare("UPDATE packages SET status = 'cancelled', completed_at = ?, error = ? WHERE id = ? AND status IN ('scheduled', 'overdue')")
      .run(at.toISOString(), reason, id).changes === 1;
  }

  /** `overdue → queued` po decyzji administratora „Wyślij teraz”. */
  sendNow(id: string): boolean {
    return this.db.prepare("UPDATE packages SET status = 'queued' WHERE id = ? AND status = 'overdue'").run(id).changes === 1;
  }

  recipients(id: string, limit = 100_000, offset = 0): RecipientRow[] {
    const rows = this.db
      .prepare('SELECT * FROM package_recipients WHERE package_id = ? ORDER BY seq LIMIT ? OFFSET ?')
      .all(id, limit, offset) as RawRecipient[];
    return rows.map(toRecipient);
  }

  /** Odbiorcy rozsyłek klucza o tym numerze, z rozsyłek utworzonych w przedziale, od najnowszej rozsyłki. */
  recipientsTo(apiKeyId: number, dest: string, from: string, until: string): Array<RecipientRow & { packageId: string }> {
    const rows = this.db
      .prepare(`SELECT r.*, r.package_id AS package_id FROM package_recipients r JOIN packages p ON p.id = r.package_id
                WHERE p.api_key_id = ? AND p.created_at >= ? AND p.created_at <= ? AND r.dest = ?
                ORDER BY p.created_at DESC, p.id DESC, r.seq`)
      .all(apiKeyId, from, until, dest) as Array<RawRecipient & { package_id: string }>;
    return rows.map((r) => ({ ...toRecipient(r), packageId: r.package_id }));
  }

  /** Najpóźniejsza rozsyłka klucza do tego numeru utworzona przed `before`, nie wcześniej niż `since`. */
  lastRecipientBefore(apiKeyId: number, dest: string, before: Date, since: Date): { packageId: string; createdAt: string } | undefined {
    const row = this.db
      .prepare(`SELECT p.id AS package_id, p.created_at AS created_at FROM packages p
                WHERE p.api_key_id = ? AND p.created_at < ? AND p.created_at >= ?
                  AND EXISTS (SELECT 1 FROM package_recipients r WHERE r.package_id = p.id AND r.dest = ?)
                ORDER BY p.created_at DESC, p.id DESC LIMIT 1`)
      .get(apiKeyId, before.toISOString(), since.toISOString(), dest) as { package_id: string; created_at: string } | undefined;
    return row ? { packageId: row.package_id, createdAt: row.created_at } : undefined;
  }

  /**
   * Zestawienie raportu: odbiorcy w stanach (bez pozycji w raporcie jako `unknown`), przyczyny niedoręczeń według
   * stanu z raportu z liczbami oraz doręczenia w kolejnych godzinach według daty stanu, która jest czasem polskim.
   */
  reportBreakdown(id: string): {
    byStatus: Record<string, number>;
    reasons: Array<{ miStatus: number | null; description: string; count: number }>;
    deliveredByHour: Array<{ hour: string; count: number }>;
  } {
    const states = this.db
      .prepare(`SELECT COALESCE(status, 'unknown') AS status, COUNT(*) AS n FROM package_recipients WHERE package_id = ?
                GROUP BY COALESCE(status, 'unknown') ORDER BY n DESC, status`)
      .all(id) as Array<{ status: string; n: number }>;
    const reasons = this.db
      .prepare(`SELECT mi_status, status IS NULL AS missing, COUNT(*) AS n FROM package_recipients
                WHERE package_id = ? AND (status IS NULL OR status <> 'delivered')
                GROUP BY mi_status, status IS NULL ORDER BY n DESC, mi_status IS NULL, mi_status`)
      .all(id) as Array<{ mi_status: number | null; missing: 0 | 1; n: number }>;
    const hours = this.db
      .prepare(`SELECT substr(status_changed_at, 1, 13) || ':00' AS hour, COUNT(*) AS n FROM package_recipients
                WHERE package_id = ? AND status = 'delivered'
                  AND status_changed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]*'
                GROUP BY hour ORDER BY hour`)
      .all(id) as Array<{ hour: string; n: number }>;
    return {
      byStatus: Object.fromEntries(states.map((r) => [r.status, r.n])),
      reasons: reasons.map((r) => ({
        miStatus: r.mi_status, count: r.n,
        // Wiersz raportu z opisem spoza słownika ma status `unknown` bez kodu, odbiorca bez wiersza nie ma statusu.
        description: r.mi_status !== null ? describeReportStatus(r.mi_status) : r.missing === 1 ? 'Brak pozycji w raporcie' : 'Opis stanu spoza słownika bramki',
      })),
      deliveredByHour: hours.map((r) => ({ hour: r.hour, count: r.n })),
    };
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
