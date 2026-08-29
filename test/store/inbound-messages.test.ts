import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { InboundMessagesRepo, type InboundInput } from '../../src/store/inbound-messages.ts';
import { accountInput, testKey } from './helpers.ts';

let db: Database;
let accounts: AccountsRepo;
let repo: InboundMessagesRepo;
let accountId: number;

const input = (over: Partial<InboundInput> = {}): InboundInput => ({
  id: 'in_1', accountId, serviceId: '24138', miId: '22', sender: '48601000001', dest: '7968',
  kind: 'text', body: 'Dziekuje', bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: '60199',
  relatedMessageId: null, receivedAt: '2026-08-29T07:14:00.000Z', createdAt: '2026-08-29T07:14:02.000Z', ...over,
});

beforeEach(() => {
  db = openDatabase(':memory:');
  accounts = new AccountsRepo(db, testKey());
  accountId = accounts.insert(accountInput());
  repo = new InboundMessagesRepo(db);
});

describe('InboundMessagesRepo', () => {
  it('wstawia nową i odrzuca duplikat po identyfikatorze MI', () => {
    expect(repo.insertIfNew(input())).toBe(true);
    expect(repo.insertIfNew(input({ id: 'in_2' }))).toBe(false);
    expect(repo.get('in_2')).toBeUndefined();
    expect(repo.get('in_1')?.sender).toBe('48601000001');
  });

  it('ten sam identyfikator MI na innym koncie to inna wiadomość', () => {
    const other = accounts.insert(accountInput({ name: 'Inna', login: 'inna' }));
    expect(repo.insertIfNew(input())).toBe(true);
    expect(repo.insertIfNew(input({ id: 'in_2', accountId: other }))).toBe(true);
    expect(() => repo.insertIfNew(input({ id: 'in_3', accountId: 999 }))).toThrow(/FOREIGN KEY/);
  });

  it('lista filtruje po usługach klucza, nadawcy i czasie, od najnowszej', () => {
    repo.insertIfNew(input({ id: 'in_1', miId: '1', createdAt: '2026-08-29T07:00:00.000Z', receivedAt: '2026-08-29T07:00:00.000Z' }));
    repo.insertIfNew(input({ id: 'in_2', miId: '2', serviceId: '24902', createdAt: '2026-08-29T08:00:00.000Z', receivedAt: '2026-08-29T08:00:00.000Z' }));
    repo.insertIfNew(input({ id: 'in_3', miId: '3', sender: '48605000001', createdAt: '2026-08-29T09:00:00.000Z', receivedAt: '2026-08-29T09:00:00.000Z' }));
    expect(repo.list({ serviceIds: ['24138'], limit: 10, offset: 0 }).map((r) => r.id)).toEqual(['in_3', 'in_1']);
    expect(repo.list({ serviceIds: ['24138'], sender: '48605000001', limit: 10, offset: 0 }).map((r) => r.id)).toEqual(['in_3']);
    expect(repo.list({ since: '2026-08-29T07:30:00.000Z', until: '2026-08-29T08:30:00.000Z', limit: 10, offset: 0 }).map((r) => r.id)).toEqual(['in_2']);
    expect(repo.list({ serviceIds: [], limit: 10, offset: 0 })).toEqual([]);
    expect(repo.list({ limit: 1, offset: 1 }).map((r) => r.id)).toEqual(['in_2']);
    expect(repo.list({ accountId: 999, limit: 10, offset: 0 })).toEqual([]);
  });

  it('liczy odebrane od chwili', () => {
    repo.insertIfNew(input({ id: 'in_1', miId: '1', createdAt: '2026-08-28T07:00:00.000Z' }));
    repo.insertIfNew(input({ id: 'in_2', miId: '2', createdAt: '2026-08-29T07:00:00.000Z' }));
    expect(repo.countSince(new Date('2026-08-29T00:00:00Z'))).toBe(1);
  });
});
