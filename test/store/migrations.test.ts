import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';

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
    expect(db.pragma('user_version', { simple: true })).toBe(7);
  });
});
