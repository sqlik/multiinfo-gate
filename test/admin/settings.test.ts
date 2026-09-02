import { beforeEach, describe, expect, it } from 'vitest';
import { parseApiUrl } from '../../src/admin/routes/settings.ts';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
let h: AdminHarness;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
});

const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string, fields: Record<string, string>) => h.app.inject({
  method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString(),
});

describe('adres bramki', () => {
  it('parseApiUrl: http(s) z hostem i portem, bez ścieżki, ukośnik na końcu obcięty', () => {
    expect(parseApiUrl('https://sms.firma.pl/')).toEqual({ ok: true, url: 'https://sms.firma.pl' });
    expect(parseApiUrl('http://10.10.10.159:8080')).toEqual({ ok: true, url: 'http://10.10.10.159:8080' });
    expect(parseApiUrl('sms.firma.pl').ok).toBe(false);
    expect(parseApiUrl('https://sms.firma.pl/hooks').ok).toBe(false);
    expect(parseApiUrl('https://user:pass@sms.firma.pl').ok).toBe(false);
  });

  it('bez adresu ekran kluczy prosi o niego, po zapisie pokazuje go z kopiowaniem i wraca na wskazaną stronę', async () => {
    const before = await page('/klucze');
    expect(before.body).toContain('Panel nie wie, pod jakim adresem aplikacje docierają do bramki');
    const res = await post('/adres-bramki', { apiUrl: 'https://sms.firma.pl/', wroc: '/klucze' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/klucze');
    expect(h.settings.apiUrl()).toBe('https://sms.firma.pl');
    const after = await page('/klucze');
    expect(after.body).toContain('id="api-url">https://sms.firma.pl<');
    expect(after.body).not.toContain('Panel nie wie, pod jakim adresem');
    expect(h.audit.list(50, 0).some((a) => a.action === 'ustawienia.adres_bramki')).toBe(true);
  });

  it('zły adres to komunikat i brak zapisu; wyczyszczenie kasuje; powrót tylko na stronę panelu', async () => {
    const bad = await post('/adres-bramki', { apiUrl: 'firma.pl', wroc: '/integracje' });
    expect(bad.statusCode).toBe(302);
    expect(h.settings.apiUrl()).toBeNull();
    h.settings.setApiUrl('https://sms.firma.pl', NOW);
    const cleared = await post('/adres-bramki', { apiUrl: '', wyczysc: '1', wroc: 'https://zly.example/' });
    expect(cleared.headers.location).toBe('/klucze');
    expect(h.settings.apiUrl()).toBeNull();
  });

  it('nowy klucz dostaje przykład curl z pełnym adresem, a integracja pełny adres wejściowy', async () => {
    h.settings.setApiUrl('https://sms.firma.pl', NOW);
    const accountId = seedAccount(h);
    const created = await post('/klucze', { accountId: String(accountId), name: 'Sklep', serviceIds: '24138', defaultServiceId: '24138', maxParts: '5', ratePerMin: '60', webhookUrl: '', expiresOn: '', noExpiry: '1' });
    expect(created.statusCode).toBe(200);
    expect(created.body).toContain('curl -s https://sms.firma.pl/v1/messages');
    const keyId = h.apiKeys.list()[0]!.id;
    const integration = await post('/integracje', {
      kind: 'webhook_in', preset: 'prosty-json', name: 'Automat', apiKeyId: String(keyId), serviceId: '', orig: '', enabled: '1',
      authHeaderName: '', authHeaderValue: '', authBasicUser: '', authBasicPass: '', sources: '', conditionMode: 'builder', conditionExpr: '',
      toPath: 'to', toFallback: '', ticketRefPath: '', eventIdPath: '', textMode: 'path', textPath: 'text', textTemplate: '', maxParts: '3', overflow: 'reject',
      throttleLimit: '10', throttleWindow: '10', eventLogLimit: '200', sample: '{}', action: 'zapisz',
    });
    expect(integration.statusCode).toBe(200);
    const row = h.integrations.list()[0]!;
    expect(integration.body).toContain(`id="hook-path">https://sms.firma.pl/hooks/${row.hookId}<`);
    const detail = await page(`/integracje/${row.id}`);
    expect(detail.body).toContain(`https://sms.firma.pl/hooks/${row.hookId}`);
  });
});
