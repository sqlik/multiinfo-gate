import type { Database } from 'better-sqlite3';
import { NOTIFICATION_EVENTS, RULE_DEFAULTS, type NotificationEvent } from '../notifications/rules.ts';
import { decryptSecret, encryptSecret } from '../secrets/crypto.ts';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpSettings {
  host: string; port: number; security: SmtpSecurity; user: string | null;
  fromAddress: string; fromName: string; recipients: string[]; instanceName: string;
  /** Publiczny adres panelu do odnośników w mailach; bez niego maile ich nie mają. */
  panelUrl: string | null;
  updatedAt: string;
}

export interface SmtpInput extends Omit<SmtpSettings, 'updatedAt'> {
  /** Pominięte = bez zmiany; `null` = kasuje; tekst = nowe hasło. */
  password?: string | null;
}

export interface RuleRow {
  event: NotificationEvent; enabled: 0 | 1; maxPerHour: number; groupHours: number; params: Record<string, unknown>;
}

export interface RulePatch { enabled: 0 | 1; maxPerHour: number; groupHours: number; params: Record<string, unknown> }

export type QueueStatus = 'pending' | 'sent' | 'suppressed';

export interface QueueRow {
  id: number; event: NotificationEvent; at: string; subjectKey: string | null; dedupKey: string | null;
  summary: string; status: QueueStatus; sentAt: string | null;
}

export interface EnqueueInput { event: NotificationEvent; at: Date; subjectKey?: string; dedupKey?: string; summary: string }

interface RawSmtp {
  host: string; port: number; security: SmtpSecurity; user: string | null; password_enc: string | null;
  from_address: string; from_name: string; recipients: string; instance_name: string; panel_url: string | null; updated_at: string;
}
interface RawRule { event: NotificationEvent; enabled: 0 | 1; max_per_hour: number; group_hours: number; params: string }
interface RawQueue {
  id: number; event: NotificationEvent; at: string; subject_key: string | null; dedup_key: string | null;
  summary: string; status: QueueStatus; sent_at: string | null;
}

const SUMMARY_CHARS = 500;

/** Ustawienie SMTP (jeden wiersz), reguły per zdarzenie i kolejka - liczniki liczone z bazy, nie z pamięci. */
export class NotificationsRepo {
  constructor(private readonly db: Database, private readonly masterKey: Buffer) {}

  smtp(): SmtpSettings | null {
    const r = this.db.prepare('SELECT * FROM smtp_settings WHERE id = 1').get() as RawSmtp | undefined;
    if (!r) return null;
    return {
      host: r.host, port: r.port, security: r.security, user: r.user, fromAddress: r.from_address, fromName: r.from_name,
      recipients: r.recipients.split(',').map((s) => s.trim()).filter((s) => s !== ''),
      instanceName: r.instance_name, panelUrl: r.panel_url, updatedAt: r.updated_at,
    };
  }

  /** Hasło jawnie - wyłącznie do zbudowania transportu SMTP. */
  smtpPassword(): string | null {
    const r = this.db.prepare('SELECT password_enc FROM smtp_settings WHERE id = 1').get() as { password_enc: string | null } | undefined;
    return r?.password_enc ? decryptSecret(r.password_enc, this.masterKey) : null;
  }

  saveSmtp(input: SmtpInput, at: Date): void {
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO smtp_settings (id, host, port, security, user, from_address, from_name, recipients, instance_name, panel_url, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET host = excluded.host, port = excluded.port, security = excluded.security, user = excluded.user,
           from_address = excluded.from_address, from_name = excluded.from_name, recipients = excluded.recipients,
           instance_name = excluded.instance_name, panel_url = excluded.panel_url, updated_at = excluded.updated_at`,
      ).run(input.host, input.port, input.security, input.user, input.fromAddress, input.fromName, input.recipients.join(','),
        input.instanceName, input.panelUrl, at.toISOString());
      if (input.password !== undefined) {
        const enc = input.password === null ? null : encryptSecret(input.password, this.masterKey);
        this.db.prepare('UPDATE smtp_settings SET password_enc = ? WHERE id = 1').run(enc);
      }
    })();
  }

  private toRule(r: RawRule): RuleRow {
    return { event: r.event, enabled: r.enabled, maxPerHour: r.max_per_hour, groupHours: r.group_hours, params: JSON.parse(r.params) as Record<string, unknown> };
  }

  /** Brakujące reguły dostają wartości domyślne w bazie - od tej chwili to administrator o nich decyduje. */
  private seedRules(): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO notification_rules (event, enabled, max_per_hour, group_hours, params) VALUES (?, ?, ?, ?, ?)');
    for (const event of NOTIFICATION_EVENTS) {
      const d = RULE_DEFAULTS[event];
      insert.run(event, d.enabled ? 1 : 0, d.maxPerHour, d.groupHours, JSON.stringify(d.params));
    }
  }

  rules(): RuleRow[] {
    this.seedRules();
    const rows = this.db.prepare('SELECT * FROM notification_rules').all() as RawRule[];
    const byEvent = new Map(rows.map((r) => [r.event, this.toRule(r)]));
    return NOTIFICATION_EVENTS.map((e) => byEvent.get(e)!);
  }

  rule(event: NotificationEvent): RuleRow {
    const row = this.db.prepare('SELECT * FROM notification_rules WHERE event = ?').get(event) as RawRule | undefined;
    if (row) return this.toRule(row);
    this.seedRules();
    return this.toRule(this.db.prepare('SELECT * FROM notification_rules WHERE event = ?').get(event) as RawRule);
  }

  saveRule(event: NotificationEvent, patch: RulePatch): void {
    this.db.prepare(
      `INSERT INTO notification_rules (event, enabled, max_per_hour, group_hours, params) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event) DO UPDATE SET enabled = excluded.enabled, max_per_hour = excluded.max_per_hour,
         group_hours = excluded.group_hours, params = excluded.params`,
    ).run(event, patch.enabled, patch.maxPerHour, patch.groupHours, JSON.stringify(patch.params));
  }

  /** Identyfikator wpisu albo `null`, gdy `dedupKey` już był - to samo powiadomienie nie pójdzie dwa razy. */
  enqueue(e: EnqueueInput): number | null {
    const info = this.db.prepare(
      'INSERT OR IGNORE INTO notification_queue (event, at, subject_key, dedup_key, summary) VALUES (?, ?, ?, ?, ?)',
    ).run(e.event, e.at.toISOString(), e.subjectKey ?? null, e.dedupKey ?? null, e.summary.slice(0, SUMMARY_CHARS));
    return info.changes === 1 ? Number(info.lastInsertRowid) : null;
  }

  private toQueue(r: RawQueue): QueueRow {
    return { id: r.id, event: r.event, at: r.at, subjectKey: r.subject_key, dedupKey: r.dedup_key, summary: r.summary, status: r.status, sentAt: r.sent_at };
  }

  pending(event: NotificationEvent): QueueRow[] {
    const rows = this.db.prepare("SELECT * FROM notification_queue WHERE status = 'pending' AND event = ? ORDER BY at, id").all(event) as RawQueue[];
    return rows.map((r) => this.toQueue(r));
  }

  markSent(ids: number[], at: Date): void {
    if (ids.length === 0) return;
    this.db.prepare(`UPDATE notification_queue SET status = 'sent', sent_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`).run(at.toISOString(), ...ids);
  }

  markSuppressed(ids: number[]): void {
    if (ids.length === 0) return;
    this.db.prepare(`UPDATE notification_queue SET status = 'suppressed' WHERE id IN (${ids.map(() => '?').join(', ')})`).run(...ids);
  }

  sentCountSince(event: NotificationEvent, since: Date): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM notification_queue WHERE event = ? AND status = 'sent' AND sent_at >= ?")
      .get(event, since.toISOString()) as { n: number };
    return row.n;
  }

  suppressedCountSince(event: NotificationEvent, since: Date): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM notification_queue WHERE event = ? AND status = 'suppressed' AND at >= ?")
      .get(event, since.toISOString()) as { n: number };
    return row.n;
  }

  lastSentAt(event: NotificationEvent): string | null {
    const row = this.db.prepare("SELECT MAX(sent_at) AS at FROM notification_queue WHERE event = ? AND status = 'sent'").get(event) as { at: string | null };
    return row.at;
  }

  /** Załatwione wpisy starsze niż `at` znikają; oczekujące czekają na SMTP choćby miesiąc. */
  pruneBefore(at: Date): number {
    return this.db.prepare("DELETE FROM notification_queue WHERE status != 'pending' AND at < ?").run(at.toISOString()).changes;
  }
}
