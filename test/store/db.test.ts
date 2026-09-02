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
    expect(first.pragma('user_version', { simple: true })).toBe(7);
    first.close();

    // Druga migracja na tej samej bazie wywróciłaby się na CREATE TABLE.
    const second = openDatabase(path);
    expect(second.pragma('user_version', { simple: true })).toBe(7);
    second.close();
  });

  it('migracja 004 dodaje last_login_at do admin_users', () => {
    const db = openDatabase(':memory:');
    const cols = (db.prepare('PRAGMA table_info(admin_users)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('last_login_at');
  });

  it('migracja 005 tworzy inbound_messages i kolumny odbioru', () => {
    const db = openDatabase(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain('inbound_messages');
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('api_keys')).toContain('inbound_subscribed');
    expect(cols('account_services')).toEqual(expect.arrayContaining(['inbound_last_poll_at', 'inbound_last_received_at', 'inbound_error']));
    expect(cols('messages')).toContain('in_reply_to');
    // Wątek wiąże obie tabele w cykl; kasowanie (przyszła retencja) nie może utknąć na kluczu obcym.
    const fk = (table: string) => db.pragma(`foreign_key_list(${table})`) as Array<{ from: string; on_delete: string }>;
    expect(fk('inbound_messages').find((f) => f.from === 'related_message_id')!.on_delete).toBe('SET NULL');
    expect(fk('messages').find((f) => f.from === 'in_reply_to')!.on_delete).toBe('SET NULL');
    expect(fk('webhook_deliveries').find((f) => f.from === 'inbound_id')!.on_delete).toBe('CASCADE');
    // lastTo() w gorącej ścieżce odbiornika i repliesTo() w szczególe odebranej - bez indeksu skan wysłanych.
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_messages_in_reply_to', 'idx_messages_dest_created']));
    expect(cols('webhook_deliveries')).toEqual(expect.arrayContaining(['inbound_id', 'scrub_after']));
    // Ten sam identyfikator MI na tym samym koncie nie wchodzi dwa razy.
    db.prepare("INSERT INTO accounts (name, base_url, login, password_enc, cert_pem_enc, key_pem_enc, cert_cn, cert_issuer_cn, cert_fingerprint_sha1, cert_not_before, cert_not_after, default_country_code) VALUES ('a','u','l','p','c','k','cn','i','f','2026','2027','48')").run();
    const ins = db.prepare(`INSERT INTO inbound_messages (id, account_id, service_id, mi_id, sender, dest, kind, body_hash, protocol_id, coding_scheme, received_at, created_at)
      VALUES (?, 1, '24138', '22', '48601000001', '7968', 'text', 'h', 0, 0, '2026-08-29T09:14:00.000Z', '2026-08-29T09:14:02.000Z')`);
    ins.run('in_1');
    expect(() => ins.run('in_2')).toThrow(/UNIQUE/);
  });

  it('wymusza klucze obce', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      db.prepare('INSERT INTO api_key_services (api_key_id, service_id) VALUES (?, ?)').run(999, '24138'),
    ).toThrow();
  });

  it('stosuje migracje 002-007 i podnosi user_version do 7', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(7);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const t of ['message_events', 'packages', 'package_recipients', 'webhook_deliveries']) expect(names).toContain(t);
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('trace');
  });

  it('dokłada migracje 002-007 do bazy z Etapu 1', () => {
    const path = join(dir, 'etap1.sqlite');
    const old = new Database(path);
    old.exec(readFileSync(new URL('../../src/store/migrations/001-initial.sql', import.meta.url), 'utf8'));
    old.pragma('user_version = 1');
    old.close();
    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(7);
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('trace');
    const keyCols = db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>;
    expect(keyCols.map((c) => c.name)).toContain('expires_at');
    db.close();
  });
});
