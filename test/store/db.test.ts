import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';

const dir = mkdtempSync(join(tmpdir(), 'mig-db-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('openDatabase', () => {
  it('tworzy schemat i włącza tryb WAL', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((r) => (r as { name: string }).name);
    expect(tables).toContain('accounts');
    expect(tables).toContain('api_keys');
    expect(tables).toContain('messages');
    expect(tables).toContain('jobs');
    expect(tables).toContain('admin_users');
    expect(tables).toContain('audit_log');
  });

  it('włącza tryb WAL na bazie zapisanej w pliku', () => {
    const db = openDatabase(join(dir, 'wal.sqlite'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('przerwana migracja nie zostawia połowy schematu ani podniesionej wersji', () => {
    const migrations = join(dir, 'migracje');
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(migrations, '001-ok.sql'), 'CREATE TABLE a (x);');
    // Druga instrukcja pada - pierwsza nie może zostać.
    writeFileSync(join(migrations, '002-zla.sql'), 'CREATE TABLE b (x); CREATE TABLE a (x);');
    const path = join(dir, 'przerwana.sqlite');

    expect(() => openDatabase(path, { migrationsDir: migrations, migrations: ['001-ok.sql', '002-zla.sql'] })).toThrow();

    const db = new Database(path);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(['a']);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
  });

  it('jest idempotentne - ponowne otwarcie nie powiela migracji', () => {
    const path = join(dir, 'idem.sqlite');
    const first = openDatabase(path);
    expect(first.pragma('user_version', { simple: true })).toBe(4);
    first.close();

    // Druga migracja na tej samej bazie wywróciłaby się na CREATE TABLE.
    const second = openDatabase(path);
    expect(second.pragma('user_version', { simple: true })).toBe(4);
    second.close();
  });

  it('migracja 004 dodaje last_login_at do admin_users', () => {
    const db = openDatabase(':memory:');
    const cols = (db.prepare('PRAGMA table_info(admin_users)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('last_login_at');
  });

  it('wymusza klucze obce', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      db.prepare('INSERT INTO api_key_services (api_key_id, service_id) VALUES (?, ?)').run(999, '24138'),
    ).toThrow();
  });

  it('stosuje migracje 002-004 i podnosi user_version do 4', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const t of ['message_events', 'packages', 'package_recipients', 'webhook_deliveries']) expect(names).toContain(t);
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('trace');
  });

  it('dokłada migracje 002-004 do bazy z Etapu 1', () => {
    const path = join(dir, 'etap1.sqlite');
    const old = new Database(path);
    old.exec(readFileSync(new URL('../../src/store/migrations/001-initial.sql', import.meta.url), 'utf8'));
    old.pragma('user_version = 1');
    old.close();
    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('trace');
    const keyCols = db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>;
    expect(keyCols.map((c) => c.name)).toContain('expires_at');
    db.close();
  });
});
