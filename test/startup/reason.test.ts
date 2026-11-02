import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MissingMasterKeyError } from '../../src/config/env.ts';
import { KeyMismatchError } from '../../src/startup/key-check.ts';
import { classifyStartupError, isAddressInUse } from '../../src/startup/reason.ts';
import { BackupBeforeUpgradeError } from '../../src/startup/upgrade-backup.ts';
import { MigrationError, NewerDatabaseError, openDatabaseRaw } from '../../src/store/db.ts';

/** Błąd z kodem, jak rzuca go better-sqlite3 albo Node. */
const coded = (code: string) => Object.assign(new Error(code), { code });

describe('classifyStartupError', () => {
  it('rozpoznaje błędy bramki po klasie', () => {
    expect(classifyStartupError(new KeyMismatchError(['konta_panelu']))).toBe('key_mismatch');
    expect(classifyStartupError(new MissingMasterKeyError('oczekiwano 32 bajtów, otrzymano 31'))).toBe('key_invalid');
    expect(classifyStartupError(new NewerDatabaseError(10, 9))).toBe('newer_database');
    expect(classifyStartupError(new BackupBeforeUpgradeError(coded('ENOSPC')))).toBe('backup_failed');
    expect(classifyStartupError(new MigrationError('010-x.sql', new Error('składnia')))).toBe('migration_failed');
  });

  it('rozpoznaje błędy systemu po kodzie', () => {
    expect(classifyStartupError(coded('SQLITE_FULL'))).toBe('disk_full');
    expect(classifyStartupError(coded('ENOSPC'))).toBe('disk_full');
    for (const code of ['SQLITE_READONLY', 'SQLITE_CANTOPEN', 'EACCES', 'EPERM']) {
      expect(classifyStartupError(coded(code))).toBe('permissions');
    }
    expect(classifyStartupError(coded('SQLITE_CORRUPT'))).toBe('corrupt');
    expect(classifyStartupError(coded('SQLITE_NOTADB'))).toBe('corrupt');
  });

  it('migracja przerwana brakiem miejsca to brak miejsca, nie wada migracji', () => {
    expect(classifyStartupError(new MigrationError('009-x.sql', coded('SQLITE_FULL')))).toBe('disk_full');
  });

  it('nieznany błąd to powód ogólny', () => {
    expect(classifyStartupError(new Error('coś innego'))).toBe('unknown');
    expect(classifyStartupError('napis')).toBe('unknown');
  });

  it('plik tekstowy w miejscu bazy to uszkodzona baza', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-reason-'));
    const path = join(dir, 'multiinfo-gate.sqlite');
    writeFileSync(path, 'to nie jest baza danych '.repeat(100));
    try {
      openDatabaseRaw(path);
      expect.unreachable('otwarcie pliku tekstowego powinno się nie udać');
    } catch (error) {
      expect(classifyStartupError(error)).toBe('corrupt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isAddressInUse', () => {
  it('rozpoznaje zajęty port', () => {
    expect(isAddressInUse(coded('EADDRINUSE'))).toBe(true);
    expect(isAddressInUse(coded('ENOSPC'))).toBe(false);
    expect(isAddressInUse(null)).toBe(false);
  });
});
