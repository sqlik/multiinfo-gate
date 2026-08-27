import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { WebhookDeliveriesRepo } from '../../src/store/webhook-deliveries.ts';
import { accountInput, testKey } from './helpers.ts';

const NOW = new Date('2026-08-25T10:00:00Z');

function setup() {
  const db = openDatabase(':memory:');
  const key = testKey();
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const apiKeyId = new ApiKeysRepo(db, key).insert({
    accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, webhookUrl: 'https://crm.example/hook', webhookSecret: 's', serviceIds: ['24138'],
  });
  return { repo: new WebhookDeliveriesRepo(db), apiKeyId };
}

describe('WebhookDeliveriesRepo', () => {
  it('zapisuje dostawę jako oczekującą', () => {
    const { repo, apiKeyId } = setup();
    const id = repo.insert({ apiKeyId, event: 'message.sent', payload: '{"id":"msg_1"}', url: 'https://crm.example/hook', createdAt: NOW });
    const row = repo.get(id)!;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.createdAt).toBe(NOW.toISOString());
    expect(repo.counts()).toEqual({ pending: 1, failed: 0 });
  });

  it('odnotowuje ponowienie, dostarczenie i porażkę', () => {
    const { repo, apiKeyId } = setup();
    const id = repo.insert({ apiKeyId, event: 'message.sent', payload: '{}', url: 'u', createdAt: NOW });
    repo.markRetry(id, new Date(NOW.getTime() + 60_000), '503 Service Unavailable');
    expect(repo.get(id)!.attempts).toBe(1);
    expect(repo.get(id)!.nextRetryAt).toBe('2026-08-25T10:01:00.000Z');
    expect(repo.get(id)!.lastResponse).toBe('503 Service Unavailable');
    repo.markDelivered(id, NOW, '200 OK');
    expect(repo.get(id)!.status).toBe('delivered');
    expect(repo.get(id)!.attempts).toBe(2);
    expect(repo.get(id)!.nextRetryAt).toBeNull();
    expect(repo.get(id)!.deliveredAt).toBe(NOW.toISOString());
    const id2 = repo.insert({ apiKeyId, event: 'message.failed', payload: '{}', url: 'u', createdAt: NOW });
    repo.markFailed(id2, 'timeout');
    expect(repo.counts()).toEqual({ pending: 0, failed: 1 });
    expect(repo.listRecent(5).map((d) => d.id)).toEqual([id2, id]);
  });

  it('skraca odpowiedź odbiorcy do diagnozy', () => {
    const { repo, apiKeyId } = setup();
    const id = repo.insert({ apiKeyId, event: 'message.sent', payload: '{}', url: 'u', createdAt: NOW });
    repo.markFailed(id, 'x'.repeat(1000));
    expect(repo.get(id)!.lastResponse).toHaveLength(300);
  });
});
