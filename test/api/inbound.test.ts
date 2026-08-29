import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../src/api/server.ts';
import { generateApiKey } from '../../src/api/keys.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo, type InboundInput } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';

const masterKey = randomBytes(32);
const NOW = new Date('2026-08-29T10:00:00Z');
let app: ReturnType<typeof buildApiServer>;
let inbound: InboundMessagesRepo;
let accountId: number;
let keyA: string;
let keyB: string;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  inbound = new InboundMessagesRepo(db);
  accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: null, storeContent: 1, serviceIds: ['24138', '24902'],
  });
  const a = generateApiKey();
  const b = generateApiKey();
  keyA = a.key;
  keyB = b.key;
  const base = { accountId, defaultOrig: null, maxParts: 5, ratePerMin: 600, webhookUrl: null, webhookSecret: null };
  apiKeys.insert({ ...base, name: 'Klucz A', keyHash: a.hash, keyPrefix: a.prefix, defaultServiceId: '24138', serviceIds: ['24138'] });
  apiKeys.insert({ ...base, name: 'Klucz B', keyHash: b.hash, keyPrefix: b.prefix, defaultServiceId: '24902', serviceIds: ['24902'] });
  app = buildApiServer({
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
    packages: new PackagesRepo(db), clients: {} as never, inbound, rateLimiter: new RateLimiter(), now: () => NOW,
  });
  await app.ready();
});

const seed = (id: string, over: Partial<InboundInput> = {}) => inbound.insertIfNew({
  id, accountId, serviceId: '24138', miId: id, sender: '48601000001', dest: '7968', kind: 'text',
  body: 'Dziekuje', bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null,
  receivedAt: '2026-08-29T07:14:00.000Z', createdAt: '2026-08-29T07:14:02.000Z', ...over,
});
const get = (url: string, key = keyA) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
const ids = (res: { json: () => { data: Array<{ id: string }> } }) => res.json().data.map((r) => r.id);

describe('GET /v1/inbound', () => {
  it('filtr from przyjmuje numer w dowolnym zapisie - normalizuje jak nadawcę przy zapisie', async () => {
    seed('in_1', { sender: '48601000001' });
    seed('in_2', { sender: '7968' });
    expect(ids(await get('/v1/inbound?from=' + encodeURIComponent('+48 601-000-001')))).toEqual(['in_1']);
    expect(ids(await get('/v1/inbound?from=601000001'))).toEqual(['in_1']);
    expect(ids(await get('/v1/inbound?from=7968'))).toEqual(['in_2']);
  });

  it('parametr podany więcej niż raz to 400, nie błąd wewnętrzny', async () => {
    seed('in_1');
    const res = await get('/v1/inbound?from=48601000001&from=48601000002');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_query');
  });

  it('zwraca wiadomości z usług klucza, od najnowszej, z hasMore', async () => {
    seed('in_1', { createdAt: '2026-08-29T07:00:00.000Z' });
    seed('in_2', { createdAt: '2026-08-29T08:00:00.000Z' });
    seed('in_3', { serviceId: '24902' });
    const res = await get('/v1/inbound?limit=1');
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual(['in_2']);
    expect(res.json().hasMore).toBe(true);
    expect((await get('/v1/inbound?limit=1&offset=1')).json()).toMatchObject({ data: [{ id: 'in_1' }], hasMore: false });
    expect(ids(await get('/v1/inbound', keyB))).toEqual(['in_3']);
  });

  it('kształt wiadomości: pola webhooka plus protokół, treść tylko przechowywana', async () => {
    seed('in_1', { relatedMessageId: null });
    seed('in_2', { body: null, kind: 'binary' });
    const rows = (await get('/v1/inbound')).json().data;
    expect(rows[1]).toEqual({
      id: 'in_1', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text: 'Dziekuje',
      receivedAt: '2026-08-29T07:14:00.000Z', relatedMessageId: null, protocolId: 0, codingScheme: 0, createdAt: '2026-08-29T07:14:02.000Z',
    });
    expect(rows[0]).not.toHaveProperty('text');
    expect(rows[0]).not.toHaveProperty('hex');
    // Bez treści zostaje skrót - ten sam, który dostaje aplikacja w dostawie po wyczyszczeniu payloadu.
    expect(rows[0].bodyHash).toBe('h');
    expect(rows[1]).not.toHaveProperty('bodyHash');
  });

  it('binarna z treścią ma hex zamiast text', async () => {
    seed('in_1', { kind: 'binary', body: '0605 48' });
    const row = (await get('/v1/inbound')).json().data[0];
    expect(row.hex).toBe('0605 48');
    expect(row).not.toHaveProperty('text');
  });

  it('filtry serviceId, from, since, until', async () => {
    seed('in_1', { receivedAt: '2026-08-29T07:00:00.000Z' });
    seed('in_2', { receivedAt: '2026-08-29T09:00:00.000Z', sender: '48605000001' });
    expect(ids(await get('/v1/inbound?from=48605000001'))).toEqual(['in_2']);
    expect(ids(await get('/v1/inbound?since=2026-08-29T08:00:00Z'))).toEqual(['in_2']);
    expect(ids(await get('/v1/inbound?until=2026-08-29T08:00:00Z'))).toEqual(['in_1']);
    expect((await get('/v1/inbound?serviceId=24902', keyB)).json()).toEqual({ data: [], hasMore: false });
    expect(ids(await get('/v1/inbound?serviceId=24138'))).toEqual(['in_2', 'in_1']);
  });

  it('serviceId spoza klucza daje 403', async () => {
    const res = await get('/v1/inbound?serviceId=24902');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('service_not_allowed');
  });

  it('zła data w since albo until to 400', async () => {
    const res = await get('/v1/inbound?since=wczoraj');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_query');
  });

  it('limit ponad 200 wraca do 200, zły - do 25', async () => {
    for (let i = 0; i < 30; i += 1) seed(`in_${i}`);
    expect((await get('/v1/inbound?limit=abc')).json().data).toHaveLength(25);
    expect((await get('/v1/inbound?limit=500')).json().data).toHaveLength(30);
  });
});

describe('GET /v1/inbound/{id}', () => {
  it('zwraca wiadomość z usługi klucza', async () => {
    seed('in_1');
    const res = await get('/v1/inbound/in_1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'in_1', from: '48601000001', text: 'Dziekuje' });
  });
  it('404 dla nieznanego i dla wiadomości z usługi spoza klucza', async () => {
    seed('in_1', { serviceId: '24902' });
    expect((await get('/v1/inbound/in_1')).statusCode).toBe(404);
    expect((await get('/v1/inbound/in_1')).json().error.code).toBe('inbound_not_found');
    expect((await get('/v1/inbound/in_x')).statusCode).toBe(404);
  });
  it('wymaga klucza', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/inbound' })).statusCode).toBe(401);
  });
});
