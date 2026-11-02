import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Logger } from '../log.ts';
import { backupDatabaseTo } from '../store/backup.ts';
import { migrationState } from '../store/db.ts';
import { SETTING_GATE_VERSION } from '../store/settings.ts';

/** Kopie przed aktualizacją zapisuje bramka przy starcie nowej wersji i `update` w kontenerze LXC. */
const UPGRADE_BACKUP = /^przed-aktualizacja-.+\.sqlite$/;

/** Tyle najnowszych kopii przed aktualizacją zostaje na dysku. */
export const UPGRADE_BACKUPS_KEPT = 3;

/** Kopia przed zmianą schematu się nie powiodła; schemat pozostał bez zmian. */
export class BackupBeforeUpgradeError extends Error {
  constructor(cause: unknown) {
    super(`Nie udało się zapisać kopii bazy przed aktualizacją: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'BackupBeforeUpgradeError';
  }
}

/** Wersja bramki, która ostatnio pracowała na tej bazie; bazy sprzed tabeli ustawień jej nie znają. */
export function readGateVersion(db: Database): string | null {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
  if (!table) return null;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_GATE_VERSION) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Ta sama nazwa co w `update` kontenera LXC (poprzednia wersja), dzięki czemu bramka nie robi
 * drugiej kopii po skrypcie. Bazy sprzed 1.8.7 nie znają poprzedniej wersji - wtedy nazwa docelowej.
 */
export function upgradeBackupName(previous: string | null, current: string): string {
  return previous === null ? `przed-aktualizacja-do-${current}.sqlite` : `przed-aktualizacja-${previous}.sqlite`;
}

/** Usuwa najstarsze kopie przed aktualizacją ponad `keep`, licząc po czasie modyfikacji. Kopii nocnych nie dotyka. */
export function pruneUpgradeBackups(dir: string, keep = UPGRADE_BACKUPS_KEPT): string[] {
  if (!existsSync(dir)) return [];
  const copies = readdirSync(dir)
    .filter((name) => UPGRADE_BACKUP.test(name))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed = copies.slice(keep).map((c) => c.name);
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}

export interface UpgradeBackupOptions {
  db: Database;
  dir: string;
  /** Wersja, która właśnie startuje. */
  current: string;
  log: Logger;
}

/**
 * Kopia przy pierwszym starcie nowej wersji albo przed migracjami, zanim cokolwiek zmieni bazę.
 * Świeża baza (`user_version` 0) kopii nie potrzebuje. Gdy kopia się nie uda, a czekają migracje,
 * start jest przerywany - migracja bez kopii to jedyny przypadek, w którym kopia chroni dane.
 */
export async function backupBeforeUpgrade(opts: UpgradeBackupOptions): Promise<string | null> {
  const { current: schema, target } = migrationState(opts.db);
  if (schema === 0) return null;
  const pending = target > schema;
  const previous = readGateVersion(opts.db);
  if (!pending && previous === opts.current) return null;

  const path = join(opts.dir, upgradeBackupName(previous, opts.current));
  if (existsSync(path)) return null;
  try {
    mkdirSync(opts.dir, { recursive: true });
    await backupDatabaseTo(opts.db, path);
  } catch (error) {
    if (pending) throw new BackupBeforeUpgradeError(error);
    opts.log.warn('kopia.przed_aktualizacja_blad', { dir: opts.dir, error });
    return null;
  }
  opts.log.info('kopia.przed_aktualizacja', { path });
  pruneUpgradeBackups(opts.dir);
  return path;
}
