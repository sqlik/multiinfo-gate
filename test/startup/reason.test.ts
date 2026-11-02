import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MissingMasterKeyError } from '../../src/config/env.ts';
import { KeyMismatchError } from '../../src/startup/key-check.ts';
import { classifyStartupError, isListenError } from '../../src/startup/reason.ts';
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

  it('kody rozszerzone SQLite sprowadza do podstawowych', () => {
    expect(classifyStartupError(coded('SQLITE_READONLY_DIRECTORY'))).toBe('permissions');
    expect(classifyStartupError(coded('SQLITE_CANTOPEN_ISDIR'))).toBe('permissions');
    expect(classifyStartupError(coded('SQLITE_CORRUPT_VTAB'))).toBe('corrupt');
  });

  it.skipIf(process.getuid?.() === 0)('katalog danych bez prawa zapisu to brak uprawnień', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-reason-'));
    const path = join(dir, 'multiinfo-gate.sqlite');
    openDatabaseRaw(path).close();
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    chmodSync(dir, 0o555);
    try {
      const db = openDatabaseRaw(path);
      db.prepare('CREATE TABLE t (x)').run();
      db.close();
      expect.unreachable('zapis w katalogu tylko do odczytu powinien się nie udać');
    } catch (error) {
      expect(classifyStartupError(error)).toBe('permissions');
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('isListenError', () => {
  it('rozpoznaje błędy nasłuchu na porcie', () => {
    expect(isListenError(coded('EADDRINUSE'))).toBe(true);
    expect(isListenError(Object.assign(coded('EACCES'), { syscall: 'listen' }))).toBe(true);
    expect(isListenError(Object.assign(coded('EADDRNOTAVAIL'), { syscall: 'listen' }))).toBe(true);
    expect(isListenError(coded('EACCES'))).toBe(false);
    expect(isListenError(coded('ENOSPC'))).toBe(false);
    expect(isListenError(null)).toBe(false);
  });
});
