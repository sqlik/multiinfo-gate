import { beforeEach, describe, expect, it } from 'vitest';
import { generateApiKey } from '../../src/api/keys.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { defaultPowerAutomateConfig, type PowerAutomateConfig } from '../../src/integrations/config.ts';
import { integrationDeps } from '../helpers/api-deps.ts';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-11-03T10:00:00Z');
let h: AdminHarness;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  const accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Power Automate', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
});

const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string, fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
  return h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: params.toString() });
};
const formBody = (over: Record<string, string | string[]> = {}): Record<string, string | string[]> => ({
  name: 'Ekipa serwisowa', apiKeyId: String(apiKeyId), serviceId: '', orig: '', enabled: '1',
  recipients: '601 000 011 Marek Kowalski\n601000012', maxParts: '3', overflow: 'reject',
  throttleLimit: '30', throttleWindow: '10', throttleRecipients: '5000', eventLogLimit: '200', tryb: 'prosty', ...over,
});
const create = (over: Record<string, string | string[]> = {}) => post('/integracje', { kind: 'power_automate', preset: 'power-automate', ...formBody(over) });
const paRow = () => h.integrations.list().find((r) => r.kind === 'power_automate')!;
const NEW_FORM = '/integracje/nowa?rodzaj=power_automate&ustawienie=power-automate';

describe('katalog „do SMS”', () => {
  it('kafelek „Power Automate” stoi po „n8n” i prowadzi do formularza rodzaju power_automate', async () => {
    const body = (await get('/integracje/nowa?rodzaj=webhook_in')).body;
    const tile = 'href="/integracje/nowa?rodzaj=power_automate&amp;ustawienie=power-automate"';
    expect(body).toContain(tile);
    expect(body).toContain('SMS z przepływu Microsoft Power Automate');
    expect(body.indexOf('ustawienie=n8n')).toBeGreaterThan(-1);
    expect(body.indexOf(tile)).toBeGreaterThan(body.indexOf('ustawienie=n8n'));
    expect(body.indexOf(tile)).toBeLessThan(body.indexOf('ustawienie=uptime-kuma'));
  });

  it('sam rodzaj power_automate bez ustawienia prowadzi od razu do formularza', async () => {
    const res = await get('/integracje/nowa?rodzaj=power_automate');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(NEW_FORM);
  });
});

describe('formularz', () => {
  it('tryb prosty: podstawy, odbiorcy grupy, treść z limitem części, konektor; bez warunku, szablonu, próbki i ochrony', async () => {
    const res = await get(NEW_FORM);
    expect(res.statusCode).toBe(200);
    const form = res.body;
    for (const t of ['Jak działa Power Automate', 'Podstawy', 'Odbiorcy grupy', 'Numery odbiorców', 'Treść', 'Limit części', 'skróć i wyślij',
      'nie wysyłaj, zapisz błąd i powiadom', 'Konektor Power Automate', 'Utwórz integrację', 'name="kind" value="power_automate"',
      'pojawia się w Power Automate w polu „Integracja”', 'Wyślij SMS do grupy', 'Prosty', 'Zaawansowany']) {
      expect(form, t).toContain(t);
    }
    for (const t of ['Kiedy wysyłać', 'Szablon Liquid', 'Sprawdź', 'Ochrona i dziennik', 'Próbka']) expect(form, t).not.toContain(t);
    expect(form).toContain('name="throttleLimit" value="30"');
  });

  it('tryb zaawansowany dokłada ochronę i dziennik', async () => {
    const form = (await get(`${NEW_FORM}&tryb=zaawansowany`)).body;
    expect(form).toContain('Ochrona i dziennik');
    expect(form).toContain('Limit burzy');
    expect(form).toContain('name="throttleRecipients" type="number" min="1" max="50000" value="5000"');
    expect(form).toContain('Limit odbiorców');
    expect(form).toContain('Ochrona przed burzą, dziennik i ładunki');
  });

  it('formularz integracji zamyka się przed formularzem pobrania konektora: pola integracji nie trafiają do adresu pobrania', async () => {
    const form = (await get(NEW_FORM)).body;
    const save = form.indexOf('method="post"');
    const close = form.indexOf('</form>', save);
    const download = form.indexOf('action="/integracje/power-automate/konektor"');
    expect(save).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(close);
    expect(form).toContain('name="wroc" value="/integracje/nowa?rodzaj=power_automate&amp;ustawienie=power-automate&amp;tryb=prosty"');
  });
});

describe('zapis', () => {
  it('tworzy integrację power_automate ze znormalizowaną listą, audytem i przejściem na szczegóły', async () => {
    const res = await create();
    expect(res.statusCode).toBe(302);
    const row = paRow();
    expect(res.headers.location).toBe(`/integracje/${row.id}`);
    expect(row).toMatchObject({ name: 'Ekipa serwisowa', preset: 'power-automate', enabled: 1, apiKeyId });
    expect(row.config).toEqual({
      ...defaultPowerAutomateConfig(),
      recipients: [{ phone: '48601000011', name: 'Marek Kowalski' }, { phone: '48601000012', name: '' }],
      maxParts: 3, overflow: 'reject', throttle: { limit: 30, windowMinutes: 10, recipients: 5000 },
    } satisfies PowerAutomateConfig);
    expect(h.audit.list(5, 0)[0]).toMatchObject({ action: 'integracja.utworzenie', target: `integracja:${row.id}` });
    expect((await get(`/integracje/${row.id}`)).body).toContain('Integracja Ekipa serwisowa utworzona.');
  });

  it('pusta lista odbiorców jest dozwolona', async () => {
    expect((await create({ recipients: '' })).statusCode).toBe(302);
    expect((paRow().config as PowerAutomateConfig).recipients).toEqual([]);
  });

  it('zły numer daje 400 z komunikatem o numerze, bez zapisu', async () => {
    const res = await create({ recipients: '601 000 011 Marek\nabc' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('abc');
    expect(h.integrations.list().filter((r) => r.kind === 'power_automate')).toEqual([]);
  });

  it('501 numerów daje 400', async () => {
    const lines = Array.from({ length: 501 }, (_, i) => `601${String(i).padStart(6, '0')}`).join('\n');
    const res = await create({ recipients: lines });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('najwyżej 500');
  });

  it('limit części spoza 1-9 daje 400', async () => {
    expect((await create({ maxParts: '12' })).statusCode).toBe(400);
  });
});

describe('edycja', () => {
  it('odtwarza listę z nazwami i zapisuje zmianę listy', async () => {
    await create();
    const row = paRow();
    const form = (await get(`/integracje/${row.id}/edytuj`)).body;
    expect(form).toContain('48601000011 Marek Kowalski');
    expect(form).toContain('Zapisz integrację');
    const res = await post(`/integracje/${row.id}/edytuj`, { kind: 'power_automate', preset: 'power-automate', ...formBody({ recipients: '601000013 Jan Nowak' }) });
    expect(res.statusCode).toBe(302);
    expect((paRow().config as PowerAutomateConfig).recipients).toEqual([{ phone: '48601000013', name: 'Jan Nowak' }]);
    expect(h.audit.list(5, 0)[0]).toMatchObject({ action: 'integracja.edycja', meta: expect.objectContaining({ pola: ['recipients'] }) });
  });

  it('tryb prosty zachowuje w polach ukrytych ochronę ustawioną w trybie zaawansowanym', async () => {
    await create({ throttleLimit: '5', throttleRecipients: '700', storePayloads: '1', tryb: 'zaawansowany' });
    expect(paRow().config).toMatchObject({ throttle: { limit: 5, windowMinutes: 10, recipients: 700 } });
    const form = (await get(`/integracje/${paRow().id}/edytuj`)).body;
    expect(form).not.toContain('Ochrona i dziennik');
    expect(form).toContain('<input type="hidden" name="throttleLimit" value="5">');
    expect(form).toContain('<input type="hidden" name="throttleRecipients" value="700">');
    expect(form).toContain('<input type="hidden" name="storePayloads" value="1">');
  });

  it('tryb prosty mówi o ochronie przed burzą zmienionej w trybie zaawansowanym', async () => {
    await create({ throttleLimit: '1000', throttleWindow: '1', tryb: 'zaawansowany' });
    const form = (await get(`/integracje/${paRow().id}/edytuj`)).body;
    expect(form).toContain('Ochrona przed burzą: najwyżej 1000 wywołań i 5000 odbiorców w ciągu 1 minuty. Wartości zmienia tryb zaawansowany');
  });

  it('tryb prosty z domyślną ochroną nie pokazuje zdania o ochronie', async () => {
    expect((await get(NEW_FORM)).body).not.toContain('Ochrona przed burzą: najwyżej');
  });

  it('limit odbiorców spoza 1-50000 daje 400', async () => {
    const res = await create({ throttleRecipients: '50001', tryb: 'zaawansowany' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Limit odbiorców: podaj liczbę od 1 do 50000.');
  });
});

describe('lista integracji', () => {
  it('wiersz z podpisem „Power Automate” i kierunkiem „do SMS”, widoczny w filtrze „Do SMS”', async () => {
    await create();
    const all = (await get('/integracje')).body;
    expect(all).toContain('Ekipa serwisowa');
    expect(all).toMatch(/Ekipa serwisowa<\/a><\/strong>\s*<div[^>]*>Power Automate<\/div>/);
    expect(all).toContain('<span class="tag">do SMS</span>');
    expect((await get('/integracje?rodzaj=in')).body).toContain('Ekipa serwisowa');
    expect((await get('/integracje?rodzaj=grupa')).body).not.toContain('Ekipa serwisowa');
  });
});

describe('pobranie konektora', () => {
  const download = (address: string, back = '/integracje/nowa?rodzaj=power_automate&ustawienie=power-automate', cookie = h.cookie) =>
    h.app.inject({
      method: 'GET', url: `/integracje/power-automate/konektor?adres=${encodeURIComponent(address)}&wroc=${encodeURIComponent(back)}`,
      headers: cookie === '' ? {} : { cookie },
    });

  it('oddaje plik konektora jako załącznik z adresem z pola, bez zapisu adresu', async () => {
    h.settings.setApiUrl('http://10.10.10.159:8080', NOW);
    const res = await download('https://sms.firma.pl');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="multiinfo-gate-power-automate.json"');
    expect(JSON.parse(res.body)).toMatchObject({ swagger: '2.0', host: 'sms.firma.pl' });
    expect(h.settings.apiUrl()).toBe('http://10.10.10.159:8080');
  });

  it('adres, którego Power Automate nie użyje, wraca na stronę z komunikatem', async () => {
    const res = await download('http://10.0.0.5:8080', '/integracje/7');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/integracje/7');
    expect((await get('/integracje')).body).toContain('Adres dla Power Automate musi zaczynać się od https://');
  });

  it.each([['https://evil.example'], ['//evil.example'], ['/klucze'], ['/integracjeX'], ['']])('powrót %j spoza integracji zastępuje /integracje', async (back) => {
    const res = await download('http://10.0.0.5', back);
    expect(res.headers.location).toBe('/integracje');
  });

  it('powtórzone parametry nie wywracają trasy', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/integracje/power-automate/konektor?adres=a&adres=b&wroc=/integracje&wroc=/x', headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(302);
  });

  it('bez sesji odsyła do logowania', async () => {
    const res = await download('https://sms.firma.pl', '/integracje', '');
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

describe('szczegóły integracji', () => {
  it('konfiguracja słowami: usługa, nadpis, odbiorcy z nazwami, limit części, ochrona; bez warunku; panel konektora z powrotem na szczegóły', async () => {
    await create();
    const row = paRow();
    const detail = (await get(`/integracje/${row.id}`)).body;
    for (const t of ['Odbiorcy grupy', 'Marek Kowalski (48601000011)', '48601000012', 'do 3 części, nadmiar: odrzucenie', 'Usługa', 'domyślna klucza',
      'Nadpis nadawcy', 'domyślny klucza', '30 wywołań i 5000 odbiorców na 10 minut', 'Konektor Power Automate', `name="wroc" value="/integracje/${row.id}"`,
      'action="/integracje/power-automate/konektor"']) {
      expect(detail, t).toContain(t);
    }
    expect(detail).not.toContain('Warunek');
    expect(detail).not.toContain('Adres docelowy');
  });

  it('liczba numerów w poprawnej odmianie: 1 numer, 2 numery, 5 numerów, 12 numerów, 22 numery', async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `601${String(i).padStart(6, '0')}`).join('\n');
    for (const [n, word] of [[1, '1 numer:'], [2, '2 numery:'], [5, '5 numerów:'], [12, '12 numerów:'], [22, '22 numery:']] as const) {
      await create({ name: `Lista ${n}`, recipients: lines(n) });
      const row = h.integrations.list().find((r) => r.name === `Lista ${n}`)!;
      expect((await get(`/integracje/${row.id}`)).body, String(n)).toContain(word);
    }
  });

  it('pusta lista mówi, że akcja „Wyślij SMS do grupy” skończy się błędem', async () => {
    await create({ recipients: '', overflow: 'truncate' });
    const detail = (await get(`/integracje/${paRow().id}`)).body;
    expect(detail).toContain('pusta lista: akcja „Wyślij SMS do grupy” kończy się błędem');
    expect(detail).toContain('nadmiar: przycięcie');
  });

  it('dziennik po wywołaniu rozsyłki przez API: odnośnik do rozsyłki, zlecający jako tekst w kolumnie „Nadawca”, bez „Użyj jako próbki”', async () => {
    await create({ storePayloads: '1', tryb: 'zaawansowany' });
    const row = paRow();
    // Integracja na kluczu z prawdziwym skrótem, żeby API przyjęło wywołanie.
    const key = generateApiKey();
    const keyId = h.apiKeys.insert({
      accountId: h.apiKeys.get(apiKeyId)!.accountId, name: 'Przepływy', keyHash: key.hash, keyPrefix: key.prefix, defaultServiceId: '24138',
      defaultOrig: null, maxParts: 5, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
    });
    h.db.prepare('UPDATE integrations SET api_key_id = ? WHERE id = ?').run(keyId, row.id);
    const api = buildApiServer({
      accounts: h.accounts, apiKeys: h.apiKeys, messages: h.messages, events: h.events, jobs: h.jobs, packages: h.packages, inbound: h.inbound,
      clients: {} as never, rateLimiter: new RateLimiter(), ...integrationDeps(h.db, h.masterKey), now: () => NOW,
    });
    const res = await api.inject({
      method: 'POST', url: `/v1/integrations/int_${row.id}/packages`, headers: { authorization: key.key },
      payload: { recipients: [{ to: '48601000001' }, { to: '48601000002' }], defaultText: 'Przegląd floty jutro', requestedBy: '<b>Jan</b>' },
    });
    expect(res.statusCode).toBe(202);
    const pkgId = res.json().id as string;
    const detail = (await get(`/integracje/${row.id}`)).body;
    expect(detail).toContain(`href="/rozsylki/${pkgId}"`);
    expect(detail).toContain('Wyślij rozsyłkę, 2 odbiorców');
    expect(detail).toContain('API · &lt;b&gt;Jan&lt;/b&gt;');
    expect(detail).not.toContain('<b>Jan</b>');
    expect(detail).toMatch(/<th[^>]*>Nadawca<\/th>/);
    expect(detail).not.toContain('Użyj jako próbki');
    expect(detail).toContain('ładunek');
  });
});

describe('funkcje wspólne integracji', () => {
  it('wyłączenie, włączenie, kopia i usunięcie działają dla integracji Power Automate', async () => {
    await create();
    const row = paRow();
    expect((await post(`/integracje/${row.id}/wylacz`, {})).statusCode).toBe(302);
    expect(h.integrations.get(row.id)!.enabled).toBe(0);
    expect((await post(`/integracje/${row.id}/wlacz`, {})).statusCode).toBe(302);
    expect(h.integrations.get(row.id)!.enabled).toBe(1);
    const copy = await post(`/integracje/${row.id}/kopiuj`, {});
    expect(copy.statusCode).toBe(302);
    const copyRow = h.integrations.list().find((r) => r.name === 'Ekipa serwisowa (kopia)')!;
    expect(copyRow).toMatchObject({ kind: 'power_automate', enabled: 0, config: row.config });
    expect((await get(`/integracje/${copyRow.id}/edytuj`)).statusCode).toBe(200);
    expect((await post(`/integracje/${row.id}/usun`, {})).statusCode).toBe(302);
    expect(h.integrations.get(row.id)).toBeUndefined();
  });

  it('przegląd liczy integrację Power Automate z błędem w ostatniej dobie', async () => {
    await create();
    h.integrationEvents.record({ integrationId: paRow().id, at: NOW, result: 'throttled', reason: 'ponad 30 w 10 min', logLimit: 200 });
    expect((await get('/przeglad')).body).toMatch(/Integracje z błędami<\/div>\s*<div class="n fail">1</);
  });
});
