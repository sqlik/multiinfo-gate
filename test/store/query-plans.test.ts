import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';

/**
 * Odczyty agenta wykonują po dwa zapytania na każdą pozycję listy odebranych SMS-ów, a better-sqlite3
 * jest synchroniczne. Bez indeksu po numerze jedno wywołanie list_inbound przy 100 tys. wiadomości
 * i 100 tys. odbiorców rozsyłek blokowało API, worker i panel na około sekundę (przegląd R4-W2).
 * Test sprawdza plan prawdziwego zapytania magazynu, przechwycony przy prepare.
 */
function planOf(db: Database, run: () => unknown, params: unknown[]): string {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    seen.push(sql);
    return prepare(sql);
  };
  try {
    run();
  } finally {
    (db as unknown as { prepare: typeof prepare }).prepare = prepare;
  }
  expect(seen).toHaveLength(1);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all(...params) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

const BEFORE = new Date('2026-11-16T10:00:00Z');
const SINCE = new Date('2026-11-09T10:00:00Z');

describe('plany zapytań odczytów agenta', () => {
  it('ostatnia wiadomość klucza na numer szuka po indeksie numeru, bez przeglądania wiadomości z 7 dni', () => {
    const db = openDatabase(':memory:');
    const plan = planOf(db, () => new MessagesRepo(db).lastToBefore(1, '48601000011', BEFORE, SINCE),
      [1, '48601000011', BEFORE.toISOString(), SINCE.toISOString()]);
    expect(plan).toMatch(/SEARCH messages USING INDEX idx_messages_dest_key \(dest=\? AND api_key_id=\? AND created_at>\? AND created_at<\?\)/);
  });

  it('ostatnia rozsyłka klucza do numeru sprawdza odbiorców po indeksie numeru', () => {
    const db = openDatabase(':memory:');
    const plan = planOf(db, () => new PackagesRepo(db).lastRecipientBefore(1, '48601000011', BEFORE, SINCE),
      [1, BEFORE.toISOString(), SINCE.toISOString(), '48601000011']);
    expect(plan).toMatch(/SEARCH r USING COVERING INDEX idx_package_recipients_dest \(dest=\? AND package_id=\?\)/);
  });

  it('odbiorcy rozsyłek na numer w przebiegu doręczenia zaczynają od indeksu numeru', () => {
    const db = openDatabase(':memory:');
    const plan = planOf(db, () => new PackagesRepo(db).recipientsTo(1, '48601000011', SINCE.toISOString(), BEFORE.toISOString()),
      [1, SINCE.toISOString(), BEFORE.toISOString(), '48601000011']);
    expect(plan).toMatch(/SEARCH r USING INDEX idx_package_recipients_dest \(dest=\?\)/);
  });

  it('lista wiadomości klucza bez numeru nie zmienia planu po dodaniu indeksów', () => {
    const db = openDatabase(':memory:');
    const all = planOf(db, () => new MessagesRepo(db).list({ limit: 25, offset: 0 }), [25, 0]);
    expect(all).toMatch(/SCAN messages USING INDEX idx_messages_created/);
    const byKey = planOf(db, () => new MessagesRepo(db).list({ apiKeyId: 1, limit: 25, offset: 0 }), [1, 25, 0]);
    expect(byKey).not.toMatch(/idx_messages_dest_key/);
  });
});
