import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultMailInConfig, defaultSmsGroupConfig } from '../../src/integrations/config.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { applyMigrations, NewerDatabaseError, openDatabase, openDatabaseRaw } from '../../src/store/db.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';
import { accountInput } from './helpers.ts';

describe('migracja 006', () => {
  it('tworzy tabele integracji i powiadomień oraz kolumny na istniejących tabelach', () => {
    const db = openDatabase(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of ['integrations', 'integration_events', 'integration_dedup', 'integration_throttle', 'smtp_settings', 'notification_rules', 'notification_queue']) {
      expect(tables).toContain(t);
    }
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('messages')).toContain('integration_id');
    expect(cols('inbound_messages')).toEqual(expect.arrayContaining(['external_ref', 'external_integration_id']));
    expect(cols('webhook_deliveries')).toEqual(expect.arrayContaining(['integration_id', 'method', 'headers_enc', 'response_ref']));
    expect(db.pragma('user_version', { simple: true })).toBe(11);
  });
});

describe('migracja 009', () => {
  it('009 dokłada kolumnę mail_from do wiadomości', () => {
    const db = openDatabase(':memory:');
    const cols = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('mail_from');
  });
});

describe('migracja 008', () => {
  it('008 zakłada tabele stanu skrzynki i przetworzonych maili', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mail_in_%' ORDER BY name").all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(['mail_in_seen', 'mail_in_state']);
  });
});

describe('migracja 010', () => {
  it('010 dokłada zlecającego przy wiadomości i rozsyłce, integrację rozsyłki i rozsyłkę wpisu dziennika', () => {
    const db = openDatabase(':memory:');
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('messages')).toContain('requested_by');
    expect(cols('packages')).toEqual(expect.arrayContaining(['integration_id', 'requested_by']));
    expect(cols('integration_events')).toContain('package_id');
  });
  it('usunięcie integracji zostawia rozsyłkę bez powiązania', () => {
    const db = openDatabase(':memory:');
    const fks = db.prepare('PRAGMA foreign_key_list(packages)').all() as Array<{ table: string; from: string; on_delete: string }>;
    expect(fks).toContainEqual(expect.objectContaining({ table: 'integrations', from: 'integration_id', on_delete: 'SET NULL' }));
  });
  it('indeksy na powiązaniu z integracją: usunięcie integracji nie przegląda całych tabel wiadomości i rozsyłek', () => {
    const db = openDatabase(':memory:');
    const indexed = (t: string) => (db.prepare(`PRAGMA index_list(${t})`).all() as Array<{ name: string }>)
      .flatMap((i) => (db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>).map((c) => c.name));
    expect(indexed('packages')).toContain('integration_id');
    expect(indexed('messages')).toContain('integration_id');
  });
});

const NINE = ['001-initial.sql', '002-etap-2.sql', '003-etap-3.sql', '004-etap-3b.sql', '005-odbior.sql', '006-integracje.sql', '007-adres-bramki.sql', '008-poczta.sql', '009-nadawca-maila.sql'];

describe('migracja 010 na bazie 1.8.7 z danymi', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mig-010-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('dane zostają, klucze obce spójne, a 1.8.7 odmawia startu na bazie po migracji bez zmiany pliku', () => {
    const path = join(root, 'gate.sqlite');
    const old = openDatabaseRaw(path);
    applyMigrations(old, { migrations: NINE });
    expect(old.pragma('user_version', { simple: true })).toBe(9);
    const accountId = new AccountsRepo(old, randomBytes(32)).insert(accountInput());
    old.prepare(`INSERT INTO api_keys (account_id, name, key_hash, key_prefix, max_parts, rate_per_min, created_at) VALUES (?, 'k', 'h', 'p', 3, 60, '2026-01-01')`).run(accountId);
    const apiKeyId = (old.prepare('SELECT id FROM api_keys').get() as { id: number }).id;
    old.prepare(`INSERT INTO integrations (name, kind, api_key_id, preset, config, created_at, updated_at) VALUES ('Ekipa serwisowa', 'sms_group', ?, 'sms-grupa', ?, 'x', 'x')`)
      .run(apiKeyId, JSON.stringify(defaultSmsGroupConfig()));
    const integrationId = (old.prepare('SELECT id FROM integrations').get() as { id: number }).id;
    old.prepare(`INSERT INTO messages (id, api_key_id, account_id, service_id, dest, body_hash, encoding, parts, slots, created_at, integration_id, mail_from)
                 VALUES ('msg_1', ?, ?, '24138', '48601000001', 'h', 'gsm', 1, 5, '2026-01-01', ?, 'dyspozytor@firma.pl')`).run(apiKeyId, accountId, integrationId);
    old.prepare(`INSERT INTO packages (id, api_key_id, account_id, service_id, encoding, recipients_count, created_at) VALUES ('pkg_1', ?, ?, '24138', 'gsm', 1, '2026-01-01')`).run(apiKeyId, accountId);
    old.prepare(`INSERT INTO integration_events (integration_id, at, result) VALUES (?, '2026-01-01', 'sent')`).run(integrationId);
    old.prepare(`INSERT INTO integration_throttle (integration_id, window_start, count, notified) VALUES (?, '2026-01-01', 3, 0)`).run(integrationId);
    old.close();

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(11);
    expect(db.prepare('SELECT id, integration_id, mail_from, requested_by FROM messages').all())
      .toEqual([{ id: 'msg_1', integration_id: integrationId, mail_from: 'dyspozytor@firma.pl', requested_by: null }]);
    expect(db.prepare('SELECT id, integration_id, requested_by, idempotency_key FROM packages').all())
      .toEqual([{ id: 'pkg_1', integration_id: null, requested_by: null, idempotency_key: null }]);
    expect(db.prepare('SELECT package_id FROM integration_events').all()).toEqual([{ package_id: null }]);
    expect(db.prepare('SELECT count, recipients FROM integration_throttle').all()).toEqual([{ count: 3, recipients: 0 }]);
    expect(db.prepare('SELECT integrations_only FROM api_keys').all()).toEqual([{ integrations_only: 0 }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.prepare("UPDATE packages SET integration_id = ? WHERE id = 'pkg_1'").run(integrationId);
    db.prepare('DELETE FROM integrations WHERE id = ?').run(integrationId);
    expect(db.prepare('SELECT integration_id FROM packages').get()).toEqual({ integration_id: null });
    db.close();

    const before = readFileSync(path);
    expect(() => openDatabase(path, { migrations: NINE })).toThrow(NewerDatabaseError);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('migracja 011', () => {
  const cols = (db: ReturnType<typeof openDatabase>, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  it('zakłada konta Microsoft 365 i ustawienia kanału SMS, dokłada kolumny sposobu logowania SMTP, SMS w regułach i kolejce, wiadomości systemowe', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(11);
    expect(cols(db, 'm365_accounts')).toEqual(expect.arrayContaining([
      'id', 'name', 'tenant', 'client_id', 'redirect_uri', 'address', 'refresh_enc', 'state', 'error_code', 'error_message',
      'error_since', 'notified_at', 'connected_at', 'connected_by', 'last_refresh_at', 'created_at', 'updated_at',
    ]));
    expect(cols(db, 'sms_notify_settings')).toEqual(expect.arrayContaining(['id', 'enabled', 'recipients', 'api_key_id', 'orig', 'updated_at']));
    expect(cols(db, 'smtp_settings')).toEqual(expect.arrayContaining(['auth_mode', 'm365_account_id']));
    expect(cols(db, 'notification_rules')).toContain('sms');
    expect(cols(db, 'notification_queue')).toContain('sms_status');
    expect(cols(db, 'messages')).toContain('system');
  });
  it('konta Microsoft 365 wskazanego w ustawieniach SMTP nie można usunąć', () => {
    const db = openDatabase(':memory:');
    const fks = db.prepare('PRAGMA foreign_key_list(smtp_settings)').all() as Array<{ table: string; from: string; on_delete: string }>;
    expect(fks).toContainEqual(expect.objectContaining({ table: 'm365_accounts', from: 'm365_account_id', on_delete: 'RESTRICT' }));
  });
});

const TEN = [...NINE, '010-power-automate.sql'];

describe('migracja 011 na bazie 1.9.0 z danymi', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mig-011-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('ustawienia SMTP, integracja Mail2SMS, wiadomości, reguły i kolejka zostają, a 1.9.0 odmawia startu na bazie po migracji', () => {
    const path = join(root, 'gate.sqlite');
    const old = openDatabaseRaw(path);
    applyMigrations(old, { migrations: TEN });
    expect(old.pragma('user_version', { simple: true })).toBe(10);
    const accountId = new AccountsRepo(old, randomBytes(32)).insert(accountInput());
    old.prepare(`INSERT INTO api_keys (account_id, name, key_hash, key_prefix, max_parts, rate_per_min, created_at) VALUES (?, 'k', 'h', 'p', 3, 60, '2026-01-01')`).run(accountId);
    const apiKeyId = (old.prepare('SELECT id FROM api_keys').get() as { id: number }).id;
    const config = JSON.stringify(defaultMailInConfig());
    old.prepare(`INSERT INTO integrations (name, kind, api_key_id, preset, config, created_at, updated_at) VALUES ('Alarmy serwisu', 'mail_in', ?, 'poczta', ?, 'x', 'x')`).run(apiKeyId, config);
    old.prepare(`INSERT INTO smtp_settings (id, host, port, security, user, password_enc, from_address, recipients, instance_name, updated_at)
                 VALUES (1, 'smtp.firma.pl', 587, 'starttls', 'bramka@firma.pl', NULL, 'bramka@firma.pl', 'it@firma.pl', 'bramka', '2026-01-01')`).run();
    old.prepare(`INSERT INTO messages (id, api_key_id, account_id, service_id, dest, body_hash, encoding, parts, slots, created_at)
                 VALUES ('msg_1', ?, ?, '24138', '48601000001', 'h', 'gsm', 1, 5, '2026-01-01')`).run(apiKeyId, accountId);
    old.prepare(`INSERT INTO notification_rules (event, enabled, max_per_hour, group_hours, params) VALUES ('mailbox_failure', 1, 5, 0, '{"afterMinutes":15}')`).run();
    old.prepare(`INSERT INTO notification_queue (event, at, summary) VALUES ('mailbox_failure', '2026-01-01', 'Skrzynka nie odpowiada')`).run();
    old.close();

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(11);
    const notifications = new NotificationsRepo(db, randomBytes(32));
    expect(notifications.smtp()).toMatchObject({ host: 'smtp.firma.pl', authMode: 'password', m365AccountId: null });
    expect(db.prepare('SELECT config FROM integrations').get()).toEqual({ config });
    expect(db.prepare('SELECT id, system FROM messages').all()).toEqual([{ id: 'msg_1', system: 0 }]);
    expect(notifications.rule('mailbox_failure')).toMatchObject({ enabled: 1, sms: 0 });
    expect(notifications.rule('m365_disconnected')).toMatchObject({ enabled: 1, sms: 1 });
    expect(notifications.pending('mailbox_failure')).toEqual([expect.objectContaining({ status: 'pending', smsStatus: 'none' })]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM m365_accounts').get()).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();

    const before = readFileSync(path);
    expect(() => openDatabase(path, { migrations: TEN })).toThrow(NewerDatabaseError);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
