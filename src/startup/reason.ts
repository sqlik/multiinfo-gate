import { MissingMasterKeyError } from '../config/env.ts';
import { MigrationError, NewerDatabaseError } from '../store/db.ts';
import { KeyMismatchError } from './key-check.ts';
import { BackupBeforeUpgradeError } from './upgrade-backup.ts';

/** Przyczyna, dla której bramka nie rozpoczęła pracy; od niej zależy treść strony awaryjnej. */
export type StartupReason =
  | 'key_mismatch' | 'key_invalid' | 'backup_failed' | 'newer_database'
  | 'disk_full' | 'permissions' | 'corrupt' | 'migration_failed' | 'unknown';

const BY_CODE: Record<string, StartupReason> = {
  SQLITE_FULL: 'disk_full',
  ENOSPC: 'disk_full',
  SQLITE_READONLY: 'permissions',
  SQLITE_CANTOPEN: 'permissions',
  EACCES: 'permissions',
  EPERM: 'permissions',
  SQLITE_CORRUPT: 'corrupt',
  SQLITE_NOTADB: 'corrupt',
};

const codeOf = (value: unknown): string | null => {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

/**
 * Najpierw błędy bramki rozpoznawane po klasie, potem kody systemu w całym łańcuchu `cause`
 * (migracja przerwana brakiem miejsca to brak miejsca), na końcu nieudana migracja i powód ogólny.
 */
export function classifyStartupError(error: unknown): StartupReason {
  if (error instanceof KeyMismatchError) return 'key_mismatch';
  if (error instanceof MissingMasterKeyError) return 'key_invalid';
  if (error instanceof NewerDatabaseError) return 'newer_database';
  if (error instanceof BackupBeforeUpgradeError) return 'backup_failed';
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    const code = codeOf(e);
    if (code !== null && BY_CODE[code]) return BY_CODE[code]!;
  }
  if (error instanceof MigrationError) return 'migration_failed';
  return 'unknown';
}

/** Zajęty port: strony awaryjnej nie da się podać na tym porcie, więc proces kończy się jak dotąd. */
export function isAddressInUse(error: unknown): boolean {
  return codeOf(error) === 'EADDRINUSE';
}
