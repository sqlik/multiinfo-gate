import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../src/api/server.ts';
import { generateApiKey } from '../../src/api/keys.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';

const masterKey = randomBytes(32);
const NOW = new Date('2026-08-25T10:00:00Z');

let app: ReturnType<typeof buildApiServer>;
let adminApp: ReturnType<typeof buildApiServer>;
let baseDeps: Omit<Parameters<typeof buildApiServer>[0], 'healthMode'>;
let keyA: string;
let keyB: string;
let accounts: AccountsRepo;
let messages: MessagesRepo;
let accountId: number;
let quietAccountId: number;
let apiKeyAId: number;

function account(name: string, storeContent: 0 | 1, accountsRepo: AccountsRepo, notAfter = '2027-03-14') {
  return accountsRepo.insert({
    name, baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: notAfter,
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent, serviceIds: ['24138'],
  });
}

function seed(id: string, apiKeyId: number, acct: number, patch: Partial<{
  dest: string; body: string | null; status: string; createdAt: string;
}> = {}) {
  messages.insert({
    id, apiKeyId, accountId: acct, serviceId: '24138',
    dest: patch.dest ?? '48601135134',
    body: patch.body === undefined ? 'Ala ma kota' : patch.body,
    bodyHash: 'h', encoding: 'gsm', parts: 1, slots: 11,
    orig: 'Firma Info', costCenter: null, validTo: null, idempotencyKey: null,
    createdAt: patch.createdAt ?? NOW.toISOString(),
  });
  if (patch.status) messages.setStatus(id, { status: patch.status as never });
  return id;
}

beforeEach(async () => {
  const db = openDatabase(':memory:');
  accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  messages = new MessagesRepo(db);
  const jobs = new JobsRepo(db);

  accountId = account('Firma Info', 1, accounts);
  quietAccountId = account('Windykacja', 0, accounts);

  const a = generateApiKey();
  const b = generateApiKey();
  keyA = a.key;
  keyB = b.key;
  apiKeyAId = apiKeys.insert({
    accountId, name: 'Klucz A', keyHash: a.hash, keyPrefix: a.prefix,
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 600,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  apiKeys.insert({
    accountId, name: 'Klucz B', keyHash: b.hash, keyPrefix: b.prefix,
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 600,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });

  const deps = {
    accounts, apiKeys, messages, events: new MessageEventsRepo(db), jobs, packages: new PackagesRepo(db),
    clients: {} as never, inbound: new InboundMessagesRepo(db),
    rateLimiter: new RateLimiter(), now: () => NOW, ...integrationDeps(db, masterKey),
  };
  baseDeps = deps;
  app = buildApiServer({ ...deps, healthMode: 'public' });
  adminApp = buildApiServer({ ...deps, healthMode: 'admin' });
  await app.ready();
  await adminApp.ready();
});

const get = (url: string, key = keyA) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });

describe('GET /v1/messages/:id', () => {
  it('zwraca status i metadane wiadomości', async () => {
    seed('msg_a1', apiKeyAId, accountId);
    const res = await get('/v1/messages/msg_a1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('msg_a1');
    expect(body.status).toBe('queued');
    expect(body.to).toBe('48601135134');
    expect(body.encoding).toBe('gsm');
    expect(body.parts).toBe(1);
    expect(body.slots).toBe(11);
    expect(body.serviceId).toBe('24138');
    expect(body.inReplyTo).toBeNull();
    expect(body.createdAt).toBeTruthy();
  });

  it('podaje inReplyTo dla odpowiedzi w wątku', async () => {
    baseDeps.inbound.insertIfNew({
      id: 'in_1', accountId, serviceId: '24138', miId: '22', sender: '48601135134', dest: '7968', kind: 'text', body: 'Pytanie',
      bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null,
      receivedAt: NOW.toISOString(), createdAt: NOW.toISOString(),
    });
    messages.insert({
      id: 'msg_r', apiKeyId: apiKeyAId, accountId, serviceId: '24138', dest: '48601135134', body: null, bodyHash: 'h',
      encoding: 'gsm', parts: 1, slots: 11, orig: null, costCenter: null, validTo: null, idempotencyKey: null, inReplyTo: 'in_1',
    });
    expect((await get('/v1/messages/msg_r')).json().inReplyTo).toBe('in_1');
    expect((await get('/v1/messages')).json().data[0].inReplyTo).toBe('in_1');
  });

  it('podaje treść, gdy konto ją przechowuje', async () => {
    seed('msg_a1', apiKeyAId, accountId, { body: 'Ala ma kota' });
    expect((await get('/v1/messages/msg_a1')).json().text).toBe('Ala ma kota');
  });

  it('nie ujawnia treści, gdy konto ma wyłączone przechowywanie', async () => {
    seed('msg_a2', apiKeyAId, quietAccountId, { body: null });
    const body = (await get('/v1/messages/msg_a2')).json();
    expect(body).not.toHaveProperty('text');
    expect(body.status).toBe('queued');
  });

  it('zwraca 404 dla nieznanego identyfikatora', async () => {
    const res = await get('/v1/messages/msg_nieistnieje');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('message_not_found');
  });

  it('zwraca 404 dla wiadomości należącej do innego klucza', async () => {
    seed('msg_a1', apiKeyAId, accountId);
    const res = await get('/v1/messages/msg_a1', keyB);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('message_not_found');
  });

  it('odrzuca żądanie bez klucza', async () => {
    seed('msg_a1', apiKeyAId, accountId);
    const res = await app.inject({ method: 'GET', url: '/v1/messages/msg_a1' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/messages', () => {
  beforeEach(() => {
    seed('msg_a1', apiKeyAId, accountId, { status: 'delivered', dest: '48601135134' });
    seed('msg_a2', apiKeyAId, accountId, { status: 'failed', dest: '48601135135' });
    seed('msg_a3', apiKeyAId, accountId, { status: 'delivered', dest: '48601135136' });
  });

  it('zwraca wszystkie wiadomości klucza', async () => {
    const body = (await get('/v1/messages')).json();
    expect(body.data).toHaveLength(3);
    expect(body.hasMore).toBe(false);
  });

  it('filtruje po statusie', async () => {
    const body = (await get('/v1/messages?status=delivered')).json();
    expect(body.data.map((m: { id: string }) => m.id).sort()).toEqual(['msg_a1', 'msg_a3']);
  });

  it('filtruje po numerze odbiorcy', async () => {
    const body = (await get('/v1/messages?to=48601135135')).json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('msg_a2');
  });

  it('filtruje po zakresie dat', async () => {
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();
    expect((await get(`/v1/messages?from=${future}`)).json().data).toHaveLength(0);
    const past = new Date(NOW.getTime() - 86_400_000).toISOString();
    expect((await get(`/v1/messages?from=${past}`)).json().data).toHaveLength(3);
  });

  it('stronicuje i zwraca hasMore', async () => {
    const first = (await get('/v1/messages?limit=2')).json();
    expect(first.data).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = (await get('/v1/messages?limit=2&offset=2')).json();
    expect(second.data).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it('ujemny albo zerowy limit nie zdejmuje ograniczenia strony', async () => {
    const body = (await get('/v1/messages?limit=-1&offset=-5')).json();
    expect(body.data).toHaveLength(3);
    expect(body.hasMore).toBe(false);
    expect((await get('/v1/messages?limit=0')).json().data).toHaveLength(3);
  });

  it('zwraca wyłącznie wiadomości bieżącego klucza', async () => {
    expect((await get('/v1/messages', keyB)).json().data).toHaveLength(0);
  });
});

describe('GET /healthz', () => {
  it('na porcie publicznym zwraca sam status bez szczegółów', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.body).not.toContain('version');
    expect(res.body).not.toContain('Firma');
    expect(res.body).not.toContain('2027-03-14');
  });

  it('na porcie panelu zwraca głębokość kolejki i dni do wygaśnięcia certyfikatów', async () => {
    const body = (await adminApp.inject({ method: 'GET', url: '/healthz' })).json();
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.queueDepth).toBe(0);
    const firma = body.accounts.find((a: { name: string }) => a.name === 'Firma Info');
    expect(firma.certificateDaysLeft).toBeGreaterThan(190);
    expect(firma.paused).toBeNull();
  });

  it('zwraca degraded, gdy któreś konto jest wstrzymane', async () => {
    accounts.pause(accountId, 'Certyfikat odrzucony, kod -85');
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().status).toBe('degraded');
  });

  it('zwraca degraded, gdy certyfikat wygasa w ciągu siedmiu dni', async () => {
    const soon = new Date(NOW.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
    account('Krótki', 1, accounts, soon);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().status).toBe('degraded');
  });

  it('nie wymaga klucza API', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('podaje stan odbiornika i pogarsza status przy błędzie usługi', async () => {
    const inbound = { services: 2, listening: 1, errors: [{ account: 'Firma', serviceId: '24138', error: '-24: nieaktywna' }] };
    const withInbound = buildApiServer({ ...baseDeps, healthMode: 'admin', inboundHealth: () => inbound });
    const res = await withInbound.inject({ method: 'GET', url: '/healthz' });
    expect(res.json().status).toBe('degraded');
    expect(res.json().inbound).toEqual(inbound);
  });

  it('bez błędów odbiornika status zostaje ok', async () => {
    const withInbound = buildApiServer({ ...baseDeps, healthMode: 'admin', inboundHealth: () => ({ services: 1, listening: 1, errors: [] }) });
    const res = await withInbound.inject({ method: 'GET', url: '/healthz' });
    expect(res.json().status).toBe('ok');
    expect(res.json().inbound.listening).toBe(1);
  });

  it('tryb publiczny nie zdradza stanu odbiornika', async () => {
    const withInbound = buildApiServer({ ...baseDeps, inboundHealth: () => ({ services: 1, listening: 0, errors: [{ account: 'Firma', serviceId: '24138', error: 'x' }] }) });
    const res = await withInbound.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ status: 'degraded' });
  });
});
