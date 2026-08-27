import { describe, expect, it } from 'vitest';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { accountInput, messageInput, testKey } from './helpers.ts';

const setup = () => {
  const key = testKey();
  const db = openDatabase(':memory:');
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const apiKeyId = new ApiKeysRepo(db, key).insert({
    accountId, name: 'rejestracja', keyHash: 'argon2:aaa', keyPrefix: 'mig_live_a1b2c3',
    defaultServiceId: '24138', defaultOrig: null, maxParts: 9, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  return { db, accountId, apiKeyId, messages: new MessagesRepo(db) };
};

describe('MessagesRepo', () => {
  it('zapisuje wiadomość i odczytuje ją po identyfikatorze', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ accountId, apiKeyId, slots: 180, parts: 2 }));

    const row = messages.get('msg_1');
    expect(row?.dest).toBe('48601135134');
    expect(row?.status).toBe('queued');
    expect(row?.parts).toBe(2);
    expect(row?.miIds).toEqual([]);
    expect(row?.body).toBeNull();
  });

  it('zapisuje datę utworzenia w tym samym formacie, co pozostałe znaczniki czasu', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ accountId, apiKeyId }));
    // Filtry zakresu dat porównują tekst, więc created_at musi być zapisane
    // tak samo jak wartości podawane z zewnątrz - w postaci ISO 8601 z Z.
    expect(messages.get('msg_1')!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('filtruje po statusie, numerze i zakresie dat', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ id: 'msg_1', accountId, apiKeyId, dest: '48601135134' }));
    messages.insert(messageInput({ id: 'msg_2', accountId, apiKeyId, dest: '48602222222' }));
    messages.setStatus('msg_2', { status: 'delivered', finalAt: new Date() });

    expect(messages.list({ limit: 10, offset: 0 })).toHaveLength(2);
    expect(messages.list({ status: 'delivered', limit: 10, offset: 0 }).map((m) => m.id)).toEqual(['msg_2']);
    expect(messages.list({ dest: '48601135134', limit: 10, offset: 0 }).map((m) => m.id)).toEqual(['msg_1']);
    expect(messages.list({ apiKeyId, limit: 10, offset: 0 })).toHaveLength(2);

    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const hourAhead = new Date(Date.now() + 3_600_000).toISOString();
    expect(messages.list({ from: hourAgo, until: hourAhead, limit: 10, offset: 0 })).toHaveLength(2);
    expect(messages.list({ from: hourAhead, limit: 10, offset: 0 })).toHaveLength(0);
  });

  it('ogranicza wynik przez limit i offset', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ id: 'msg_1', accountId, apiKeyId }));
    messages.insert(messageInput({ id: 'msg_2', accountId, apiKeyId }));
    expect(messages.list({ limit: 1, offset: 0 })).toHaveLength(1);
    expect(messages.list({ limit: 1, offset: 1 })).toHaveLength(1);
    expect(messages.list({ limit: 10, offset: 2 })).toHaveLength(0);
  });

  it('setSent zapisuje identyfikatory od operatora i przestawia status', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ accountId, apiKeyId }));
    messages.setSent('msg_1', ['123456789', '123456790'], new Date('2026-08-25T10:00:00Z'));

    const row = messages.get('msg_1')!;
    expect(row.status).toBe('sent');
    expect(row.miIds).toEqual(['123456789', '123456790']);
    expect(row.sentAt).toBe('2026-08-25T10:00:00.000Z');
  });

  it('setStatus z finalAt zamyka wiadomość i zachowuje kody operatora', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ accountId, apiKeyId }));
    messages.setStatus('msg_1', { status: 'failed', miStatus: 3, miSubstatus: 5, error: 'numer nieosiągalny', finalAt: new Date('2026-08-25T10:05:00Z') });

    const row = messages.get('msg_1')!;
    expect(row.status).toBe('failed');
    expect(row.miStatus).toBe(3);
    expect(row.miSubstatus).toBe(5);
    expect(row.error).toBe('numer nieosiągalny');
    expect(row.finalAt).toBe('2026-08-25T10:05:00.000Z');
  });

  it('setStatus bez kodów nie kasuje wartości zapisanych wcześniej', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ accountId, apiKeyId }));
    messages.setStatus('msg_1', { status: 'sent', miStatus: 1, miSubstatus: 0 });
    messages.setStatus('msg_1', { status: 'delivered', finalAt: new Date('2026-08-25T10:05:00Z') });

    const row = messages.get('msg_1')!;
    expect(row.miStatus).toBe(1);
    expect(row.finalAt).toBe('2026-08-25T10:05:00.000Z');
  });

  it('findByIdempotencyKey wykrywa powtórzone żądanie tego samego klucza', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ accountId, apiKeyId, idempotencyKey: 'zam-2026-08-25-001' }));

    expect(messages.findByIdempotencyKey(apiKeyId, 'zam-2026-08-25-001')?.id).toBe('msg_1');
    expect(messages.findByIdempotencyKey(apiKeyId, 'inny')).toBeUndefined();
    expect(messages.findByIdempotencyKey(apiKeyId + 1, 'zam-2026-08-25-001')).toBeUndefined();
  });

  it('odrzuca drugą wiadomość z tym samym kluczem powtórzenia', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ id: 'msg_1', accountId, apiKeyId, idempotencyKey: 'zam-001' }));
    expect(() => messages.insert(messageInput({ id: 'msg_2', accountId, apiKeyId, idempotencyKey: 'zam-001' })))
      .toThrow();
  });

  it('countSince liczy w rozbiciu na doręczone i nieudane', () => {
    const { messages, accountId, apiKeyId } = setup();
    for (const id of ['msg_1', 'msg_2', 'msg_3', 'msg_4']) {
      messages.insert(messageInput({ id, accountId, apiKeyId }));
    }
    messages.setStatus('msg_1', { status: 'delivered', finalAt: new Date() });
    messages.setStatus('msg_2', { status: 'failed', finalAt: new Date() });
    messages.setStatus('msg_3', { status: 'blocked', finalAt: new Date() });

    const since = new Date(Date.now() - 3_600_000);
    expect(messages.countSince(since)).toEqual({ total: 4, delivered: 1, failed: 2, cancelled: 0, transit: 1 });
    expect(messages.countSince(new Date(Date.now() + 3_600_000))).toEqual({ total: 0, delivered: 0, failed: 0, cancelled: 0, transit: 0 });
  });

  it('recentFailures zwraca tylko wiadomości nieudane i zablokowane', () => {
    const { messages, accountId, apiKeyId } = setup();
    for (const id of ['msg_1', 'msg_2', 'msg_3']) {
      messages.insert(messageInput({ id, accountId, apiKeyId }));
    }
    messages.setStatus('msg_1', { status: 'delivered', finalAt: new Date('2026-08-25T10:00:00Z') });
    messages.setStatus('msg_2', { status: 'failed', finalAt: new Date('2026-08-25T10:01:00Z') });
    messages.setStatus('msg_3', { status: 'blocked', finalAt: new Date('2026-08-25T10:02:00Z') });

    expect(messages.recentFailures(10).map((m) => m.id)).toEqual(['msg_3', 'msg_2']);
    expect(messages.recentFailures(1).map((m) => m.id)).toEqual(['msg_3']);
  });

  it('zapisuje i odczytuje ślad protokołu', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ accountId, apiKeyId }));
    expect(messages.get('msg_1')!.trace).toBeNull();
    messages.setTrace('msg_1', {
      at: '2026-08-25T10:00:00.000Z', durationMs: 412, script: 'sendsmslong.aspx',
      params: { login: 'firma_api', password: '••••••••', dest: '48601135134' }, httpStatus: 200, lines: ['8841207'],
    });
    expect(messages.get('msg_1')!.trace?.lines).toEqual(['8841207']);
    expect(messages.get('msg_1')!.trace?.params.password).toBe('••••••••');
  });
  it('inTransitCount liczy wiadomości w kolejce, przekazane i dławione', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ id: 'q', accountId, apiKeyId }));
    messages.insert(messageInput({ id: 's', accountId, apiKeyId }));
    messages.setSent('s', ['1'], new Date());
    messages.insert(messageInput({ id: 't', accountId, apiKeyId }));
    messages.setStatus('t', { status: 'throttled' });
    messages.insert(messageInput({ id: 'd', accountId, apiKeyId }));
    messages.setStatus('d', { status: 'delivered' });
    messages.insert(messageInput({ id: 'c', accountId, apiKeyId }));
    messages.setStatus('c', { status: 'cancelled' });
    expect(messages.inTransitCount()).toBe(3);
  });
  it('countSince rozbija przyjęte na doręczone, niedoręczone, anulowane i w drodze', () => {
    const { messages, accountId, apiKeyId } = setup();
    const add = (id: string, status?: string) => {
      messages.insert(messageInput({ id, accountId, apiKeyId }));
      if (status) messages.setStatus(id, { status: status as never });
    };
    add('a', 'delivered'); add('b', 'delivered'); add('c', 'failed'); add('d', 'blocked');
    add('e', 'cancelled'); add('f'); add('g', 'throttled');
    const c = messages.countSince(new Date(0));
    expect(c).toEqual({ total: 7, delivered: 2, failed: 2, cancelled: 1, transit: 2 });
    expect(c.delivered + c.failed + c.cancelled + c.transit).toBe(c.total);
  });

  it('list ze statusem transit zwraca trzy statusy w drodze', () => {
    const { messages, accountId, apiKeyId } = setup();
    messages.insert(messageInput({ id: 'q', accountId, apiKeyId }));
    messages.insert(messageInput({ id: 't', accountId, apiKeyId }));
    messages.setStatus('t', { status: 'throttled' });
    messages.insert(messageInput({ id: 'd', accountId, apiKeyId }));
    messages.setStatus('d', { status: 'delivered' });
    expect(messages.list({ status: 'transit', limit: 10, offset: 0 }).map((m) => m.id).sort()).toEqual(['q', 't']);
  });
});
