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

  pruneDedupBefore(at: Date): number {
    return this.db.prepare('DELETE FROM integration_dedup WHERE at < ?').run(at.toISOString()).changes;
  }

  /**
   * Okno stałe od pierwszego zdarzenia: `limit` przechodzi, reszta odpada do końca okna.
   * `notify` tylko przy pierwszym odrzuceniu w oknie - jeden mail na burzę, nie na każdy alert.
   */
  throttle(integrationId: number, limit: number, windowMinutes: number, now: Date): { allowed: boolean; notify: boolean } {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT window_start, count, notified FROM integration_throttle WHERE integration_id = ?')
        .get(integrationId) as { window_start: string; count: number; notified: 0 | 1 } | undefined;
      const windowMs = windowMinutes * 60_000;
      const fresh = !row || now.getTime() - Date.parse(row.window_start) >= windowMs;
      const count = fresh ? 0 : row!.count;
      const notified = fresh ? 0 : row!.notified;
      if (count < limit) {
        this.db.prepare(
          `INSERT INTO integration_throttle (integration_id, window_start, count, notified) VALUES (?, ?, ?, ?)
           ON CONFLICT(integration_id) DO UPDATE SET window_start = excluded.window_start, count = excluded.count, notified = excluded.notified`,
        ).run(integrationId, fresh ? now.toISOString() : row!.window_start, count + 1, notified);
        return { allowed: true, notify: false };
      }
      this.db.prepare('UPDATE integration_throttle SET notified = 1 WHERE integration_id = ?').run(integrationId);
      return { allowed: false, notify: notified === 0 };
    })();
  }
}
