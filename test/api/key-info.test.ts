import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateApiKey } from '../../src/api/keys.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { LinkDomainsRepo } from '../../src/store/link-domains.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';

const masterKey = randomBytes(32);
let app: ReturnType<typeof buildApiServer>;
let apiKeys: ApiKeysRepo;
let accounts: AccountsRepo;
let accountId: number;
let db: ReturnType<typeof openDatabase>;

async function build(): Promise<void> {
  db = openDatabase(':memory:');
  accounts = new AccountsRepo(db, masterKey);
  apiKeys = new ApiKeysRepo(db, masterKey);
  accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent: 1,
    serviceIds: ['24138', '24902'], origs: ['Firma Info', 'Firma Wind', 'Firma Alert'],
  });
  app = buildApiServer({
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
    packages: new PackagesRepo(db), clients: {} as never, inbound: new InboundMessagesRepo(db),
    rateLimiter: new RateLimiter(), ...integrationDeps(db, masterKey),
  });
  await app.ready();
}

function addKey(overrides: Partial<Parameters<ApiKeysRepo['insert']>[0]> = {}): { id: number; key: string } {
  const generated = generateApiKey();
  const id = apiKeys.insert({
    accountId, name: 'Powiadomienia CRM', keyHash: generated.hash, keyPrefix: generated.prefix,
    defaultServiceId: '24138', defaultOrig: 'Firma Info', maxParts: 5, ratePerMin: 60,
    webhookUrl: 'https://crm.firma.pl/webhook', webhookSecret: 'whsec_tajny', serviceIds: ['24138'], origs: ['Firma Alert'],
    ...overrides,
  });
  return { id, key: generated.key };
}

const get = (key?: string) =>
  app.inject({ method: 'GET', url: '/v1/key', headers: key === undefined ? {} : { authorization: `Bearer ${key}` } });

beforeEach(build);

describe('GET /v1/key', () => {
  it('zwraca uprawnienia klucza, którym jest wywołane', async () => {
    const { key } = addKey();
    const res = await get(key);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'Powiadomienia CRM',
      services: [{ id: '24138', default: true }],
      origs: [{ orig: 'Firma Alert', default: false }, { orig: 'Firma Info', default: true }],
      maxParts: 5,
      ratePerMin: 60,
      links: { mode: 'off', domains: [], validityDays: 90, utm: true },
    });
  });

  it('blok links: tryb, aktywne domeny klucza z domyślną, ważność i UTM', async () => {
    const { id, key } = addKey();
    const domains = new LinkDomainsRepo(db);
    const NOW = new Date('2026-11-05T10:00:00Z');
    const main = domains.create({ domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, NOW);
    const second = domains.create({ domain: 'firma-link.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: true }, NOW);
    const off = domains.create({ domain: 'stara-firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, NOW);
    domains.setEnabled(off, false, NOW);
    apiKeys.setLinkSettings(id, {
      mode: 'sender', domainIds: [main, second, off], defaultDomainId: second, targets: ['firma.pl'], validityDays: 30, utm: false,
    });
    expect((await get(key)).json().links).toEqual({
      mode: 'sender',
      domains: [{ domain: 'firma-link.pl', default: true }, { domain: 'l.firma.pl', default: false }],
      validityDays: 30,
      utm: false,
    });
  });

  it('klucz z trybem off zwraca pustą listę domen, nawet gdy domeny zostały przypisane', async () => {
    const { id, key } = addKey();
    const main = new LinkDomainsRepo(db).create(
      { domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, new Date('2026-11-05T10:00:00Z'),
    );
    apiKeys.setLinkSettings(id, { mode: 'off', domainIds: [main], defaultDomainId: main, targets: ['firma.pl'], validityDays: 90, utm: true });
    expect((await get(key)).json().links).toEqual({ mode: 'off', domains: [], validityDays: 90, utm: true });
  });

  it('dozwolone domeny docelowe nie trafiają do odpowiedzi', async () => {
    const { id, key } = addKey();
    const main = new LinkDomainsRepo(db).create(
      { domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, new Date('2026-11-05T10:00:00Z'),
    );
    apiKeys.setLinkSettings(id, { mode: 'always', domainIds: [main], defaultDomainId: main, targets: ['serwis-klima.pl'], validityDays: 90, utm: true });
    expect((await get(key)).body).not.toContain('serwis-klima.pl');
  });

  it('nie ujawnia danych konta, skrótu klucza ani webhooka', async () => {
    const { key } = addKey();
    const text = (await get(key)).body;
    for (const secret of ['firma_api', 'tajne', 'keyHash', 'webhook', 'whsec_', 'accountId', 'CERT']) {
      expect(text).not.toContain(secret);
    }
  });

  it('nadpis domyślny konta trafia na listę jako domyślny, gdy klucz nie ma własnego', async () => {
    const { key } = addKey({ defaultOrig: null, origs: [] });
    expect((await get(key)).json().origs).toEqual([{ orig: 'Firma Info', default: true }]);
  });

  it('klucz bez nadpisów i bez nadpisu domyślnego ma pustą listę', async () => {
    db.prepare('UPDATE accounts SET default_orig = NULL WHERE id = ?').run(accountId);
    const { key } = addKey({ defaultOrig: null, origs: [] });
    expect((await get(key)).json().origs).toEqual([]);
  });

  it('bez nagłówka odpowiada 401 missing_api_key', async () => {
    addKey();
    const res = await get();
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('missing_api_key');
  });

  it('odwołany klucz odpowiada 401 revoked_api_key', async () => {
    const { id, key } = addKey();
    apiKeys.revoke(id);
    const res = await get(key);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('revoked_api_key');
  });

  it('liczy się do limitu żądań klucza', async () => {
    const { key } = addKey({ ratePerMin: 1 });
    expect((await get(key)).statusCode).toBe(200);
    const res = await get(key);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  });
});
