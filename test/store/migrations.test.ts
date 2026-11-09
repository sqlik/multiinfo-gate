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
    expect(db.pragma('user_version', { simple: true })).toBe(13);
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
    expect(db.pragma('user_version', { simple: true })).toBe(13);
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
    expect(db.pragma('user_version', { simple: true })).toBe(13);
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
    expect(db.pragma('user_version', { simple: true })).toBe(13);
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

const ELEVEN = [...TEN, '011-microsoft-365.sql'];

describe('migracja 012 na bazie 1.10.0 z danymi', () => {
  const cols = (db: ReturnType<typeof openDatabase>, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mig-012-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('zakłada tabele skracacza, a istniejący klucz ma skracanie wyłączone', () => {
    const path = join(root, 'gate.sqlite');
    const old = openDatabaseRaw(path);
    applyMigrations(old, { migrations: ELEVEN });
    expect(old.pragma('user_version', { simple: true })).toBe(11);
    const accountId = new AccountsRepo(old, randomBytes(32)).insert(accountInput());
    old.prepare(`INSERT INTO api_keys (account_id, name, key_hash, key_prefix, max_parts, rate_per_min, created_at) VALUES (?, 'k', 'h', 'p', 3, 60, '2026-01-01')`).run(accountId);
    const apiKeyId = (old.prepare('SELECT id FROM api_keys').get() as { id: number }).id;
    old.prepare(`INSERT INTO messages (id, api_key_id, account_id, service_id, dest, body_hash, encoding, parts, slots, created_at)
                 VALUES ('msg_1', ?, ?, '24138', '48601000001', 'h', 'gsm', 1, 5, '2026-01-01')`).run(apiKeyId, accountId);
    old.prepare(`INSERT INTO packages (id, api_key_id, account_id, service_id, encoding, recipients_count, created_at)
                 VALUES ('pkg_1', ?, ?, '24138', 'gsm', 1, '2026-01-01')`).run(apiKeyId, accountId);
    old.prepare(`INSERT INTO package_recipients (package_id, seq, dest) VALUES ('pkg_1', 1, '48601000002')`).run();
    old.close();

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(13);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining([
      'link_domains', 'api_key_link_domains', 'api_key_link_targets', 'campaigns', 'campaign_hours', 'campaign_targets', 'short_links',
    ]));
    expect(cols(db, 'link_domains')).toEqual(expect.arrayContaining([
      'id', 'domain', 'display_name', 'home_url', 'bare_links', 'enabled', 'checked_at', 'check_ok', 'check_detail', 'created_at', 'updated_at',
    ]));
    expect(cols(db, 'campaigns')).toEqual(expect.arrayContaining([
      'id', 'api_key_id', 'name', 'first_sent_at', 'last_sent_at', 'sent', 'opens', 'clicks', 'bots', 'links_disabled_at', 'details_purged_at', 'created_at',
    ]));
    expect(cols(db, 'campaign_targets')).toEqual(expect.arrayContaining(['id', 'campaign_id', 'target', 'collapsed', 'recipients', 'opens', 'clicks', 'purge_after']));
    expect(cols(db, 'short_links')).toEqual(expect.arrayContaining([
      'code', 'domain_id', 'api_key_id', 'campaign_id', 'target', 'utm', 'recipient_key', 'message_id', 'package_id', 'seq', 'dest', 'client_id',
      'clicks', 'bot_clicks', 'first_opened_at', 'last_clicked_at', 'expires_at', 'disabled_at', 'purge_after', 'created_at',
    ]));
    expect(db.prepare('SELECT link_mode, link_default_domain_id, link_validity_days, link_utm FROM api_keys').get())
      .toEqual({ link_mode: 'off', link_default_domain_id: null, link_validity_days: 90, link_utm: 1 });
    expect(db.prepare('SELECT campaign_id FROM messages').get()).toEqual({ campaign_id: null });
    expect(db.prepare('SELECT campaign_id FROM packages').get()).toEqual({ campaign_id: null });
    expect(db.prepare('SELECT links FROM package_recipients').get()).toEqual({ links: 0 });
    expect(() => db.prepare("UPDATE api_keys SET link_mode = 'zawsze'").run()).toThrow(/CHECK/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
  });

  it('indeksy kodów: kampania z odbiorcą, wiadomość, odbiorca rozsyłki i termin retencji', () => {
    const db = openDatabase(':memory:');
    const indexed = (db.prepare('PRAGMA index_list(short_links)').all() as Array<{ name: string }>)
      .map((i) => (db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>).map((c) => c.name).join(','));
    expect(indexed).toEqual(expect.arrayContaining(['campaign_id,recipient_key', 'message_id', 'package_id,seq', 'purge_after']));
  });
});

const TWELVE = [...ELEVEN, '012-skracacz.sql'];

describe('migracja 013 na bazie 1.11.3 z grupami', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mig-013-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('odbiorcy osobnych list przechodzą na numer z nazwą w tej samej kolejności, reszta konfiguracji i inne integracje bez zmian, a 1.11.3 odmawia startu', () => {
    const path = join(root, 'gate.sqlite');
    const old = openDatabaseRaw(path);
    applyMigrations(old, { migrations: TWELVE });
    expect(old.pragma('user_version', { simple: true })).toBe(12);
    const accountId = new AccountsRepo(old, randomBytes(32)).insert(accountInput());
    old.prepare(`INSERT INTO api_keys (account_id, name, key_hash, key_prefix, max_parts, rate_per_min, created_at) VALUES (?, 'k', 'h', 'p', 3, 60, '2026-01-01')`).run(accountId);
    const apiKeyId = (old.prepare('SELECT id FROM api_keys').get() as { id: number }).id;
    const insert = old.prepare(`INSERT INTO integrations (name, kind, api_key_id, preset, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '2026-01-01', '2026-01-02')`);
    const lists = { ...defaultSmsGroupConfig(), senders: [{ phone: '48601000001', name: 'Dyspozytor' }], recipients: ['48601000013', '48601000011', '48601000012'], prefix: 'serwis' };
    const closed = { ...defaultSmsGroupConfig(), mode: 'closed', members: [{ phone: '48601000001', name: 'Anna Nowak' }, { phone: '48601000002', name: '' }] };
    const mail = JSON.stringify(defaultMailInConfig());
    insert.run('Ekipa serwisowa', 'sms_group', apiKeyId, 'sms-grupa', JSON.stringify(lists));
    insert.run('Dyżur IT', 'sms_group', apiKeyId, 'sms-grupa', JSON.stringify(closed));
    insert.run('Alarmy', 'mail_in', apiKeyId, 'imap', mail);
    old.close();

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(13);
    const rows = db.prepare('SELECT name, config, updated_at FROM integrations ORDER BY id').all() as Array<{ name: string; config: string; updated_at: string }>;
    expect(JSON.parse(rows[0]!.config)).toEqual({ ...lists, recipients: [
      { phone: '48601000013', name: '' }, { phone: '48601000011', name: '' }, { phone: '48601000012', name: '' },
    ] });
    expect(JSON.parse(rows[1]!.config)).toEqual(closed);
    expect(rows[2]!.config).toBe(mail);
    expect(rows.map((r) => r.updated_at)).toEqual(['2026-01-02', '2026-01-02', '2026-01-02']);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();

    const before = readFileSync(path);
    expect(() => openDatabase(path, { migrations: TWELVE })).toThrow(NewerDatabaseError);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
