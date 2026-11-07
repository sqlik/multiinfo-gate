import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateApiKey } from '../../src/api/keys.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { CampaignsRepo } from '../../src/store/campaigns.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { ShortLinksRepo } from '../../src/store/short-links.ts';
import { integrationDeps } from '../helpers/api-deps.ts';
import { messageInput } from '../store/helpers.ts';
import { FOLDER, SENT, SPRING, SPRING_PACKAGE, dest, seedSpringCampaign } from '../links/campaign-fixture.ts';

const masterKey = randomBytes(32);
const START = new Date('2026-11-05T10:00:00Z');
const NOW = new Date('2026-11-08T10:00:00Z');

let app: ReturnType<typeof buildApiServer>;
let db: ReturnType<typeof openDatabase>;
let apiKey: string;
let otherKey: string;
let apiKeyId: number;
let otherKeyId: number;
let accountId: number;
let campaigns: CampaignsRepo;
let shortLinks: ShortLinksRepo;
let messages: MessagesRepo;

beforeEach(async () => {
  db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  messages = new MessagesRepo(db);
  accountId = accounts.insert({
    name: 'Firma Serwis', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma', storeContent: 1, serviceIds: ['24138'], origs: ['Firma'],
  });
  const key = (name: string) => {
    const generated = generateApiKey();
    const id = apiKeys.insert({
      accountId, name, keyHash: generated.hash, keyPrefix: generated.prefix, defaultServiceId: '24138', defaultOrig: 'Firma',
      maxParts: 5, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], origs: [],
    });
    return { id, key: generated.key };
  };
  ({ id: apiKeyId, key: apiKey } = key('Biuro handlowe - kampanie'));
  ({ id: otherKeyId, key: otherKey } = key('Serwis'));
  const deps = integrationDeps(db, masterKey);
  deps.linkDomains.create({ domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, START);
  campaigns = deps.campaigns;
  shortLinks = deps.shortLinks;
  app = buildApiServer({
    accounts, apiKeys, messages, events: new MessageEventsRepo(db), jobs: new JobsRepo(db), packages: new PackagesRepo(db),
    clients: {} as never, inbound: new InboundMessagesRepo(db), rateLimiter: new RateLimiter(), now: () => NOW, ...deps,
  });
  await app.ready();
});

const get = (url: string, key = apiKey) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
const seed = () => seedSpringCampaign(db, { apiKeyId, accountId, domain: 'l.firma.pl', start: START });

describe('GET /v1/campaigns', () => {
  it('lista wyłącznie kampanii klucza, od najnowszej kampanii, z liczbami', async () => {
    seed();
    campaigns.open(otherKeyId, 'serwisowa', NOW);
    campaigns.open(apiKeyId, 'cennik-zima', new Date(START.getTime() - 86_400_000));
    const res = await get('/v1/campaigns');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [
        expect.objectContaining({ name: 'cennik-zima', sent: 0 }),
        {
          name: SPRING, firstSentAt: START.toISOString(), lastSentAt: START.toISOString(), sent: SENT, opens: 312, clicks: 455, bots: 41,
          linksDisabledAt: null,
        },
      ],
      hasMore: false,
    });
  });

  it('kolejna wysyłka do kampanii między stronami nie powoduje pominięcia ani powtórzenia kampanii', async () => {
    for (const name of ['C', 'B', 'A']) campaigns.open(apiKeyId, name, START);
    const names = async (offset: number) => (await get(`/v1/campaigns?limit=1&offset=${offset}`)).json().data.map((c: { name: string }) => c.name);
    const seen = [...await names(0)];
    // Aplikacja pobiera kolejne strony, a w tym czasie operator wysyła kolejną falę kampanii C.
    campaigns.open(apiKeyId, 'C', NOW);
    seen.push(...await names(1), ...await names(2));
    expect(seen.sort()).toEqual(['A', 'B', 'C']);
  });

  it('przesunięcie spoza zakresu liczb całkowitych daje pustą stronę, a nie błąd 500', async () => {
    seed();
    const huge = '99999999999999999999';
    for (const url of [`/v1/campaigns?offset=${huge}`, `/v1/campaigns/${SPRING}?offset=${huge}`, `/v1/messages?offset=${huge}`, `/v1/inbound?offset=${huge}`]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('stronicowanie jak w GET /v1/messages', async () => {
    for (let i = 0; i < 3; i++) campaigns.open(apiKeyId, `kampania-${i}`, new Date(START.getTime() + i * 60_000));
    const first = (await get('/v1/campaigns?limit=2')).json();
    expect(first.data.map((c: { name: string }) => c.name)).toEqual(['kampania-2', 'kampania-1']);
    expect(first.hasMore).toBe(true);
    const second = (await get('/v1/campaigns?limit=2&offset=2')).json();
    expect(second).toMatchObject({ data: [{ name: 'kampania-0' }], hasMore: false });
    expect((await get('/v1/campaigns?limit=-1')).json().data).toHaveLength(3);
  });

  it('wymaga klucza', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/campaigns' })).statusCode).toBe(401);
  });
});

describe('GET /v1/campaigns/{name}', () => {
  it('szczegóły: liczby, linki i pierwsza strona odbiorców, którzy otworzyli link', async () => {
    seed();
    const res = await get(`/v1/campaigns/${SPRING}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      name: SPRING, packages: 1, messages: 0, sent: SENT, delivered: 1204, opens: 312, clicks: 455, bots: 41,
      linksDisabledAt: null, detailsPurgedAt: null, domain: 'l.firma.pl', utm: true,
      links: [
        { target: FOLDER, kind: 'shared', opens: 251, clicks: 300 },
        { target: 'https://firma.pl/oferta/{…}', kind: 'individual', opens: 129, clicks: 155 },
      ],
    });
    expect(body.openers.data).toHaveLength(50);
    expect(body.openers.hasMore).toBe(true);
    expect(Object.keys(body.openers.data[0]).sort()).toEqual(['clicks', 'clientId', 'firstOpenedAt', 'lastClickedAt', 'targets', 'to']);
  });

  it('kolejne strony odbiorców parametrami offset i limit', async () => {
    seed();
    const body = (await get(`/v1/campaigns/${SPRING}?offset=300&limit=200`)).json();
    expect(body.openers.data).toHaveLength(12);
    expect(body.openers.hasMore).toBe(false);
    const all = (await get(`/v1/campaigns/${SPRING}?limit=200`)).json().openers.data.concat(
      (await get(`/v1/campaigns/${SPRING}?offset=200&limit=200`)).json().openers.data,
    );
    expect(all.find((o: { to: string }) => o.to === dest(200))).toMatchObject({ clientId: 'KL-10200', clicks: 3 });
  });

  it('kolejne kliknięcie odbiorcy między stronami nie powoduje pominięcia ani powtórzenia odbiorcy', async () => {
    seed();
    const page = async (offset: number) => (await get(`/v1/campaigns/${SPRING}?offset=${offset}&limit=200`)).json().openers.data
      .map((o: { to: string }) => o.to) as string[];
    const before = [...await page(0), ...await page(200)];
    const first = await page(0);
    // Odbiorca z drugiej strony klika ponownie w trakcie pobierania stron.
    const late = before.find((to) => !first.includes(to))!;
    db.prepare('UPDATE short_links SET last_clicked_at = ?, clicks = clicks + 1 WHERE dest = ?').run(NOW.toISOString(), late);
    const seen = [...first, ...await page(200)];
    expect(seen).toHaveLength(312);
    expect(new Set(seen).size).toBe(312);
  });

  it('nazwa z polskimi znakami, spacjami i ukośnikiem zakodowana w adresie', async () => {
    campaigns.open(apiKeyId, 'Przegląd / wiosna 2027', START);
    const res = await get('/v1/campaigns/Przegl%C4%85d%20%2F%20wiosna%202027');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Przegląd / wiosna 2027', delivered: null, links: [], openers: { data: [], hasMore: false } });
  });

  it('kampania innego klucza i nieznana nazwa dają 404 campaign_not_found', async () => {
    seed();
    const other = await get(`/v1/campaigns/${SPRING}`, otherKey);
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe('campaign_not_found');
    expect((await get('/v1/campaigns/nieznana')).json().error.code).toBe('campaign_not_found');
  });
});

describe('blok links w odczycie wiadomości i rozsyłki', () => {
  it('GET /v1/messages/{id}: kampania, krótkie linki, kliknięcia i pierwsze otwarcie', async () => {
    const id = campaigns.open(apiKeyId, SPRING, START);
    messages.insert(messageInput({ id: 'msg_1', apiKeyId, accountId, campaignId: id }));
    shortLinks.insert({
      code: 'aB3xK9q', domainId: 1, apiKeyId, campaignId: id, target: FOLDER, utm: 1, recipientKey: 'msg_1', messageId: 'msg_1',
      packageId: null, seq: null, dest: '48601000001', clientId: null, expiresAt: '2027-02-03T10:00:00.000Z',
      purgeAfter: '2027-03-05T10:00:00.000Z', createdAt: START.toISOString(),
    });
    shortLinks.click('aB3xK9q', new Date('2026-11-05T10:05:00Z'), false);
    const res = await get('/v1/messages/msg_1');
    expect(res.json().links).toEqual({
      campaign: SPRING, domain: 'l.firma.pl', expiresAt: '2027-02-03T10:00:00.000Z', shortened: 1, opens: 1, clicks: 1,
      firstOpenedAt: '2026-11-05T10:05:00.000Z', detailsPurged: false,
      shortLinks: [{ url: 'https://l.firma.pl/aB3xK9q', target: FOLDER, clicks: 1, firstOpenedAt: '2026-11-05T10:05:00.000Z' }],
    });
  });

  it('GET /v1/messages/{id} bez krótkich linków nie ma bloku links', async () => {
    messages.insert(messageInput({ id: 'msg_2', apiKeyId, accountId }));
    expect('links' in (await get('/v1/messages/msg_2')).json()).toBe(false);
  });

  it('GET /v1/packages/{id}: liczby wszystkich odbiorców rozsyłki', async () => {
    seed();
    const res = await get(`/v1/packages/${SPRING_PACKAGE}`);
    expect(res.json().links).toMatchObject({
      campaign: SPRING, domain: 'l.firma.pl', shortened: SENT * 2, opens: 312, clicks: 455, detailsPurged: false,
    });
  });
});
