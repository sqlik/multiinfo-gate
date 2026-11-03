import type { Database } from 'better-sqlite3';

/** Idempotencja i ochrona przed burzą - liczniki w bazie, żeby restart ich nie gubił. */
export class IntegrationGuardsRepo {
  constructor(private readonly db: Database) {}

  /** Prawda, gdy klucz zdarzenia jest nowy; drugi raz w oknie 24 h to duplikat. */
  dedup(integrationId: number, eventKey: string, now: Date): boolean {
    const info = this.db.prepare('INSERT OR IGNORE INTO integration_dedup (integration_id, event_key, at) VALUES (?, ?, ?)')
      .run(integrationId, eventKey.slice(0, 200), now.toISOString());
    return info.changes === 1;
  }

  /**
   * Zdejmuje klucz zdarzenia zapisany przez `dedup`. Potrzebne, gdy potok odpowiada aplikacji
   * błędem przejściowym, czyli prosi o ponowienie: bez tego ponowienie wróciłoby jako duplikat.
   */
  releaseDedup(integrationId: number, eventKey: string): void {
    this.db.prepare('DELETE FROM integration_dedup WHERE integration_id = ? AND event_key = ?')
      .run(integrationId, eventKey.slice(0, 200));
  }

  pruneDedupBefore(at: Date): number {
    return this.db.prepare('DELETE FROM integration_dedup WHERE at < ?').run(at.toISOString()).changes;
  }

  /**
   * Okno stałe od pierwszego zdarzenia: `limit` przechodzi, reszta odpada do końca okna.
   * `notify` tylko przy pierwszym odrzuceniu w oknie - jeden mail na burzę, nie na każdy alert.
   * `recipients` (integracja z Power Automate) dokłada w tym samym oknie limit odbiorców: wywołanie,
   * które by go przekroczyło, odpada i nie zużywa żadnego z limitów. `by` mówi, który limit zadziałał.
   */
  throttle(
    integrationId: number, limit: number, windowMinutes: number, now: Date, recipients?: { count: number; limit: number },
  ): { allowed: true; notify: false } | { allowed: false; notify: boolean; by?: 'calls' | 'recipients' } {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT window_start, count, recipients, notified FROM integration_throttle WHERE integration_id = ?')
        .get(integrationId) as { window_start: string; count: number; recipients: number; notified: 0 | 1 } | undefined;
      const windowMs = windowMinutes * 60_000;
      const fresh = !row || now.getTime() - Date.parse(row.window_start) >= windowMs;
      const count = fresh ? 0 : row!.count;
      const used = fresh ? 0 : row!.recipients;
      const notified = fresh ? 0 : row!.notified;
      const overRecipients = recipients !== undefined && used + recipients.count > recipients.limit;
      if (count < limit && !overRecipients) {
        this.db.prepare(
          `INSERT INTO integration_throttle (integration_id, window_start, count, recipients, notified) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(integration_id) DO UPDATE SET window_start = excluded.window_start, count = excluded.count,
             recipients = excluded.recipients, notified = excluded.notified`,
        ).run(integrationId, fresh ? now.toISOString() : row!.window_start, count + 1, used + (recipients?.count ?? 0), notified);
        return { allowed: true as const, notify: false as const };
      }
      // Odrzucenie w świeżym oknie (jedna rozsyłka ponad limit odbiorców) też otwiera okno.
      this.db.prepare(
        `INSERT INTO integration_throttle (integration_id, window_start, count, recipients, notified) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(integration_id) DO UPDATE SET window_start = excluded.window_start, count = excluded.count,
           recipients = excluded.recipients, notified = 1`,
      ).run(integrationId, fresh ? now.toISOString() : row!.window_start, count, used);
      const by = recipients === undefined ? {} : { by: count >= limit ? 'calls' as const : 'recipients' as const };
      return { allowed: false as const, notify: notified === 0, ...by };
    })();
  }
}
