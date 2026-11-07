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
import { LinkDomainsRepo } from '../../src/store/link-domains.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { ShortLinksRepo } from '../../src/store/short-links.ts';
import { integrationDeps } from '../helpers/api-deps.ts';

const masterKey = randomBytes(32);
const NOW = new Date('2026-11-05T10:00:00Z');
const DAY = 86_400_000;
const SHORT = /https:\/\/l\.firma\.pl\/([A-Za-z0-9]{7})/g;

let app: ReturnType<typeof buildApiServer>;
let apiKey: string;
let apiKeyId: number;
let jobs: JobsRepo;
let messages: MessagesRepo;
let packages: PackagesRepo;
let campaigns: CampaignsRepo;
/** Stan serwera krótkich linków widziany przez API; testy zajętego portu ustawiają false. */
let linksServerUp = true;
let shortLinks: ShortLinksRepo;
let apiKeysRepo: ApiKeysRepo;
let linkDomainsRepo: LinkDomainsRepo;
let mainDomainId: number;
let testDb: ReturnType<typeof openDatabase>;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  testDb = db;
  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  messages = new MessagesRepo(db);
  jobs = new JobsRepo(db);
  packages = new PackagesRepo(db);
  const accountId = accounts.insert({
    name: 'Firma Serwis', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma', storeContent: 1, serviceIds: ['24138'], origs: ['Firma'],
  });
  const generated = generateApiKey();
  apiKey = generated.key;
  apiKeyId = apiKeys.insert({
    accountId, name: 'Serwis klimatyzacji', keyHash: generated.hash, keyPrefix: generated.prefix,
    defaultServiceId: '24138', defaultOrig: 'Firma', maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], origs: [],
  });
  const deps = integrationDeps(db, masterKey);
  const domainId = deps.linkDomains.create({ domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, NOW);
  apiKeys.setLinkSettings(apiKeyId, {
    mode: 'sender', domainIds: [domainId], defaultDomainId: domainId, targets: ['firma.pl'], validityDays: 90, utm: true,
  });
  campaigns = deps.campaigns;
  shortLinks = deps.shortLinks;
  apiKeysRepo = apiKeys;
  linkDomainsRepo = deps.linkDomains;
  mainDomainId = domainId;

  app = buildApiServer({
    accounts, apiKeys, messages, events: new MessageEventsRepo(db), jobs, packages, clients: {} as never,
    inbound: new InboundMessagesRepo(db), rateLimiter: new RateLimiter(), now: () => NOW, ...deps,
    linksServer: { available: () => linksServerUp },
  });
  await app.ready();
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${apiKey}`, ...headers }, payload: body });

const codesIn = (text: string) => [...text.matchAll(SHORT)].map((m) => m[1]!);
const sendTexts = () =>
  jobs.claim(new Date(NOW.getTime() + 1000), 100).filter((j) => j.type === 'send').map((j) => (j.payload as { text: string }).text);

describe('POST /v1/messages z krótkimi linkami', () => {
  it('nadaje każdemu odbiorcy osobny kod i zakłada kampanię z nazwą klucza', async () => {
    const res = await post('/v1/messages', { to: ['48601000001', '48601000002'], text: 'Przegląd klimatyzacji: https://firma.pl/folder.pdf' });
    expect(res.statusCode).toBe(202);
    const body = res.json() as Array<{ id: string; links: unknown }>;
    const expiresAt = new Date(NOW.getTime() + 90 * DAY).toISOString();
    for (const item of body) {
      expect(item.links).toEqual({
        shortened: 1, domain: 'l.firma.pl', campaign: 'Serwis klimatyzacji', expiresAt, notice: null, skipped: [],
      });
    }

    const texts = sendTexts();
    expect(texts).toHaveLength(2);
    const codes = texts.flatMap(codesIn);
    expect(codes).toHaveLength(2);
    expect(codes[0]).not.toBe(codes[1]);
    expect(texts.join(' ')).not.toContain('0000000');
    expect(messages.get(body[0]!.id)!.body).toBe(texts[0]);

    const campaign = campaigns.byName(apiKeyId, 'Serwis klimatyzacji')!;
    expect(campaign.sent).toBe(2);
    expect(messages.get(body[0]!.id)!.campaignId).toBe(campaign.id);
    expect(shortLinks.get(codes[0]!)).toMatchObject({ target: 'https://firma.pl/folder.pdf', messageId: body[0]!.id });
  });

  it('nadaje dwa różne kody temu samemu linkowi użytemu dwa razy w jednym SMS-ie', async () => {
    await post('/v1/messages', { to: '48601000001', text: 'Oferta https://firma.pl/a, powtórzenie https://firma.pl/a' });
    const [text] = sendTexts();
    const codes = codesIn(text!);
    expect(codes).toHaveLength(2);
    expect(codes[0]).not.toBe(codes[1]);
  });

  it('zwraca przy powtórzeniu z tym samym Idempotency-Key te same kody bez zwiększania licznika wysłanych', async () => {
    const payload = { to: ['48601000001', '48601000002'], text: 'Oferta https://firma.pl/a', campaign: 'przeglad-klimatyzacji-wiosna' };
    const first = await post('/v1/messages', payload, { 'idempotency-key': 'zlecenie-17' });
    const again = await post('/v1/messages', payload, { 'idempotency-key': 'zlecenie-17' });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    const ids = (first.json() as Array<{ id: string }>).map((m) => m.id);
    expect(ids.map((id) => shortLinks.forMessage(id).length)).toEqual([1, 1]);
    expect(campaigns.byName(apiKeyId, 'przeglad-klimatyzacji-wiosna')!.sent).toBe(2);
  });

  it('zapisuje kody wyłączone i zgłasza kampanię z wyłączonymi linkami', async () => {
    const campaignId = campaigns.open(apiKeyId, 'przeglad-klimatyzacji-wiosna', NOW);
    campaigns.setLinksDisabled(campaignId, NOW);
    const payload = { to: '48601000002', text: 'Oferta https://firma.pl/a', campaign: 'przeglad-klimatyzacji-wiosna' };
    const res = await post('/v1/messages', payload, { 'idempotency-key': 'zlecenie-18' });
    expect(res.statusCode).toBe(202);
    expect(res.json().links).toMatchObject({ shortened: 1, campaign: 'przeglad-klimatyzacji-wiosna', notice: 'campaign_links_disabled' });
    const again = await post('/v1/messages', payload, { 'idempotency-key': 'zlecenie-18' });
    expect(again.json()).toEqual(res.json());
    const [code] = codesIn(sendTexts()[0]!);
    expect(shortLinks.get(code!)!.disabledAt).toBe(NOW.toISOString());
  });

  it('liczy części na treści po skróceniu', async () => {
    const res = await post('/v1/messages', {
      to: '48601000001', text: 'Przegląd klimatyzacji: https://firma.pl/oferty/przeglad-klimatyzacji-wiosna-2027?klient=123456',
    });
    expect(res.json()).toMatchObject({ encoding: 'ucs2', parts: 1, characters: 49 });
  });

  it('nie skraca na życzenie wysyłającego i nie zakłada kampanii', async () => {
    const res = await post('/v1/messages', { to: '48601000001', text: 'Oferta https://firma.pl/a', shortenLinks: false, campaign: 'wiosna' });
    expect(res.json().links).toBeUndefined();
    expect(sendTexts()).toEqual(['Oferta https://firma.pl/a']);
    expect(campaigns.byName(apiKeyId, 'wiosna')).toBeUndefined();
  });

  it('nie zakłada kampanii dla treści bez linku', async () => {
    const res = await post('/v1/messages', { to: '48601000001', text: 'Dziękujemy za wizytę', campaign: 'wiosna' });
    expect(res.json().links).toBeUndefined();
    expect(campaigns.byName(apiKeyId, 'wiosna')).toBeUndefined();
    expect(messages.get(res.json().id)!.campaignId).toBeNull();
  });

  it('serwer krótkich linków nie działa: wiadomość i rozsyłka z pełnymi linkami, bez kodów i ze zgłoszeniem domain_unavailable', async () => {
    linksServerUp = false;
    try {
      const message = await post('/v1/messages', { to: '48601000001', text: 'Oferta https://firma.pl/a', campaign: 'wiosna' });
      expect(message.statusCode).toBe(202);
      expect(message.json().links).toMatchObject({ shortened: 0, notice: 'domain_unavailable' });
      const pkg = await post('/v1/packages', { recipients: [{ to: '48601000001' }, { to: '48601000002' }], defaultText: 'Oferta https://firma.pl/b' });
      expect(pkg.statusCode).toBe(202);
      expect(pkg.json().links).toMatchObject({ shortened: 0, notice: 'domain_unavailable' });
      expect(sendTexts()).toEqual(['Oferta https://firma.pl/a']);
      expect(packages.get(pkg.json().id)!.defaultText).toBe('Oferta https://firma.pl/b');
      expect(campaigns.byName(apiKeyId, 'wiosna')).toBeUndefined();
    } finally {
      linksServerUp = true;
    }
  });

  it('odrzuca domenę skracacza spoza domen klucza', async () => {
    const res = await post('/v1/messages', { to: '48601000001', text: 'Oferta https://firma.pl/a', linkDomain: 'obca-domena.pl' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('link_domain_not_allowed');
  });

  it('odrzuca nazwę kampanii dłuższą niż 100 znaków i ważność spoza zakresu', async () => {
    const long = await post('/v1/messages', { to: '48601000001', text: 'Oferta https://firma.pl/a', campaign: 'x'.repeat(101) });
    expect(long.statusCode).toBe(400);
    const validity = await post('/v1/messages', { to: '48601000001', text: 'Oferta https://firma.pl/a', linkValidityDays: 366 });
    expect(validity.statusCode).toBe(400);
  });
});

describe('POST /v1/packages z krótkimi linkami', () => {
  it('zapisuje treść indywidualną z osobnym kodem dla każdego odbiorcy treści wspólnej', async () => {
    const res = await post('/v1/packages', {
      defaultText: 'Przegląd klimatyzacji: https://firma.pl/przeglad',
      recipients: [{ to: '48601000001' }, { to: '48601000002' }, { to: '48601000003', clientId: 'K-3' }],
      startAt: new Date(NOW.getTime() + DAY).toISOString(),
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().id as string;
    expect(res.json().links).toEqual({
      shortened: 3, domain: 'l.firma.pl', campaign: id,
      expiresAt: new Date(NOW.getTime() + 91 * DAY).toISOString(), notice: null, skipped: [],
    });

    const pkg = packages.get(id)!;
    expect(pkg.defaultText).toBeNull();
    const recipients = packages.recipients(id);
    expect(recipients.map((r) => r.links)).toEqual([1, 1, 1]);
    const codes = recipients.flatMap((r) => codesIn(r.text!));
    expect(new Set(codes).size).toBe(3);
    expect(shortLinks.get(codes[2]!)).toMatchObject({ packageId: id, seq: 3, recipientKey: `${id}#3`, clientId: 'K-3' });

    const campaign = campaigns.byName(apiKeyId, id)!;
    expect(pkg.campaignId).toBe(campaign.id);
    expect(campaign.sent).toBe(3);
  });

  it('przyjmuje nazwę kampanii ze znakami spoza alfabetu łacińskiego i ukośnikiem', async () => {
    const res = await post('/v1/packages', {
      defaultText: 'Oferta https://firma.pl/a', recipients: [{ to: '48601000001' }], campaign: 'Przegląd / wiosna 2027',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().links.campaign).toBe('Przegląd / wiosna 2027');
    expect(campaigns.byName(apiKeyId, 'Przegląd / wiosna 2027')!.sent).toBe(1);
  });

  it('pozostawia treść wspólną bez linku i liczy tylko odbiorców z kodem', async () => {
    const res = await post('/v1/packages', {
      defaultText: 'Dziękujemy za wizytę',
      recipients: [{ to: '48601000001' }, { to: '48601000002', text: 'Faktura https://firma.pl/f/2' }],
    });
    const id = res.json().id as string;
    expect(packages.get(id)!.defaultText).toBe('Dziękujemy za wizytę');
    const recipients = packages.recipients(id);
    expect(recipients.map((r) => r.links)).toEqual([0, 1]);
    expect(recipients[0]!.text).toBeNull();
    expect(campaigns.byName(apiKeyId, id)!.sent).toBe(1);
  });

  it('nie zakłada kampanii, gdy treść wspólna z linkiem nie trafia do żadnego odbiorcy', async () => {
    const res = await post('/v1/packages', {
      defaultText: 'Oferta https://firma.pl/a, cennik https://inna.pl/c',
      recipients: [{ to: '48601000001', text: 'Dziękujemy za wizytę' }],
    });
    const id = res.json().id as string;
    expect(res.json().links).toBeUndefined();
    expect(campaigns.byName(apiKeyId, id)).toBeUndefined();
    expect(packages.get(id)!.campaignId).toBeNull();
  });

  it('zapisuje kody wyłączone i zgłasza kampanię z wyłączonymi linkami w rozsyłce', async () => {
    const campaignId = campaigns.open(apiKeyId, 'przeglad-klimatyzacji-wiosna', NOW);
    campaigns.setLinksDisabled(campaignId, NOW);
    const payload = { defaultText: 'Oferta https://firma.pl/a', recipients: [{ to: '48601000001' }], campaign: 'przeglad-klimatyzacji-wiosna' };
    const res = await post('/v1/packages', payload, { 'idempotency-key': 'rozsylka-5' });
    expect(res.json().links).toMatchObject({ shortened: 1, notice: 'campaign_links_disabled' });
    const again = await post('/v1/packages', payload, { 'idempotency-key': 'rozsylka-5' });
    expect(again.json()).toEqual(res.json());
    const [code] = codesIn(packages.recipients(res.json().id as string)[0]!.text!);
    expect(shortLinks.get(code!)!.disabledAt).toBe(NOW.toISOString());
  });

  it('zwraca przy powtórzeniu z tym samym Idempotency-Key tę samą rozsyłkę bez nowych kodów', async () => {
    const payload = { defaultText: 'Oferta https://firma.pl/a', recipients: [{ to: '48601000001' }, { to: '48601000002' }] };
    const first = await post('/v1/packages', payload, { 'idempotency-key': 'rozsylka-3' });
    const again = await post('/v1/packages', payload, { 'idempotency-key': 'rozsylka-3' });
    expect(again.json()).toEqual(first.json());
    const id = first.json().id as string;
    expect(campaigns.byName(apiKeyId, id)!.sent).toBe(2);
    expect(shortLinks.remaining(campaigns.byName(apiKeyId, id)!.id)).toBe(2);
  });
});

describe('powtórzenie z tym samym Idempotency-Key po zmianie ustawień klucza', () => {
  /** Klucz z drugą domeną promo-firma.pl, którą administrator odpina między próbami klienta. */
  const withPromo = () => {
    const promoId = linkDomainsRepo.create({ domain: 'promo-firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, NOW);
    apiKeysRepo.setLinkSettings(apiKeyId, {
      mode: 'sender', domainIds: [mainDomainId, promoId], defaultDomainId: mainDomainId, targets: ['firma.pl'], validityDays: 90, utm: true,
    });
  };
  const unassignPromo = () => apiKeysRepo.setLinkSettings(apiKeyId, {
    mode: 'sender', domainIds: [mainDomainId], defaultDomainId: mainDomainId, targets: ['firma.pl'], validityDays: 90, utm: true,
  });
  const idem = { 'idempotency-key': 'zlecenie-17' };

  it('wiadomość: zwraca przyjętą wiadomość mimo odpięcia domeny skracacza od klucza', async () => {
    withPromo();
    const payload = { to: '48601000001', text: 'Oferta https://firma.pl/a', linkDomain: 'promo-firma.pl' };
    const first = await post('/v1/messages', payload, idem);
    expect(first.statusCode).toBe(202);
    unassignPromo();
    const again = await post('/v1/messages', payload, idem);
    expect(again.statusCode).toBe(202);
    expect(again.json().id).toBe(first.json().id);
    expect(again.json().links).toMatchObject({ shortened: 1, domain: 'promo-firma.pl' });
  });

  it('rozsyłka: zwraca przyjętą rozsyłkę mimo odpięcia domeny skracacza od klucza', async () => {
    withPromo();
    const payload = { defaultText: 'Oferta https://firma.pl/a', recipients: [{ to: '48601000001' }], linkDomain: 'promo-firma.pl' };
    const first = await post('/v1/packages', payload, idem);
    expect(first.statusCode).toBe(202);
    unassignPromo();
    const again = await post('/v1/packages', payload, idem);
    expect(again.statusCode).toBe(202);
    expect(again.json().id).toBe(first.json().id);
    expect(again.json().links).toMatchObject({ shortened: 1, domain: 'promo-firma.pl' });
  });

  it('wiadomość i rozsyłka: zwracają przyjętą wysyłkę mimo obniżenia limitu części klucza', async () => {
    const text = `Przegląd klimatyzacji ${'x'.repeat(150)} https://firma.pl/a`;
    const message = await post('/v1/messages', { to: '48601000001', text }, idem);
    const pkg = await post('/v1/packages', { defaultText: text, recipients: [{ to: '48601000002' }] }, { 'idempotency-key': 'rozsylka-17' });
    expect([message.statusCode, pkg.statusCode]).toEqual([202, 202]);
    testDb.prepare('UPDATE api_keys SET max_parts = 1 WHERE id = ?').run(apiKeyId);
    const messageAgain = await post('/v1/messages', { to: '48601000001', text }, idem);
    const pkgAgain = await post('/v1/packages', { defaultText: text, recipients: [{ to: '48601000002' }] }, { 'idempotency-key': 'rozsylka-17' });
    expect([messageAgain.statusCode, pkgAgain.statusCode]).toEqual([202, 202]);
    expect(messageAgain.json().id).toBe(message.json().id);
    expect(pkgAgain.json().id).toBe(pkg.json().id);
  });
});

describe('POST /v1/messages/:id/cancel', () => {
  it('wyłącza kody anulowanej wiadomości', async () => {
    const res = await post('/v1/messages', { to: '48601000001', text: 'Oferta https://firma.pl/a' });
    const id = res.json().id as string;
    const cancel = await post(`/v1/messages/${id}/cancel`, {});
    expect(cancel.statusCode).toBe(200);
    expect(shortLinks.forMessage(id).map((l) => l.disabledAt)).toEqual([NOW.toISOString()]);
  });
});
