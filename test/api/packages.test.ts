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

const masterKey = randomBytes(32);
const NOW = new Date('2026-08-25T10:00:00Z');
let app: ReturnType<typeof buildApiServer>;
let apiKey: string;
let keyB: string;
let jobs: JobsRepo;
let packages: PackagesRepo;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  jobs = new JobsRepo(db);
  packages = new PackagesRepo(db);

  const accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent: 1,
    serviceIds: ['24138', '24902'], origs: ['Firma Info', 'Firma Wind', 'Firma Alert'],
  });

  const a = generateApiKey();
  const b = generateApiKey();
  apiKey = a.key;
  keyB = b.key;
  apiKeys.insert({
    accountId, name: 'Rozsyłki', keyHash: a.hash, keyPrefix: a.prefix,
    defaultServiceId: '24138', defaultOrig: 'Firma Info', maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], origs: ['Firma Alert'],
  });
  apiKeys.insert({
    accountId, name: 'Inny', keyHash: b.hash, keyPrefix: b.prefix,
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });

  app = buildApiServer({
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs, packages,
    clients: {} as never, rateLimiter: new RateLimiter(), now: () => NOW,
  });
  await app.ready();
});

const post = (body: unknown, key = apiKey) =>
  app.inject({ method: 'POST', url: '/v1/packages', headers: { authorization: `Bearer ${key}` }, payload: body });
const get = (url: string, key = apiKey) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });

const body = () => ({
  defaultText: 'Tresc domyslna',
  recipients: [{ to: '48601135134' }, { to: '501 052 442', text: 'Indywidualna', clientId: 'faktura-114' }],
});

describe('POST /v1/packages', () => {
  it('przyjmuje rozsyłkę, normalizuje numery i kolejkuje utworzenie', async () => {
    const res = await post(body());
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'queued', recipients: 2, encoding: 'gsm', multipart: false });
    expect(res.json().id).toMatch(/^pkg_[0-9a-f]{20}$/);
    const pkg = packages.get(res.json().id)!;
    expect(pkg.defaultText).toBe('Tresc domyslna');
    expect(pkg.orig).toBe('Firma Info');
    expect(pkg.serviceId).toBe('24138');
    expect(pkg.deliveryReport).toBe(1);
    expect(pkg.createdAt).toBe(NOW.toISOString());
    const rec = packages.recipients(pkg.id);
    expect(rec.map((r) => r.dest)).toEqual(['48601135134', '48501052442']);
    expect(rec[0]).toMatchObject({ text: null, clientId: null });
    expect(rec[1]).toMatchObject({ text: 'Indywidualna', clientId: 'faktura-114' });
    const claimed = jobs.claim(NOW, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.type).toBe('package.create');
    expect(claimed[0]!.payload).toEqual({ packageId: pkg.id });
  });

  it('wybiera UCS-2 dla całej rozsyłki, gdy choć jeden tekst tego wymaga', async () => {
    const res = await post({ ...body(), recipients: [{ to: '48601135134', text: 'Zażółć' }, { to: '48601135135' }] });
    expect(res.json().encoding).toBe('ucs2');
    expect(packages.get(res.json().id)!.encoding).toBe('ucs2');
  });

  it('zostaje przy GSM-7, gdy klient wymusił to kodowanie', async () => {
    const res = await post({ ...body(), encoding: 'gsm', recipients: [{ to: '48601135134', text: 'Zażółć' }] });
    expect(res.json().encoding).toBe('gsm');
  });

  it('ustawia isMultiPart, gdy tekst przekracza jedną część', async () => {
    const res = await post({ ...body(), defaultText: 'a'.repeat(200) });
    expect(res.json().multipart).toBe(true);
    expect(packages.get(res.json().id)!.multipart).toBe(1);
  });

  it('zapisuje termin rozpoczęcia, nadpis jawny, centrum kosztów i brak raportu', async () => {
    const startAt = new Date(NOW.getTime() + 3600_000).toISOString();
    const res = await post({ ...body(), startAt, orig: 'Firma Alert', costCenter: 'marketing', deliveryReport: false });
    expect(res.statusCode).toBe(202);
    const pkg = packages.get(res.json().id)!;
    expect(pkg.startAt).toBe(startAt);
    expect(pkg.orig).toBe('Firma Alert');
    expect(pkg.costCenter).toBe('marketing');
    expect(pkg.deliveryReport).toBe(0);
  });

  it('odrzuca odbiorcę bez treści, gdy brak treści domyślnej', async () => {
    const res = await post({ recipients: [{ to: '48601135134' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('text_required');
  });

  it('odrzuca tekst przekraczający limit części klucza', async () => {
    const res = await post({ ...body(), defaultText: 'a'.repeat(153 * 6) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('too_many_parts');
  });

  it('odrzuca identyfikator klienta ze znakami spoza dozwolonych', async () => {
    const res = await post({ ...body(), recipients: [{ to: '48601135134', clientId: 'a,b' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_client_id');
    expect((await post({ ...body(), recipients: [{ to: '48601135134', clientId: 'a'.repeat(21) }] })).json().error.code).toBe('invalid_client_id');
  });

  it('odrzuca zły numer ze wskazaniem odbiorcy', async () => {
    const res = await post({ ...body(), recipients: [{ to: '48601135134' }, { to: 'abc' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_phone');
    expect(res.json().error.message).toContain('recipients.1');
  });

  it('odrzuca nadpis spoza uprawnień klucza', async () => {
    expect((await post({ ...body(), orig: 'Firma Wind' })).statusCode).toBe(403);
  });

  it('odrzuca usługę spoza uprawnień klucza', async () => {
    const res = await post({ ...body(), serviceId: '24902' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('service_not_allowed');
  });

  it('odrzuca startAt w przeszłości', async () => {
    const res = await post({ ...body(), startAt: new Date(NOW.getTime() - 1000).toISOString() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('start_at_in_past');
  });

  it('odrzuca więcej niż 5000 odbiorców i pustą listę', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ to: `4860100${String(i).padStart(4, '0')}` }));
    expect((await post({ ...body(), recipients: many })).statusCode).toBe(400);
    expect((await post({ ...body(), recipients: [] })).statusCode).toBe(400);
  });

  it('odrzuca żądanie bez klucza', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/packages', payload: body() })).statusCode).toBe(401);
  });

  it('nie zapisuje niczego, gdy któryś odbiorca jest błędny', async () => {
    await post({ ...body(), recipients: [{ to: '48601135134' }, { to: 'abc' }] });
    expect(packages.list({ limit: 10, offset: 0 })).toHaveLength(0);
    expect(jobs.depth()).toBe(0);
  });
});

describe('raport rozsyłki', () => {
  async function completed(): Promise<string> {
    const id = (await post(body())).json().id as string;
    packages.setCreated(id, '14');
    packages.setCompleted(id, NOW);
    return id;
  }

  function ready(id: string) {
    packages.applyReport(id, [
      { miId: '9001', dest: '48601135134', miStatus: 21, status: 'delivered', rawStatus: '21', changedAt: '2026-08-25 12:00:00', clientId: null },
      { miId: '9002', dest: '48501052442', miStatus: 11, status: 'failed', rawStatus: '11', changedAt: '2026-08-25 12:00:01', clientId: 'faktura-114' },
    ]);
    packages.setReport(id, { status: 'ready', reportId: '123', expiresAt: '2026-08-25T12:30:00.000Z' });
  }

  it('POST zamawia raport zakończonej rozsyłki', async () => {
    const id = await completed();
    jobs.claim(NOW, 10);
    const res = await app.inject({
      method: 'POST', url: `/v1/packages/${id}/report`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id, report: { status: 'pending' } });
    expect(packages.get(id)!.reportStatus).toBe('pending');
    expect(jobs.claim(NOW, 10).map((j) => j.type)).toEqual(['package.report']);
  });

  it('POST odmawia raportu rozsyłki jeszcze niezakończonej', async () => {
    const id = (await post(body())).json().id;
    const res = await app.inject({ method: 'POST', url: `/v1/packages/${id}/report`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('package_not_completed');
  });

  it('GET zwraca 409 ze stanem, gdy raport nie jest gotowy', async () => {
    const id = await completed();
    packages.setReport(id, { status: 'pending' });
    const res = await get(`/v1/packages/${id}/report`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'report_not_ready', message: 'Raport nie jest gotowy; stan: pending.' }, report: { status: 'pending' },
    });
  });

  it('GET zwraca gotowy raport jako JSON', async () => {
    const id = await completed();
    ready(id);
    const res = await get(`/v1/packages/${id}/report`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id, report: { status: 'ready', expiresAt: '2026-08-25T12:30:00.000Z' },
      rows: [
        { to: '48601135134', clientId: null, miId: '9001', status: 'delivered', miStatus: 21, changedAt: '2026-08-25 12:00:00' },
        { to: '48501052442', clientId: 'faktura-114', miId: '9002', status: 'failed', miStatus: 11, changedAt: '2026-08-25 12:00:01' },
      ],
    });
  });

  it('GET zwraca CSV na żądanie parametrem albo nagłówkiem Accept', async () => {
    const id = await completed();
    ready(id);
    const res = await get(`/v1/packages/${id}/report?format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(`${id}.csv`);
    expect(res.body).toBe(
      'numer;identyfikator_klienta;id_multiinfo;status;status_multiinfo;czas\r\n'
      + '48601135134;;9001;delivered;21;2026-08-25 12:00:00\r\n'
      + '48501052442;faktura-114;9002;failed;11;2026-08-25 12:00:01\r\n',
    );
    const byAccept = await app.inject({
      method: 'GET', url: `/v1/packages/${id}/report`, headers: { authorization: `Bearer ${apiKey}`, accept: 'text/csv' },
    });
    expect(byAccept.headers['content-type']).toContain('text/csv');
  });

  it('nie ujawnia cudzego raportu', async () => {
    const id = await completed();
    ready(id);
    expect((await get(`/v1/packages/${id}/report`, keyB)).statusCode).toBe(404);
    const res = await app.inject({ method: 'POST', url: `/v1/packages/${id}/report`, headers: { authorization: `Bearer ${keyB}` } });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/packages/:id', () => {
  it('zwraca stan rozsyłki bez podsumowania przed raportem', async () => {
    const id = (await post(body())).json().id;
    const res = await get(`/v1/packages/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id, status: 'queued', recipients: 2, remaining: null, encoding: 'gsm', multipart: false,
      serviceId: '24138', orig: 'Firma Info', startAt: null, createdAt: NOW.toISOString(),
      completedAt: null, providerCode: null, error: null, report: { status: 'none', expiresAt: null }, summary: null,
    });
    expect(res.body).not.toContain('Tresc domyslna');
  });

  it('dodaje podsumowanie, gdy raport jest gotowy', async () => {
    const id = (await post(body())).json().id;
    packages.applyReport(id, [
      { miId: '1', dest: '48601135134', miStatus: 21, status: 'delivered', rawStatus: '21', changedAt: '2026-08-25 12:00:00', clientId: null },
    ]);
    packages.setReport(id, { status: 'ready' });
    expect((await get(`/v1/packages/${id}`)).json().summary).toEqual({ delivered: 1, failed: 0, other: 1 });
  });

  it('nie ujawnia cudzej rozsyłki', async () => {
    const id = (await post(body())).json().id;
    const res = await get(`/v1/packages/${id}`, keyB);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('package_not_found');
  });
});
