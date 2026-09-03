import type { Database } from 'better-sqlite3';

export type JobType = 'send' | 'poll' | 'webhook' | 'package.create' | 'package.poll' | 'package.report' | 'mail';

export interface Job {
  id: number;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
}

/** Po tym czasie blokadę uznajemy za porzuconą przez proces, który przestał żyć. */
const LOCK_TIMEOUT_MS = 15 * 60_000;

const iso = (d: Date) => d.toISOString();

export class JobsRepo {
  constructor(private readonly db: Database) {}

  enqueue(type: JobType, payload: Record<string, unknown>, runAt: Date): number {
    const info = this.db
      .prepare('INSERT INTO jobs (type, payload, run_at) VALUES (?, ?, ?)')
      .run(type, JSON.stringify(payload), iso(runAt));
    return Number(info.lastInsertRowid);
  }

  /**
   * Wydaje do wykonania zadania, których czas nadszedł i które nie są zablokowane
   * albo których blokada jest przeterminowana. Blokada zakładana jest w tej samej
   * transakcji, więc dwa wywołania nie dostaną tego samego zadania.
   */
  claim(now: Date, limit: number): Job[] {
    const staleBefore = iso(new Date(now.getTime() - LOCK_TIMEOUT_MS));
    const take = this.db.transaction((): Job[] => {
      const rows = this.db
        .prepare(
          `SELECT id, type, payload, attempts, last_error FROM jobs
            WHERE run_at <= ? AND (locked_at IS NULL OR locked_at < ?)
            ORDER BY run_at LIMIT ?`,
        )
        .all(iso(now), staleBefore, limit) as Array<{
          id: number; type: JobType; payload: string; attempts: number; last_error: string | null;
        }>;
      const mark = this.db.prepare('UPDATE jobs SET locked_at = ? WHERE id = ?');
      for (const row of rows) mark.run(iso(now), row.id);
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
        attempts: r.attempts,
        lastError: r.last_error,
      }));
    });
    return take();
  }

  complete(id: number): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  /** Zwalnia blokadę i przesuwa zadanie na później, zwiększając licznik prób. */
  retry(id: number, runAt: Date, error: string): void {
    this.db
      .prepare('UPDATE jobs SET locked_at = NULL, run_at = ?, attempts = attempts + 1, last_error = ? WHERE id = ?')
      .run(iso(runAt), error, id);
  }

  /**
   * Zwalnia blokadę i przesuwa zadanie na później **bez** zwiększania licznika prób.
   * Do oczekiwania na coś, co nie jest winą zadania - np. na odblokowanie konta.
   * Gdyby takie oczekiwanie liczyło się jak ponowienie, po naprawie konta pierwszy
   * błąd przejściowy trafiałby poza harmonogram i kończył wiadomość niepowodzeniem.
   */
  defer(id: number, runAt: Date, reason: string): void {
    this.db
      .prepare('UPDATE jobs SET locked_at = NULL, run_at = ?, last_error = ? WHERE id = ?')
      .run(iso(runAt), reason, id);
  }

  /** Kończy zadanie niepowodzeniem bez dalszych prób. */
  fail(id: number, error: string): void {
    this.db.prepare('UPDATE jobs SET last_error = ? WHERE id = ?').run(error, id);
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  /** Liczba zadań czekających w kolejce, łącznie z zablokowanymi. */
  depth(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
    return row.n;
  }
}
