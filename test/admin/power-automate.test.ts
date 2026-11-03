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

describe('powerAutomatePanel', () => {
  it('bez adresu bramki ma puste pole z podpowiedzią, trzy kroki, powrót i odnośnik do artykułu', () => {
    const html = powerAutomatePanel(null, '/integracje/12');
    expect(html).toContain('Konektor Power Automate');
    expect(html).toContain('name="adres" value=""');
    expect(html).toContain('placeholder="https://sms.firma.pl"');
    expect(html).toContain('action="/integracje/power-automate/konektor"');
    expect(html).toContain('method="get"');
    expect(html).toContain('<input type="hidden" name="wroc" value="/integracje/12">');
    expect(html).toContain('Pobierz konektor');
    expect(html).toContain('https://sqlik.github.io/multiinfo-gate/power-automate/');
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain('klucz API wybrany w tej integracji');
    expect(html).not.toContain('do grupy z panelu bramki');
  });

  it('publiczny adres bramki wypełnia pole', () => {
    expect(powerAutomatePanel('https://sms.firma.pl', '/integracje')).toContain('name="adres" value="https://sms.firma.pl"');
  });

  it('adres w sieci firmowej zostawia pole puste', () => {
    expect(powerAutomatePanel('http://10.10.10.159:8080', '/integracje')).toContain('name="adres" value=""');
  });

  it('adres z portem innym niż 443 zostawia pole puste, bez ostrzeżenia o porcie', () => {
    const html = powerAutomatePanel('https://sms.firma.pl:8443', '/integracje');
    expect(html).toContain('name="adres" value=""');
    expect(html).not.toContain('class="warn"');
  });

  it('podpowiedź mówi, że adres jest bez portu albo z portem 443', () => {
    expect(powerAutomatePanel(null, '/integracje')).toContain('bez portu albo z portem 443');
  });

  it('powrót trafia do pola ukrytego jako tekst', () => {
    expect(powerAutomatePanel(null, '/integracje/nowa?rodzaj=power_automate&ustawienie=power-automate'))
      .toContain('name="wroc" value="/integracje/nowa?rodzaj=power_automate&amp;ustawienie=power-automate"');
  });
});

describe('strona kluczy', () => {
  it('nie ma panelu konektora, a dawna trasa pobrania nie istnieje', async () => {
    h.settings.setApiUrl('https://sms.firma.pl', NOW);
    expect((await get('/klucze')).body).not.toContain('Konektor Power Automate');
    expect((await get('/klucze/power-automate?adres=https://sms.firma.pl')).statusCode).toBe(404);
  });

  it('ekran nowego klucza mówi, gdzie wybrać klucz dla Power Automate', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/klucze',
      headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        name: 'Power Automate', accountId: String(h.accounts.list()[0]!.id), serviceIds: '24138', maxParts: '5',
        ratePerMin: '60', noExpiry: '1',
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Klucz dla Power Automate wybiera się w integracji Power Automate (Integracje, Dodaj integrację, Aplikacja wysyła SMS, Power Automate)');
    expect(res.body).toContain('w oknie połączenia konektora');
  });
});
