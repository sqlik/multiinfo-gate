import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { accountInput, messageInput, testKey } from './helpers.ts';

const at = (s: number) => new Date(Date.parse('2026-08-25T10:00:00Z') + s * 1000);

function setup() {
  const db = openDatabase(':memory:');
  const key = testKey();
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const apiKeyId = new ApiKeysRepo(db, key).insert({
    accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  new MessagesRepo(db).insert(messageInput({ accountId, apiKeyId }));
  return new MessageEventsRepo(db);
}

describe('MessageEventsRepo', () => {
  it('zwraca zdarzenia w kolejności zapisu', () => {
    const repo = setup();
    repo.record('msg_1', at(0), 'queued', null);
    repo.record('msg_1', at(1), 'sent', '8841207, 8841208');
    expect(repo.list('msg_1').map((e) => e.kind)).toEqual(['queued', 'sent']);
    expect(repo.list('msg_1')[1]!.detail).toBe('8841207, 8841208');
    expect(repo.list('msg_1')[0]!.at).toBe('2026-08-25T10:00:00.000Z');
  });

  it('nie miesza zdarzeń różnych wiadomości', () => {
    const repo = setup();
    repo.record('msg_1', at(0), 'queued', null);
    expect(repo.list('msg_inna')).toEqual([]);
  });
});
