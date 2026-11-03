import { beforeEach, describe, expect, it } from 'vitest';
import { powerAutomatePanel } from '../../src/admin/views/power-automate.ts';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-11-03T10:00:00Z');
let h: AdminHarness;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  seedAccount(h);
});

const get = (url: string, cookie = h.cookie) =>
  h.app.inject({ method: 'GET', url, headers: cookie === '' ? {} : { cookie } });
const download = (address: string) => get(`/klucze/power-automate?adres=${encodeURIComponent(address)}`);

describe('powerAutomatePanel', () => {
  it('bez adresu bramki ma puste pole z podpowiedzią, trzy kroki i odnośnik do artykułu', () => {
    const html = powerAutomatePanel(null);
    expect(html).toContain('Konektor Power Automate');
    expect(html).toContain('name="adres" value=""');
    expect(html).toContain('placeholder="https://sms.firma.pl"');
    expect(html).toContain('action="/klucze/power-automate"');
    expect(html).toContain('method="get"');
    expect(html).toContain('Pobierz konektor');
    expect(html).toContain('https://sqlik.github.io/multiinfo-gate/power-automate/');
    expect(html.match(/<li>/g)).toHaveLength(3);
  });

  it('publiczny adres bramki wypełnia pole', () => {
    expect(powerAutomatePanel('https://sms.firma.pl')).toContain('name="adres" value="https://sms.firma.pl"');
  });

  it('adres w sieci firmowej zostawia pole puste', () => {
    expect(powerAutomatePanel('http://10.10.10.159:8080')).toContain('name="adres" value=""');
  });

  it('adres z portem innym niż 443 wypełnia pole i dostaje ostrzeżenie o porcie', () => {
    const html = powerAutomatePanel('https://sms.firma.pl:8443');
    expect(html).toContain('name="adres" value="https://sms.firma.pl:8443"');
    expect(html).toContain('port 8443');
  });
});

describe('strona kluczy', () => {
  it('bez adresu bramki pokazuje panel konektora z pustym polem', async () => {
    const body = (await get('/klucze')).body;
    expect(body).toContain('Konektor Power Automate');
    expect(body).toContain('name="adres" value=""');
  });

  it('z publicznym adresem bramki wypełnia pole tym adresem', async () => {
    h.settings.setApiUrl('https://sms.firma.pl', NOW);
    expect((await get('/klucze')).body).toContain('name="adres" value="https://sms.firma.pl"');
  });

  it('z adresem w sieci firmowej zostawia pole puste', async () => {
    h.settings.setApiUrl('http://10.10.10.159:8080', NOW);
    expect((await get('/klucze')).body).toContain('name="adres" value=""');
  });

  it('ekran nowego klucza mówi, że ten sam klucz wkleja się w Power Automate', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/klucze',
      headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        name: 'Power Automate', accountId: String(h.accounts.list()[0]!.id), serviceIds: '24138', maxParts: '5',
        ratePerMin: '60', noExpiry: '1',
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Ten sam klucz wkleja się w oknie połączenia konektora Power Automate');
  });
});

describe('GET /klucze/power-automate', () => {
  it('oddaje plik konektora jako załącznik z adresem z pola, bez zapisu adresu', async () => {
    h.settings.setApiUrl('http://10.10.10.159:8080', NOW);
    const res = await download('https://sms.firma.pl');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="multiinfo-gate-power-automate.json"');
    const doc = JSON.parse(res.body);
    expect(doc.swagger).toBe('2.0');
    expect(doc.host).toBe('sms.firma.pl');
    expect(res.body).toContain('\n  "swagger"');
    expect(h.settings.apiUrl()).toBe('http://10.10.10.159:8080');
  });

  it('adres, którego Power Automate nie użyje, wraca na stronę kluczy z komunikatem', async () => {
    const res = await download('http://10.0.0.5:8080');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/klucze');
    const next = (await get('/klucze')).body;
    expect(next).toContain('Adres dla Power Automate musi zaczynać się od https://');
  });

  it('brak parametru adresu też wraca z komunikatem', async () => {
    const res = await get('/klucze/power-automate');
    expect(res.statusCode).toBe(302);
    expect((await get('/klucze')).body).toContain('Adres dla Power Automate');
  });

  it('powtórzony parametr adresu nie wywraca trasy', async () => {
    const res = await get('/klucze/power-automate?adres=https://sms.firma.pl&adres=https://inny.firma.pl');
    expect(res.statusCode).toBe(302);
  });

  it('bez sesji odsyła do logowania', async () => {
    const res = await get('/klucze/power-automate?adres=https://sms.firma.pl', '');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/zaloguj');
  });

  it('pobranie nie zostawia wpisu w dzienniku zdarzeń', async () => {
    const before = h.audit.list(100, 0).length;
    await download('https://sms.firma.pl');
    await download('http://10.0.0.5');
    expect(h.audit.list(100, 0).length).toBe(before);
  });
});
