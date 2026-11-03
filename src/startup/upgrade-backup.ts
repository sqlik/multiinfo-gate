import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Logger } from '../log.ts';
import { backupDatabaseTo } from '../store/backup.ts';
import { migrationState } from '../store/db.ts';
import { SETTING_GATE_VERSION } from '../store/settings.ts';

/** Kopie przed aktualizacją zapisuje bramka przy starcie nowej wersji i `update` w kontenerze LXC. */
const UPGRADE_BACKUP = /^przed-aktualizacja-.*\.sqlite$/;

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

/**
 * Czas ostatniego zapisu bazy: plik główny albo dziennik WAL, jeśli nie został scalony. Pusty
 * dziennik się nie liczy: powstaje przy otwarciu bazy w trybie WAL, a po czystym zatrzymaniu
 * SQLite scala go i usuwa. Bez tego kopia z `update` byłaby zawsze starsza niż świeżo otwarta baza.
 */
function lastWrite(dbPath: string): number | null {
  if (!existsSync(dbPath)) return null;
  const wal = `${dbPath}-wal`;
  const walStat = existsSync(wal) ? statSync(wal) : null;
  return Math.max(statSync(dbPath).mtimeMs, walStat && walStat.size > 0 ? walStat.mtimeMs : 0);
}

/**
 * Dziennik WAL z danymi przy starcie: poprzedni proces nie zamknął bazy czysto, na przykład
 * `systemctl stop` po 90 s wysłał SIGKILL. Kopia samego pliku głównego (tak kopiuje `update`)
 * nie zawiera wtedy ostatnich transakcji, a bramka przed jakimkolwiek zapisem widzi pełną bazę.
 */
function walHasFrames(dbPath: string): boolean {
  const wal = `${dbPath}-wal`;
  return existsSync(wal) && statSync(wal).size > 0;
}

/**
 * Kopia o nazwie z tej aktualizacji jest wierna, gdy powstała po ostatnim zapisie bazy. Starsza
 * zostaje z poprzedniej próby: po powrocie do poprzedniej wersji baza żyła dalej, więc ponowna
 * aktualizacja potrzebuje nowej kopii, inaczej kolejny powrót zgubiłby te dane.
 */
function trustedCopy(copyPath: string, dbPath: string): boolean {
  if (walHasFrames(dbPath)) return false;
  return statSync(copyPath).mtimeMs >= (lastWrite(dbPath) ?? 0);
}

/**
 * Kopia przed aktualizacją młodsza niż ostatni zapis bazy jest jej wierną kopią. Tak jest w LXC:
 * `update` zatrzymuje bramkę i kopiuje bazę, zanim nowa wersja wystartuje. Dotyczy baz, które nie
 * znają poprzedniej wersji - tylko wtedy nazwa kopii bramki różni się od nazwy ze skryptu.
 */
function freshCopyExists(dir: string, dbPath: string): boolean {
  const written = lastWrite(dbPath);
  if (written === null || !existsSync(dir)) return false;
  return readdirSync(dir).some((name) => UPGRADE_BACKUP.test(name) && statSync(join(dir, name)).mtimeMs >= written);
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
  let written: string | null = null;
  const covered = existsSync(path) ? trustedCopy(path, opts.db.name)
    : previous === null && !walHasFrames(opts.db.name) && freshCopyExists(opts.dir, opts.db.name);
  if (!covered) {
    try {
      mkdirSync(opts.dir, { recursive: true });
      await backupDatabaseTo(opts.db, path);
    } catch (error) {
      if (pending) throw new BackupBeforeUpgradeError(error);
      opts.log.warn('kopia.przed_aktualizacja_blad', { dir: opts.dir, error });
      return null;
    }
    opts.log.info('kopia.przed_aktualizacja', { path });
    written = path;
  }
  // Retencja przy każdej zmianie wersji, także gdy kopię zapisał już `update` w LXC.
  // Jej błąd nie zatrzymuje bramki: kopia, o którą chodzi, już istnieje.
  try {
    pruneUpgradeBackups(opts.dir);
  } catch (error) {
    opts.log.warn('kopia.retencja_blad', { dir: opts.dir, error });
  }
  return written;
}
