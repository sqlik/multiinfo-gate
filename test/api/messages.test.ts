import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateApiKey } from '../../src/api/keys.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
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
let apiKey: string;
let jobs: JobsRepo;
let messages: MessagesRepo;
let events: MessageEventsRepo;
let inbound: InboundMessagesRepo;
let accountId: number;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  messages = new MessagesRepo(db);
  events = new MessageEventsRepo(db);
  jobs = new JobsRepo(db);

  inbound = new InboundMessagesRepo(db);
  accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent: 1,
    serviceIds: ['24138', '24902'], origs: ['Firma Info', 'Firma Wind', 'Firma Alert'],
  });

  const generated = generateApiKey();
  apiKey = generated.key;
  apiKeys.insert({
    accountId, name: 'Powiadomienia CRM', keyHash: generated.hash, keyPrefix: generated.prefix,
    defaultServiceId: '24138', defaultOrig: 'Firma Info', maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], origs: ['Firma Alert'],
  });

  app = buildApiServer({
    accounts, apiKeys, messages, events, jobs, packages: new PackagesRepo(db), clients: {} as never,
    inbound, rateLimiter: new RateLimiter(), now: () => NOW,
  });
  await app.ready();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${apiKey}`, ...headers }, payload: body });

describe('POST /v1/messages', () => {
  it('zapisuje zdarzenie przyjęcia', async () => {
    const res = await post({ to: '48601135134', text: 'Ala ma kota' });
    expect(events.list(res.json().id)).toEqual([{ at: NOW.toISOString(), kind: 'queued', detail: null }]);
  });

  it('przyjmuje wysyłkę i zwraca 202 z pomiarem', async () => {
    const res = await post({ to: '48601135134', text: 'Ala ma kota' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('queued');
    expect(body.encoding).toBe('gsm');
    expect(body.parts).toBe(1);
    expect(body.characters).toBe(11);
    expect(body.slots).toBe(11);
    expect(body.slotsRemaining).toBe(149);
    expect(body.id).toMatch(/^msg_/);
  });

  it('zapisuje czas przyjęcia z zegara bramki, nie z zegara bazy', async () => {
    const res = await post({ to: '48601135134', text: 'Ala ma kota' });
    expect(messages.get(res.json().id)!.createdAt).toBe(NOW.toISOString());
  });

  it('dodaje zadanie do kolejki', async () => {
    await post({ to: '48601135134', text: 'Ala ma kota' });
    const claimed = jobs.claim(new Date(Date.now() + 1000), 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.type).toBe('send');
  });

  it('normalizuje numer bez kodu kraju', async () => {
    const res = await post({ to: '601 135 134', text: 'x' });
    expect(res.statusCode).toBe(202);
    const stored = messages.get(res.json().id)!;
    expect(stored.dest).toBe('48601135134');
  });

  it('wybiera UCS-2 dla polskich znaków', async () => {
    const res = await post({ to: '48601135134', text: 'Zażółć gęślą jaźń' });
    expect(res.json().encoding).toBe('ucs2');
  });

  it('odrzuca tekst przekraczający limit części klucza', async () => {
    const res = await post({ to: '48601135134', text: 'a'.repeat(1000) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('too_many_parts');
    expect(res.json().error.message).toMatch(/Usuń co najmniej/);
  });

  it('odrzuca nadpis dłuższy niż 11 znaków', async () => {
    const res = await post({ to: '48601135134', text: 'x', orig: 'Firma Informacje' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_orig');
  });

  it('przyjmuje nadpis przypisany kluczowi', async () => {
    const res = await post({ to: '48601135134', text: 'x', orig: 'Firma Alert' });
    expect(res.statusCode).toBe(202);
    expect(messages.get(res.json().id)!.orig).toBe('Firma Alert');
  });

  it('przyjmuje nadpis domyślny klucza podany jawnie', async () => {
    const res = await post({ to: '48601135134', text: 'x', orig: 'Firma Info' });
    expect(res.statusCode).toBe(202);
  });

  it('odrzuca nadpis ze słownika konta, którego klucz nie ma przypisanego', async () => {
    const res = await post({ to: '48601135134', text: 'x', orig: 'Firma Wind' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('orig_not_allowed');
  });

  it('odrzuca nadpis spoza słownika konta', async () => {
    const res = await post({ to: '48601135134', text: 'x', orig: 'Inna Firma' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('orig_not_allowed');
  });

  it('w komunikacie odmowy wypisuje wartości dopuszczalne dla klucza', async () => {
    const message = (await post({ to: '48601135134', text: 'x', orig: 'Inna Firma' })).json().error.message;
    expect(message).toContain('Firma Alert');
    expect(message).toContain('Firma Info');
    expect(message).not.toContain('Firma Wind');
  });

  it('nie wysyła odrzuconego żądania do Multiinfo', async () => {
    await post({ to: '48601135134', text: 'x', orig: 'Inna Firma' });
    expect(jobs.claim(new Date(Date.now() + 1000), 10)).toHaveLength(0);
  });

  it('stosuje nadpis domyślny, gdy żądanie go nie podaje', async () => {
    const res = await post({ to: '48601135134', text: 'x' });
    expect(res.statusCode).toBe(202);
    expect(messages.get(res.json().id)!.orig).toBe('Firma Info');
  });

  it('odrzuca ważność dalszą niż 72 godziny', async () => {
    const validTo = new Date(NOW.getTime() + 80 * 3600_000).toISOString();
    const res = await post({ to: '48601135134', text: 'x', validTo });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('valid_to_too_far');
  });

  it('odrzuca serviceId spoza uprawnień klucza', async () => {
    const res = await post({ to: '48601135134', text: 'x', serviceId: '24902' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('service_not_allowed');
  });

  it('odrzuca żądanie bez klucza', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/messages', payload: { to: '48601135134', text: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('przyjmuje tablicę numerów i zwraca tablicę wyników', async () => {
    const res = await post({ to: ['48601135134', '48601135135'], text: 'x' });
    expect(res.statusCode).toBe(202);
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.json()).toHaveLength(2);
  });

  it('nie zapisuje żadnej wiadomości, gdy jeden z numerów listy jest błędny', async () => {
    const res = await post({ to: ['48601135134', 'nie-numer', '48601135136'], text: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_phone');
    expect(messages.list({ apiKeyId: 0, limit: 10, offset: 0 })).toHaveLength(0);
    expect(messages.list({ limit: 10, offset: 0 })).toHaveLength(0);
    expect(jobs.depth()).toBe(0);
  });

  it('nie zapisuje żadnej wiadomości, gdy klucz idempotencji koliduje przy dalszym odbiorcy', async () => {
    const headers = { 'idempotency-key': 'partia-7' };
    await post({ to: ['48601135134', '48601135135'], text: 'x' }, headers);
    const res = await post({ to: ['48601135134', '48601135135'], text: 'inna treść' }, headers);
    expect(res.statusCode).toBe(409);
    expect(messages.list({ limit: 10, offset: 0 })).toHaveLength(2);
    expect(jobs.depth()).toBe(2);
  });

  it('zwraca tę samą odpowiedź dla powtórzonego klucza idempotencji', async () => {
    const headers = { 'idempotency-key': 'faktura-114' };
    const first = await post({ to: '48601135134', text: 'x' }, headers);
    const second = await post({ to: '48601135134', text: 'x' }, headers);
    expect(second.statusCode).toBe(202);
    expect(second.json().id).toBe(first.json().id);
    expect(jobs.claim(new Date(Date.now() + 1000), 10)).toHaveLength(1);
  });

  it('odrzuca ten sam klucz idempotencji przy innej treści', async () => {
    const headers = { 'idempotency-key': 'faktura-114' };
    await post({ to: '48601135134', text: 'x' }, headers);
    const res = await post({ to: '48601135134', text: 'inna treść' }, headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('idempotency_conflict');
  });

  it('zwraca 429 po przekroczeniu limitu', async () => {
    for (let i = 0; i < 60; i += 1) await post({ to: '48601135134', text: 'x' });
    const res = await post({ to: '48601135134', text: 'x' });
    expect(res.statusCode).toBe(429);
  });
});

describe('POST /v1/messages - inReplyTo', () => {
  const seedInbound = (serviceId = '24138') => inbound.insertIfNew({
    id: 'in_1', accountId, serviceId, miId: '22', sender: '48601135134', dest: '7968', kind: 'text', body: 'Pytanie',
    bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null,
    receivedAt: NOW.toISOString(), createdAt: NOW.toISOString(),
  });

  it('zapisuje odpowiedź w wątku', async () => {
    seedInbound();
    const res = await post({ to: '48601135134', text: 'Odpowiedź', inReplyTo: 'in_1' });
    expect(res.statusCode).toBe(202);
    expect(messages.get(res.json().id)!.inReplyTo).toBe('in_1');
  });

  it('odrzuca nieznaną wiadomość i wiadomość z innej usługi', async () => {
    seedInbound('24902');
    for (const id of ['in_1', 'in_nie_ma']) {
      const res = await post({ to: '48601135134', text: 'Odpowiedź', inReplyTo: id });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('in_reply_to_unknown');
    }
  });

  it('inReplyTo z listą odbiorców jest odrzucane', async () => {
    seedInbound();
    const res = await post({ to: ['48601135134', '48601135135'], text: 'Odpowiedź', inReplyTo: 'in_1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('in_reply_to_single');
  });
});
