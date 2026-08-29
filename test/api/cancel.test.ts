import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateApiKey } from '../../src/api/keys.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { ProviderError } from '../../src/multiinfo/response.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';

const masterKey = randomBytes(32);
const NOW = new Date('2026-08-25T10:00:00Z');

let app: ReturnType<typeof buildApiServer>;
let keyA: string;
let messages: MessagesRepo;
let events: MessageEventsRepo;
let accountId: number;
let apiKeyAId: number;
let apiKeyBId: number;
let cancel: ReturnType<typeof vi.fn>;

function seed(id: string, apiKeyId: number, acct: number, patch: Partial<{ status: string }> = {}) {
  messages.insert({
    id, apiKeyId, accountId: acct, serviceId: '24138', dest: '48601135134',
    body: 'Ala ma kota', bodyHash: 'h', encoding: 'gsm', parts: 1, slots: 11,
    orig: 'Firma Info', costCenter: null, validTo: null, idempotencyKey: null,
    createdAt: NOW.toISOString(),
  });
  if (patch.status) messages.setStatus(id, { status: patch.status as never, finalAt: NOW });
  return id;
}

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  messages = new MessagesRepo(db);
  events = new MessageEventsRepo(db);
  const jobs = new JobsRepo(db);

  accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent: 1, serviceIds: ['24138'],
  });

  const a = generateApiKey();
  const b = generateApiKey();
  keyA = a.key;
  const keyInput = (name: string, g: typeof a) => ({
    accountId, name, keyHash: g.hash, keyPrefix: g.prefix,
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 600,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  apiKeyAId = apiKeys.insert(keyInput('Klucz A', a));
  apiKeyBId = apiKeys.insert(keyInput('Klucz B', b));

  cancel = vi.fn();
  app = buildApiServer({
    accounts, apiKeys, messages, jobs, events, packages: new PackagesRepo(db), inbound: new InboundMessagesRepo(db),
    rateLimiter: new RateLimiter(), now: () => NOW,
    clients: { for: () => ({ cancel }), invalidate: vi.fn(), closeAll: vi.fn() } as never,
  });
  await app.ready();
});

const post = (url: string, key = keyA) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${key}` } });

describe('POST /v1/messages/:id/cancel', () => {
  it('anuluje lokalnie wiadomość, która nie wyszła do Multiinfo', async () => {
    seed('msg_q', apiKeyAId, accountId);
    const res = await post('/v1/messages/msg_q/cancel');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'msg_q', status: 'cancelled' });
    expect(messages.get('msg_q')!.status).toBe('cancelled');
    expect(messages.get('msg_q')!.finalAt).toBe(NOW.toISOString());
    expect(cancel).not.toHaveBeenCalled();
    expect(events.list('msg_q').at(-1)!.kind).toBe('cancelled');
    expect(events.list('msg_q').at(-1)!.detail).toContain('przed przekazaniem');
  });

  it('anuluje w Multiinfo każdą część wiadomości już przekazanej', async () => {
    seed('msg_s', apiKeyAId, accountId);
    messages.setSent('msg_s', ['1', '2'], NOW);
    cancel.mockResolvedValue(undefined);
    const res = await post('/v1/messages/msg_s/cancel');
    expect(res.statusCode).toBe(200);
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(['1', '2']);
    expect(messages.get('msg_s')!.status).toBe('cancelled');
    expect(events.list('msg_s').at(-1)!.detail).toBe('cancelsms.aspx: 1, 2');
  });

  it('odpowiada 409, gdy Multiinfo zwróci -41', async () => {
    seed('msg_s', apiKeyAId, accountId);
    messages.setSent('msg_s', ['1'], NOW);
    cancel.mockRejectedValue(new ProviderError(-41, 'wiadomość już została przekazana', 'permanent'));
    const res = await post('/v1/messages/msg_s/cancel');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_passed');
    expect(res.json().error.providerCode).toBe(-41);
    expect(messages.get('msg_s')!.status).toBe('sent');
  });

  it('odnotowuje częściowe anulowanie, gdy druga część już poszła', async () => {
    seed('msg_s', apiKeyAId, accountId);
    messages.setSent('msg_s', ['1', '2'], NOW);
    cancel.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ProviderError(-41, 'wiadomość już została przekazana', 'permanent'));
    const res = await post('/v1/messages/msg_s/cancel');
    expect(res.statusCode).toBe(409);
    expect(events.list('msg_s').map((e) => e.kind)).toEqual(['cancel_partial']);
    expect(events.list('msg_s')[0]!.detail).toContain('1');
  });

  it('odpowiada 409 dla wiadomości w stanie ostatecznym', async () => {
    seed('msg_d', apiKeyAId, accountId, { status: 'delivered' });
    const res = await post('/v1/messages/msg_d/cancel');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_final');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('nie pozwala anulować cudzej wiadomości', async () => {
    seed('msg_b', apiKeyBId, accountId);
    const res = await post('/v1/messages/msg_b/cancel');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('message_not_found');
    expect(messages.get('msg_b')!.status).toBe('queued');
  });

  it('mapuje błąd certyfikatu na 503, a inny błąd operatora na 502', async () => {
    seed('msg_s', apiKeyAId, accountId);
    messages.setSent('msg_s', ['1'], NOW);
    cancel.mockRejectedValueOnce(new ProviderError(-85, 'CN', 'certificate'));
    const first = await post('/v1/messages/msg_s/cancel');
    expect(first.statusCode).toBe(503);
    expect(first.json().error.code).toBe('account_certificate');
    cancel.mockRejectedValueOnce(new ProviderError(-15, 'Brak bazy', 'transient'));
    const second = await post('/v1/messages/msg_s/cancel');
    expect(second.statusCode).toBe(502);
    expect(second.json().error.code).toBe('provider_error');
    expect(second.json().error.providerCode).toBe(-15);
  });

  it('odrzuca żądanie bez klucza', async () => {
    seed('msg_q', apiKeyAId, accountId);
    expect((await app.inject({ method: 'POST', url: '/v1/messages/msg_q/cancel' })).statusCode).toBe(401);
  });
});
