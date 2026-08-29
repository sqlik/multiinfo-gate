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
  // Dostawa odebranej wskazuje wiadomość kluczem obcym - testy odbioru dostają dwie zasiane.
  const seedInbound = db.prepare(`INSERT INTO inbound_messages (id, account_id, service_id, mi_id, sender, dest, kind, body_hash, protocol_id, coding_scheme, received_at, created_at)
    VALUES (?, ?, '24138', ?, '48601000001', '7968', 'text', 'h', 0, 0, '2026-08-25T09:00:00.000Z', '2026-08-25T09:00:01.000Z')`);
  for (const id of ['in_1', 'in_2']) seedInbound.run(id, accountId, id);
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
    expect(repo.counts(new Date(0))).toEqual({ pending: 1, failed: 0 });
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
    expect(repo.counts(new Date(0))).toEqual({ pending: 0, failed: 1 });
    expect(repo.listRecent(5).map((d) => d.id)).toEqual([id2, id]);
  });

  it('skraca odpowiedź odbiorcy do diagnozy', () => {
    const { repo, apiKeyId } = setup();
    const id = repo.insert({ apiKeyId, event: 'message.sent', payload: '{}', url: 'u', createdAt: NOW });
    repo.markFailed(id, 'x'.repeat(1000));
    expect(repo.get(id)!.lastResponse).toHaveLength(300);
  });
});

describe('WebhookDeliveriesRepo - dostawy odebranych', () => {
  it('pamięta wiadomość przychodzącą i znacznik usunięcia treści', () => {
    const { repo, apiKeyId } = setup();
    const id = repo.insert({ apiKeyId, event: 'message.received', payload: '{"event":"message.received","id":"in_1","text":"Ala","kind":"text"}', url: 'https://crm.example/hook', createdAt: NOW, inboundId: 'in_1', scrubAfter: true });
    const row = repo.get(id)!;
    expect(row.inboundId).toBe('in_1');
    expect(row.scrubAfter).toBe(1);
    expect(repo.listForInbound('in_1').map((d) => d.id)).toEqual([id]);
  });

  it('stan końcowy sam czyści treść, gdy dostawa ma znacznik', () => {
    const { repo, apiKeyId } = setup();
    const payload = JSON.stringify({ event: 'message.received', id: 'in_1', kind: 'text', text: 'Ala ma kota' });
    const failed = repo.insert({ apiKeyId, event: 'message.received', payload, url: 'https://crm.example/hook', createdAt: NOW, inboundId: 'in_1', scrubAfter: true });
    const delivered = repo.insert({ apiKeyId, event: 'message.received', payload, url: 'https://crm.example/hook', createdAt: NOW, inboundId: 'in_1', scrubAfter: true });
    const kept = repo.insert({ apiKeyId, event: 'message.received', payload, url: 'https://crm.example/hook', createdAt: NOW, inboundId: 'in_1', scrubAfter: false });
    repo.markFailed(failed, '410 Gone');
    repo.markDelivered(delivered, NOW, '204');
    repo.markDelivered(kept, NOW, '204');
    expect(JSON.parse(repo.get(failed)!.payload).text).toBeUndefined();
    expect(JSON.parse(repo.get(delivered)!.payload).bodyHash).toHaveLength(64);
    expect(JSON.parse(repo.get(kept)!.payload).text).toBe('Ala ma kota');
  });

  it('liczniki: w toku zawsze, nieudane tylko z okna - stara awaria nie straszy bez końca', () => {
    const { repo, apiKeyId } = setup();
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 86_400_000);
    const base = { apiKeyId, event: 'message.received', payload: '{}', url: 'https://crm.example/hook', inboundId: 'in_1' };
    repo.markFailed(repo.insert({ ...base, createdAt: twoDaysAgo }), '410');
    repo.markFailed(repo.insert({ ...base, createdAt: NOW, inboundId: 'in_2' }), '410');
    repo.insert({ ...base, createdAt: twoDaysAgo });
    const since = new Date(NOW.getTime() - 86_400_000);
    expect(repo.counts(since)).toEqual({ pending: 1, failed: 1 });
    expect(repo.troubledInboundCount(since)).toBe(2);
    expect(repo.troubledInboundCount(new Date(0))).toBe(2);
  });

  it('requeue cofa nieudaną dostawę do oczekującej, jak nową', () => {
    const { repo, apiKeyId } = setup();
    const id = repo.insert({ apiKeyId, event: 'message.sent', payload: '{"id":"msg_1"}', url: 'https://crm.example/hook', createdAt: NOW });
    repo.markFailed(id, '410 Gone');
    repo.requeue(id);
    expect(repo.get(id)).toMatchObject({ status: 'pending', attempts: 0, nextRetryAt: null, lastResponse: null });
  });

  it('listForMessage znajduje dostawy o wysyłce po identyfikatorze w payloadzie', () => {
    const { repo, apiKeyId } = setup();
    const base = { apiKeyId, url: 'https://crm.example/hook', createdAt: NOW };
    const sent = repo.insert({ ...base, event: 'message.sent', payload: '{"event":"message.sent","id":"msg_1"}' });
    const delivered = repo.insert({ ...base, event: 'message.delivered', payload: '{"event":"message.delivered","id":"msg_1"}' });
    repo.insert({ ...base, event: 'message.sent', payload: '{"event":"message.sent","id":"msg_2"}' });
    repo.insert({ ...base, event: 'message.received', payload: '{"event":"message.received","id":"msg_1"}', inboundId: 'in_1' });
    expect(repo.listForMessage('msg_1').map((d) => d.id)).toEqual([sent, delivered]);
  });

  it('scrub podmienia treść na skrót i zostawia resztę payloadu', () => {
    const { repo, apiKeyId } = setup();
    const id = repo.insert({ apiKeyId, event: 'message.received', payload: JSON.stringify({ event: 'message.received', id: 'in_1', kind: 'text', text: 'Ala ma kota' }), url: 'https://crm.example/hook', createdAt: NOW, inboundId: 'in_1', scrubAfter: true });
    repo.scrub(id);
    const payload = JSON.parse(repo.get(id)!.payload);
    expect(payload.text).toBeUndefined();
    expect(payload.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.id).toBe('in_1');
    expect(repo.get(id)!.scrubAfter).toBe(0);
  });

  it('liczy odebrane z dostawą w toku albo nieudaną, bez powtórzeń', () => {
    const { repo, apiKeyId } = setup();
    const a = repo.insert({ apiKeyId, event: 'message.received', payload: '{}', url: 'u', createdAt: NOW, inboundId: 'in_1' });
    repo.insert({ apiKeyId, event: 'message.received', payload: '{}', url: 'u', createdAt: NOW, inboundId: 'in_1' });
    const c = repo.insert({ apiKeyId, event: 'message.received', payload: '{}', url: 'u', createdAt: NOW, inboundId: 'in_2' });
    repo.insert({ apiKeyId, event: 'message.sent', payload: '{}', url: 'u', createdAt: NOW });
    expect(repo.troubledInboundCount(new Date(0))).toBe(2);
    repo.markDelivered(a, NOW, '204');
    expect(repo.troubledInboundCount(new Date(0))).toBe(2);
    repo.markFailed(c, '500');
    expect(repo.troubledInboundCount(new Date(0))).toBe(2);
  });
});
