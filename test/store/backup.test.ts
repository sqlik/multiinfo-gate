import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupScheduler, backupDatabase, backupFileName, pruneBackups } from '../../src/store/backup.ts';
import { openDatabase } from '../../src/store/db.ts';
import type { Logger } from '../../src/log.ts';

const NOW = new Date('2026-08-26T02:30:00Z');

let root: string;
let dir: string;
let db: ReturnType<typeof openDatabase>;
let log: Logger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mig-backup-'));
  dir = join(root, 'backups');
  db = openDatabase(join(root, 'gate.sqlite'));
  db.prepare("INSERT INTO admin_users (login, password_hash) VALUES ('t', 'h')").run();
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('backupDatabase', () => {
  it('zapisuje poprawną kopię bazy pod nazwą z datą', async () => {
    const path = await backupDatabase(db, dir, NOW);
    expect(path).toBe(join(dir, 'multiinfo-gate-2026-08-26.sqlite'));
    expect(backupFileName(NOW)).toBe('multiinfo-gate-2026-08-26.sqlite');
    const copy = new Database(path, { readonly: true });
    expect(copy.pragma('user_version', { simple: true })).toBe(7);
    expect(copy.prepare('SELECT COUNT(*) AS n FROM admin_users').get()).toEqual({ n: 1 });
    // Kopia to cały plik, więc tabele integracji i powiadomień z migracji 006 są w niej razem ze schematem.
    const tables = (copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of ['integrations', 'integration_events', 'integration_dedup', 'integration_throttle', 'smtp_settings', 'notification_rules', 'notification_queue']) {
      expect(tables).toContain(t);
    }
    copy.close();
    expect(readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false);
  });
});

describe('pruneBackups', () => {
  it('usuwa kopie starsze niż retencja po dacie z nazwy i zostawia inne pliki', () => {
    const files = ['multiinfo-gate-2026-08-26.sqlite', 'multiinfo-gate-2026-08-12.sqlite',
      'multiinfo-gate-2026-08-11.sqlite', 'multiinfo-gate-2026-07-01.sqlite', 'notatki.txt', 'inna-2026-01-01.sqlite'];
    mkdirSync(dir, { recursive: true });
    for (const n of files) writeFileSync(join(dir, n), 'x');
    const removed = pruneBackups(dir, NOW, 14);
    expect(removed.sort()).toEqual(['multiinfo-gate-2026-07-01.sqlite', 'multiinfo-gate-2026-08-11.sqlite']);
    expect(readdirSync(dir).sort()).toEqual([
      'inna-2026-01-01.sqlite', 'multiinfo-gate-2026-08-12.sqlite', 'multiinfo-gate-2026-08-26.sqlite', 'notatki.txt',
    ]);
  });

  it('nie wywraca się na katalogu, którego nie ma', () => {
    expect(pruneBackups(join(root, 'brak'), NOW, 14)).toEqual([]);
  });
});

describe('BackupScheduler', () => {
  it('przed wyznaczoną godziną nic nie robi', async () => {
    const scheduler = new BackupScheduler({ db, dir, retentionDays: 14, log, now: () => new Date('2026-08-26T01:59:00Z') });
    await scheduler.tick();
    expect(existsSync(dir)).toBe(false);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('po godzinie tworzy kopię raz dziennie i czyści stare', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'multiinfo-gate-2026-07-01.sqlite'), 'x');
    const scheduler = new BackupScheduler({ db, dir, retentionDays: 14, log, now: () => NOW });
    await scheduler.tick();
    await scheduler.tick();
    expect(readdirSync(dir)).toEqual(['multiinfo-gate-2026-08-26.sqlite']);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('kopia.zapisana', {
      path: join(dir, 'multiinfo-gate-2026-08-26.sqlite'), removed: ['multiinfo-gate-2026-07-01.sqlite'],
    });
  });

  it('błąd zapisu trafia do dziennika i nie jest rzucany', async () => {
    writeFileSync(dir, 'to jest plik, nie katalog');
    const scheduler = new BackupScheduler({ db, dir, retentionDays: 14, log, now: () => NOW });
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith('kopia.blad', expect.objectContaining({ dir }));
  });

  it('start i stop zarządzają zegarem bez zaległych wywołań', async () => {
    const scheduler = new BackupScheduler({ db, dir, retentionDays: 14, log, now: () => NOW, intervalMs: 5 });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 30));
    scheduler.stop();
    expect(existsSync(join(dir, 'multiinfo-gate-2026-08-26.sqlite'))).toBe(true);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
