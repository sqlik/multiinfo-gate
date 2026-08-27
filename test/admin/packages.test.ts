import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-08-25T10:00:00Z');

let h: AdminHarness;
let accountId: number;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Rozsyłki CRM', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4',
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
});

function seed(id = 'pkg_1', recipients = [
  { dest: '48601135134', text: null, clientId: null },
  { dest: '48501052442', text: 'Indywidualna', clientId: 'faktura-114' },
]) {
  h.packages.insert({
    id, apiKeyId, accountId, serviceId: '24138', defaultText: 'Domyślna', orig: 'Firma Info',
    costCenter: null, startAt: null, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: NOW.toISOString(),
  }, recipients);
  return id;
}

function ready(id: string) {
  h.packages.setCreated(id, '14');
  h.packages.setCompleted(id, NOW);
  h.packages.applyReport(id, [
    { miId: '9001', dest: '48601135134', miStatus: 21, status: 'delivered', rawStatus: '21', changedAt: '2026-08-25 12:00:00', clientId: null },
    { miId: '9002', dest: '48501052442', miStatus: 11, status: 'failed', rawStatus: '11', changedAt: '2026-08-25 12:00:01', clientId: 'faktura-114' },
  ]);
  h.packages.setReport(id, { status: 'ready', reportId: '123', expiresAt: '2026-08-25T12:30:00.000Z' });
}

const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

describe('GET /rozsylki', () => {
  it('pokazuje rozsyłkę ze statusem po polsku i nazwami konta oraz klucza', async () => {
    seed();
    h.packages.setCreated('pkg_1', '14');
    h.packages.setProgress('pkg_1', { remaining: 1, miStatus: 2, status: 'sending' });
    const res = await page('/rozsylki');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('pkg_1');
    expect(res.body).toContain('w wysyłce');
    expect(res.body).toContain('Firma Info');
    expect(res.body).toContain('Rozsyłki CRM');
    expect(res.body).toContain('/rozsylki/pkg_1');
    expect(res.body).not.toContain('sending');
  });

  it('pokazuje odnośnik do CSV tylko przy gotowym raporcie', async () => {
    seed();
    expect((await page('/rozsylki')).body).not.toContain('/rozsylki/pkg_1/raport.csv');
    ready('pkg_1');
    expect((await page('/rozsylki')).body).toContain('/rozsylki/pkg_1/raport.csv');
  });

  it('ma pozycję w nawigacji i wymaga sesji', async () => {
    expect((await page('/rozsylki')).body).toContain('href="/rozsylki"');
    const anon = await h.app.inject({ method: 'GET', url: '/rozsylki' });
    expect(anon.statusCode).toBe(302);
  });
});

describe('GET /rozsylki/:id', () => {
  it('pokazuje parametry, odbiorców i ich statusy', async () => {
    seed();
    ready('pkg_1');
    const res = await page('/rozsylki/pkg_1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('zakończona');
    expect(res.body).toContain('48601135134');
    expect(res.body).toContain('faktura-114');
    expect(res.body).toContain('doręczona');
    expect(res.body).toContain('9002');
    expect(res.body).toContain('<td class="m dim">11</td>');
    expect(res.body).not.toContain('błąd wewnętrzny');
    expect(res.body).toContain('Pobierz CSV');
    expect(res.body).toContain('GSM-7');
  });

  it('pokazuje przycisk CSV w nagłówku, gdy raport jest gotowy', async () => {
    seed();
    ready('pkg_1');
    const res = await page('/rozsylki/pkg_1');
    expect(res.body).toMatch(/<div class="head">[\s\S]*class="btn btn-p" href="\/rozsylki\/pkg_1\/raport\.csv">Pobierz CSV<\/a>/);
    expect(res.body).not.toMatch(/<div class="kv">[\s\S]*Pobierz CSV/);
    expect(res.body).toContain('gotowy · 2 odbiorców');
  });

  it('bez gotowego raportu pokazuje wyszarzony przycisk ze stanem', async () => {
    seed('pkg_2');
    h.packages.setCreated('pkg_2', '14');
    const res = await page('/rozsylki/pkg_2');
    expect(res.body).toMatch(/class="btn btn-s disabled"[^>]*>Pobierz CSV/);
    expect(res.body).not.toContain('raport.csv');
  });

  it('bez raportu pokazuje, że podsumowanie dopiero będzie', async () => {
    seed();
    const res = await page('/rozsylki/pkg_1');
    expect(res.body).toContain('Podsumowanie pojawi się po wczytaniu raportu');
    expect(res.body).toContain('brak raportu');
    expect(res.body).toContain('jeszcze nie utworzono');
  });

  it('pokazuje błąd z kodem operatora', async () => {
    seed();
    h.packages.setFailed('pkg_1', -63, 'Zbyt wielu odbiorców', NOW);
    const res = await page('/rozsylki/pkg_1');
    expect(res.body).toContain('-63');
    expect(res.body).toContain('Zbyt wielu odbiorców');
    expect(res.body).toContain('błąd');
  });

  it('ucieka HTML w identyfikatorze klienta i treści', async () => {
    seed('pkg_x', [{ dest: '48601135134', text: '<b>x</b>', clientId: '<img src=x>' }]);
    const res = await page('/rozsylki/pkg_x');
    expect(res.body).not.toContain('<img src=x>');
    expect(res.body).not.toContain('<b>x</b>');
    expect(res.body).toContain('&lt;img src=x&gt;');
  });

  it('zwraca 404 dla nieznanej rozsyłki', async () => {
    expect((await page('/rozsylki/pkg_nie_ma')).statusCode).toBe(404);
  });
});

describe('GET /rozsylki/:id/raport.csv', () => {
  it('zwraca CSV z nagłówkiem i wierszami', async () => {
    seed();
    ready('pkg_1');
    const res = await page('/rozsylki/pkg_1/raport.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('pkg_1.csv');
    const lines = res.body.split('\r\n');
    expect(lines[0]).toBe('numer;identyfikator_klienta;id_multiinfo;status;status_multiinfo;czas');
    expect(lines[1]).toBe('48601135134;;9001;delivered;21;2026-08-25 12:00:00');
    expect(lines[2]).toBe('48501052442;faktura-114;9002;failed;11;2026-08-25 12:00:01');
  });

  it('odmawia, gdy raport nie jest gotowy', async () => {
    seed();
    expect((await page('/rozsylki/pkg_1/raport.csv')).statusCode).toBe(409);
    expect((await page('/rozsylki/pkg_nie_ma/raport.csv')).statusCode).toBe(404);
  });
});
