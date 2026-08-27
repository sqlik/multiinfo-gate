import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Logger } from '../log.ts';

const DAY_MS = 86_400_000;

/** Nazwa z datą: prosty znacznik „dziś już było” i klucz retencji, bez zaglądania do pliku. */
const NAME = /^multiinfo-gate-(\d{4}-\d{2}-\d{2})\.sqlite$/;

export const backupFileName = (day: Date): string => `multiinfo-gate-${day.toISOString().slice(0, 10)}.sqlite`;

/**
 * Kopia przez `db.backup()` - bezpieczna w trybie WAL, w przeciwieństwie do `cp`.
 * Zapis idzie do pliku tymczasowego i dopiero po zakończeniu pod docelową nazwę,
 * żeby przerwana kopia nigdy nie wyglądała jak gotowa.
 */
export async function backupDatabase(db: Database, dir: string, now: Date): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, backupFileName(now));
  const partial = `${path}.part`;
  try {
    await db.backup(partial);
    renameSync(partial, path);
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
  return path;
}

/**
 * Usuwa kopie starsze niż retencja, licząc po dacie z nazwy: zostaje dzisiejsza
 * i `retentionDays` poprzednich dni. Innych plików nie dotyka.
 */
export function pruneBackups(dir: string, now: Date, retentionDays: number): string[] {
  if (!existsSync(dir)) return [];
  const oldestKept = new Date(now.getTime() - retentionDays * DAY_MS).toISOString().slice(0, 10);
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const m = NAME.exec(name);
    if (!m) continue;
    if (m[1]! < oldestKept) {
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

export interface BackupSchedulerOptions {
  db: Database;
  dir: string;
  retentionDays: number;
  log: Logger;
  now?: () => Date;
  intervalMs?: number;
  /** Godzina UTC, od której wolno zrobić kopię danego dnia. */
  afterHourUtc?: number;
}

/** Sprawdzenie co kwadrans wystarcza: kopia ma powstać raz na dobę, nie o dokładnej minucie. */
const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_AFTER_HOUR_UTC = 2;

/**
 * Raz na dobę po ustalonej godzinie zapisuje kopię i czyści stare. Błąd trafia do
 * dziennika i nie zatrzymuje bramki - brak kopii jest gorszy niż jej brak dziś,
 * ale nie gorszy niż brak wysyłki.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: BackupSchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = (this.opts.now ?? (() => new Date()))();
      if (now.getUTCHours() < (this.opts.afterHourUtc ?? DEFAULT_AFTER_HOUR_UTC)) return;
      if (existsSync(join(this.opts.dir, backupFileName(now)))) return;

      const path = await backupDatabase(this.opts.db, this.opts.dir, now);
      const removed = pruneBackups(this.opts.dir, now, this.opts.retentionDays);
      this.opts.log.info('kopia.zapisana', { path, removed });
    } catch (error) {
      this.opts.log.error('kopia.blad', { dir: this.opts.dir, error });
    } finally {
      this.running = false;
    }
  }
}
