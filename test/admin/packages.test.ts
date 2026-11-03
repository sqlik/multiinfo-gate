import { beforeEach, describe, expect, it } from 'vitest';
import { defaultPowerAutomateConfig } from '../../src/integrations/config.ts';
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

  it('gotowy raport jednego odbiorcy w poprawnej odmianie', async () => {
    seed('pkg_1', [{ dest: '48601135134', text: null, clientId: null }]);
    h.packages.setCreated('pkg_1', '14');
    h.packages.setCompleted('pkg_1', NOW);
    h.packages.setReport('pkg_1', { status: 'ready', reportId: '123' });
    expect((await page('/rozsylki/pkg_1')).body).toContain('gotowy · 1 odbiorca');
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
    expect(res.body).toContain('nieutworzony');
  });

  it('przed zamówieniem raportu mówi, kiedy raport powstanie, bez „(stan: -)”', async () => {
    seed('pkg_q');
    const queued = (await page('/rozsylki/pkg_q')).body;
    expect(queued).toContain('Podsumowanie pojawi się po wczytaniu raportu. Bramka zamówi raport po zakończeniu rozsyłki.');
    expect(queued).not.toContain('(stan: -)');

    seed('pkg_c');
    h.packages.setCreated('pkg_c', '14');
    h.packages.setCompleted('pkg_c', NOW);
    const completed = (await page('/rozsylki/pkg_c')).body;
    expect(completed).toContain('Podsumowanie pojawi się po wczytaniu raportu. Raport nie został jeszcze zamówiony.');
    expect(completed).not.toContain('(stan: -)');
  });

  it('rozsyłka anulowana albo z błędem nie zapowiada podsumowania', async () => {
    seed('pkg_f');
    h.packages.setFailed('pkg_f', 13, 'Nieprawidłowa usługa', NOW);
    seed('pkg_x');
    h.packages.setCancelled('pkg_x', NOW);
    for (const id of ['pkg_f', 'pkg_x']) {
      const body = (await page(`/rozsylki/${id}`)).body;
      expect(body, id).toContain('Raport powstaje tylko dla zakończonej rozsyłki, więc podsumowania nie będzie.');
      expect(body, id).not.toContain('Podsumowanie pojawi się');
    }
  });

  it('raport w przygotowaniu podaje stan raportu', async () => {
    seed('pkg_p');
    h.packages.setCreated('pkg_p', '14');
    h.packages.setCompleted('pkg_p', NOW);
    h.packages.setReport('pkg_p', { status: 'pending' });
    expect((await page('/rozsylki/pkg_p')).body).toContain('Podsumowanie pojawi się po wczytaniu raportu (stan: w przygotowaniu).');
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

describe('rozsyłka z integracji Power Automate', () => {
  function seedFromIntegration() {
    const integrationId = h.integrations.insert({
      name: 'Kierowcy floty', kind: 'power_automate', apiKeyId, serviceId: null, orig: null, preset: 'power-automate', enabled: 1,
      config: defaultPowerAutomateConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    h.packages.insert({
      id: 'pkg_pa', apiKeyId, accountId, serviceId: '24138', defaultText: 'Przegląd floty', orig: null,
      costCenter: null, startAt: null, deliveryReport: 1, encoding: 'ucs2', multipart: 0, createdAt: NOW.toISOString(),
      integrationId, requestedBy: '<b>Kierownik</b>',
    }, [{ dest: '48601000001', text: null, clientId: null }]);
    return integrationId;
  }

  it('szczegół pokazuje integrację z odnośnikiem i zlecającego jako tekst', async () => {
    const integrationId = seedFromIntegration();
    const body = (await page('/rozsylki/pkg_pa')).body;
    expect(body).toContain(`<div>Integracja</div><div><a href="/integracje/${integrationId}">Kierowcy floty</a></div>`);
    expect(body).toContain('>Zlecający<');
    expect(body).toContain('&lt;b&gt;Kierownik&lt;/b&gt;');
  });

  it('rozsyłka z API nie ma wierszy integracji ani zlecającego', async () => {
    seed();
    const body = (await page('/rozsylki/pkg_1')).body;
    expect(body).not.toContain('<div>Integracja</div>');
    expect(body).not.toContain('Zlecający');
  });

  it('lista pokazuje nazwę integracji przy kluczu', async () => {
    seedFromIntegration();
    seed();
    const body = (await page('/rozsylki')).body;
    expect(body).toContain('Kierowcy floty');
    expect(body.match(/Kierowcy floty/g)).toHaveLength(1);
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
