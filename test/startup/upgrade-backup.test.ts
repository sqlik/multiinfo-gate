import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log.ts';
import {
  BackupBeforeUpgradeError, backupBeforeUpgrade, pruneUpgradeBackups, readGateVersion, upgradeBackupName,
} from '../../src/startup/upgrade-backup.ts';
import { applyMigrations, openDatabase, openDatabaseRaw } from '../../src/store/db.ts';
import { SettingsRepo } from '../../src/store/settings.ts';

const FIRST_SIX = ['001-initial.sql', '002-etap-2.sql', '003-etap-3.sql', '004-etap-3b.sql', '005-odbior.sql', '006-integracje.sql'];
const asRoot = process.getuid?.() === 0;

let root: string;
let dir: string;
let log: Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mig-upgrade-'));
  dir = join(root, 'backups');
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
});

afterEach(() => {
  if (existsSync(dir)) chmodSync(dir, 0o700);
  rmSync(root, { recursive: true, force: true });
});

/** Baza po wszystkich migracjach z zapisaną wersją bramki, która ostatnio na niej pracowała. */
function migratedWithVersion(version: string | null) {
  const db = openDatabase(join(root, 'gate.sqlite'));
  if (version !== null) new SettingsRepo(db).setGateVersion(version, new Date('2026-11-01T10:00:00Z'));
  return db;
}

/** Baza z wydania sprzed tabeli settings (migracje 001-006). */
function sixMigrations() {
  const db = openDatabaseRaw(join(root, 'gate.sqlite'));
  applyMigrations(db, { migrations: FIRST_SIX });
  return db;
}

describe('upgradeBackupName', () => {
  it('nazywa kopię poprzednią wersją, a gdy jej nie zna - docelową', () => {
    expect(upgradeBackupName('1.8.6', '1.8.7')).toBe('przed-aktualizacja-1.8.6.sqlite');
    expect(upgradeBackupName(null, '1.8.7')).toBe('przed-aktualizacja-do-1.8.7.sqlite');
  });
});

describe('readGateVersion', () => {
  it('czyta zapisaną wersję, a na bazie bez tabeli ustawień zwraca null', () => {
    expect(readGateVersion(migratedWithVersion('1.8.6'))).toBe('1.8.6');
    rmSync(join(root, 'gate.sqlite'));
    rmSync(join(root, 'gate.sqlite-wal'), { force: true });
    rmSync(join(root, 'gate.sqlite-shm'), { force: true });
    expect(readGateVersion(sixMigrations())).toBeNull();
  });
});

describe('backupBeforeUpgrade', () => {
  it('świeża baza nie dostaje kopii', async () => {
    const db = openDatabaseRaw(join(root, 'gate.sqlite'));
    expect(await backupBeforeUpgrade({ db, dir, current: '1.8.7', log })).toBeNull();
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('zmiana wersji zapisuje kopię nazwaną poprzednią wersją', async () => {
    const db = migratedWithVersion('1.8.6');
    const path = await backupBeforeUpgrade({ db, dir, current: '1.8.7', log });
    expect(path).toBe(join(dir, 'przed-aktualizacja-1.8.6.sqlite'));
    const copy = new Database(path!, { readonly: true });
    expect(copy.prepare("SELECT value FROM settings WHERE key = 'gate_version'").get()).toEqual({ value: '1.8.6' });
    copy.close();
    expect(log.info).toHaveBeenCalledWith('kopia.przed_aktualizacja', { path });
  });

  it('kolejny start tej samej wersji nie robi kopii', async () => {
    const db = migratedWithVersion('1.8.7');
    expect(await backupBeforeUpgrade({ db, dir, current: '1.8.7', log })).toBeNull();
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('nie nadpisuje istniejącej kopii o tej samej nazwie', async () => {
    const db = migratedWithVersion('1.8.6');
    mkdirSync(dir, { recursive: true });
    const existing = join(dir, 'przed-aktualizacja-1.8.6.sqlite');
    writeFileSync(existing, 'kopia z polecenia update');
    const before = statSync(existing);
    expect(await backupBeforeUpgrade({ db, dir, current: '1.8.7', log })).toBeNull();
    const after = statSync(existing);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('baza sprzed zapisu wersji dostaje kopię nazwaną wersją docelową', async () => {
    const db = sixMigrations();
    const path = await backupBeforeUpgrade({ db, dir, current: '1.8.7', log });
    expect(path).toBe(join(dir, 'przed-aktualizacja-do-1.8.7.sqlite'));
  });

  it.skipIf(asRoot)('nieudana kopia bez migracji kończy się ostrzeżeniem', async () => {
    const db = migratedWithVersion('1.8.6');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    expect(await backupBeforeUpgrade({ db, dir, current: '1.8.7', log })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith('kopia.przed_aktualizacja_blad', expect.objectContaining({ dir }));
  });

  it.skipIf(asRoot)('nieudana kopia przed migracją przerywa start', async () => {
    const db = sixMigrations();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    await expect(backupBeforeUpgrade({ db, dir, current: '1.8.7', log })).rejects.toBeInstanceOf(BackupBeforeUpgradeError);
  });
});

describe('pruneUpgradeBackups', () => {
  it('zostawia trzy najnowsze kopie przed aktualizacją i nie rusza kopii nocnych', () => {
    mkdirSync(dir, { recursive: true });
    const names = ['1.8.2', '1.8.3', '1.8.4', '1.8.5', '1.8.6'].map((v) => `przed-aktualizacja-${v}.sqlite`);
    names.forEach((name, i) => {
      const path = join(dir, name);
      writeFileSync(path, 'x');
      const t = new Date(Date.UTC(2026, 9, 1 + i));
      utimesSync(path, t, t);
    });
    writeFileSync(join(dir, 'multiinfo-gate-2026-10-01.sqlite'), 'x');
    expect(pruneUpgradeBackups(dir).sort()).toEqual(names.slice(0, 2).sort());
    expect(readdirSync(dir).sort()).toEqual([...names.slice(2), 'multiinfo-gate-2026-10-01.sqlite'].sort());
  });
});
