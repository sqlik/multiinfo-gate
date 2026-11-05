import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { integrationDeps } from '../helpers/api-deps.ts';

const masterKey = randomBytes(32);
const NOW = new Date('2026-11-05T10:00:00Z');

let app: ReturnType<typeof buildApiServer>;
let keyA: string;
let messages: MessagesRepo;
let accountId: number;
let apiKeyAId: number;
let cancel: ReturnType<typeof vi.fn>;

function seedSystem(id: string, status?: string) {
  messages.insert({
    id, apiKeyId: apiKeyAId, accountId, serviceId: '24138', dest: '48601000099',
    body: 'Multiinfo Gate: Konto Microsoft 365 wymaga logowania - Dyżur IT. Szczegóły w panelu.', bodyHash: 'h',
    encoding: 'gsm', parts: 1, slots: 80, orig: null, costCenter: null, validTo: null, idempotencyKey: null,
    requestedBy: 'Powiadomienie bramki', system: 1, createdAt: NOW.toISOString(),
  });
  if (status) messages.setStatus(id, { status: status as never, finalAt: NOW });
}

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  messages = new MessagesRepo(db);
  accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent: 1, serviceIds: ['24138'],
  });
  const a = generateApiKey();
  keyA = a.key;
  apiKeyAId = apiKeys.insert({
    accountId, name: 'Klucz A', keyHash: a.hash, keyPrefix: a.prefix,
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 600,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  cancel = vi.fn();
  app = buildApiServer({
    accounts, apiKeys, messages, jobs: new JobsRepo(db), events: new MessageEventsRepo(db), packages: new PackagesRepo(db),
    inbound: new InboundMessagesRepo(db), rateLimiter: new RateLimiter(), now: () => NOW, ...integrationDeps(db, masterKey),
    clients: { for: () => ({ cancel }), invalidate: vi.fn(), closeAll: vi.fn() } as never,
  });
  await app.ready();
});

const post = (url: string) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${keyA}` } });

describe('anulowanie wiadomości systemowej przez API', () => {
  it('klucz kanału SMS nie anuluje SMS-a powiadomienia (404 jak przy odczycie)', async () => {
    seedSystem('msg_sys1');
    const res = await post('/v1/messages/msg_sys1/cancel');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('message_not_found');
    expect(messages.get('msg_sys1')?.status).toBe('queued');
  });

  it('wiadomość systemowa w stanie ostatecznym nie zdradza istnienia przez 409', async () => {
    seedSystem('msg_sys2', 'delivered');
    const res = await post('/v1/messages/msg_sys2/cancel');
    expect(res.statusCode).toBe(404);
  });
});
