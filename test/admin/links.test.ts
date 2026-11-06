import { beforeEach, describe, expect, it } from 'vitest';
import { problemUrl } from '../../src/docs-links.ts';
import { seedAccount, startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-11-05T10:00:00Z');

let h: AdminHarness;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
});

const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string, payload: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: 'POST', url,
    headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams(payload).toString(),
  });

const FORM = { domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: 'https://firma.pl/', bareLinks: '1' };

/** Domena zapisana przez panel; zwraca jej identyfikator z adresu przekierowania. */
const created = async (form: Record<string, string> = FORM): Promise<number> => {
  const res = await post('/skracacz', form);
  expect(res.statusCode).toBe(303);
  return Number(/^\/skracacz\/(\d+)$/.exec(res.headers.location as string)![1]);
};

/** Klucz z przypisaną domeną skracacza. */
const assigned = (domainId: number): number => {
  const apiKeyId = h.apiKeys.insert({
    accountId: seedAccount(h), name: 'Serwis klimatyzacji', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  h.apiKeys.setLinkSettings(apiKeyId, {
    mode: 'sender', domainIds: [domainId], defaultDomainId: domainId, targets: ['firma.pl'], validityDays: 90, utm: true,
  });
  return apiKeyId;
};

/** Atrapa sieci odpowiadająca jak serwer przekierowań tej bramki: tokenem ważnym dla domeny. */
const redirectServer = () => {
  h.domainNet.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const token = u.pathname.split('/').pop() ?? '';
    const domain = h.linkDomains.byDomain(u.hostname);
    return new Response(domain && h.domainChecks.answer(token, NOW, domain.id) ? token : 'Link wygasł');
  }) as typeof fetch;
};

const actions = () => (h.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'skracacz.%' ORDER BY id").all() as Array<{ action: string }>)
  .map((r) => r.action);

/** Panel używa wyłącznie łącznika i zapisu „na przykład”. */
const plainText = (html: string) => {
  expect(html).not.toMatch(/[\u2013\u2014]/);
  expect(html).not.toMatch(/\bnp\./);
};

describe('Skracacz linków: lista domen', () => {
  it('pozycja „Skracacz linków” w grupie Konfiguracja, po Integracjach', async () => {
    const res = await page('/skracacz');
    expect(res.statusCode).toBe(200);
    const nav = res.body.slice(res.body.indexOf('>Konfiguracja<'));
    expect(nav).toContain('<a href="/skracacz" class="on">Skracacz linków</a>');
    expect(nav.indexOf('Skracacz linków')).toBeGreaterThan(nav.indexOf('>Integracje'));
    expect(nav.indexOf('Skracacz linków')).toBeLessThan(nav.indexOf('Użytkownicy'));
  });

  it('pusta lista zaprasza do dodania domeny', async () => {
    const res = await page('/skracacz');
    expect(res.body).toContain('Dodaj domenę');
    expect(res.body).toContain('href="/skracacz/nowa"');
    plainText(res.body);
  });

  it('wiersz domeny: nazwa, nazwa wyświetlana, stan, sprawdzenie i liczba kluczy', async () => {
    const id = await created();
    const other = await created({ domain: 'firma-link.pl', displayName: 'Firma Serwis', homeUrl: '', bareLinks: '' });
    assigned(id);
    h.linkDomains.setCheck(id, true, null, NOW);
    await post(`/skracacz/${other}/wylacz`);
    const res = await page('/skracacz');
    const row = (domain: string) => res.body.slice(res.body.indexOf(`>${domain}<`), res.body.indexOf('</tr>', res.body.indexOf(`>${domain}<`)));
    expect(row('l.firma.pl')).toContain('Firma Serwis');
    expect(row('l.firma.pl')).toContain('aktywna');
    expect(row('l.firma.pl')).toContain('sprawdzona');
    expect(row('l.firma.pl')).toContain('2026-11-05 11:00');
    expect(row('l.firma.pl')).toContain('1 klucz');
    expect(row('firma-link.pl')).toContain('wyłączona');
    expect(row('firma-link.pl')).toContain('niesprawdzona');
    expect(row('firma-link.pl')).toContain('brak');
    plainText(res.body);
  });

  it('nieudane sprawdzenie ma osobną plakietkę', async () => {
    const id = await created();
    h.linkDomains.setCheck(id, false, 'dns ENOTFOUND', NOW);
    const res = await page('/skracacz');
    expect(res.body).toContain('sprawdzenie nieudane');
  });
});

describe('Skracacz linków: formularz domeny', () => {
  it('formularz nowej domeny: pola ze spec 4.1, podpowiedzi i akapit o rekordach DNS', async () => {
    const res = await page('/skracacz/nowa');
    expect(res.statusCode).toBe(200);
    for (const name of ['domain', 'displayName', 'homeUrl', 'bareLinks']) expect(res.body).toContain(`name="${name}"`);
    expect(res.body).toContain('rekordu A');
    expect(res.body).toContain('CNAME');
    expect(res.body).toContain('https://sqlik.github.io/multiinfo-gate/skracacz/');
    expect(res.body).toContain('action="/skracacz"');
    plainText(res.body);
  });

  it('zapis tworzy domenę niesprawdzoną i prowadzi do jej strony', async () => {
    const id = await created();
    expect(h.linkDomains.get(id)).toMatchObject({ domain: 'l.firma.pl', homeUrl: 'https://firma.pl/', bareLinks: 1, checkedAt: null });
    const res = await page(`/skracacz/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Domena zapisana');
    expect(res.body).toContain('niesprawdzona');
    expect(res.body).toContain(`action="/skracacz/${id}/sprawdz"`);
    expect(actions()).toEqual(['skracacz.domena.utworzenie']);
    plainText(res.body);
  });

  it('błędna domena wraca do formularza z komunikatem i wpisanymi wartościami', async () => {
    const res = await post('/skracacz', { ...FORM, domain: 'https://l.firma.pl/x' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('bez https://');
    expect(res.body).toContain('value="https://l.firma.pl/x"');
    expect(res.body).toContain('value="Firma Serwis"');
    expect(h.linkDomains.list()).toEqual([]);
  });

  it('zmiana zapisuje pola, a błąd zostawia formularz edycji', async () => {
    const id = await created();
    const ok = await post(`/skracacz/${id}`, { ...FORM, displayName: 'Serwis Klimatyzacji', bareLinks: '' });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe(`/skracacz/${id}`);
    expect(h.linkDomains.get(id)).toMatchObject({ displayName: 'Serwis Klimatyzacji', bareLinks: 0 });
    const bad = await post(`/skracacz/${id}`, { ...FORM, displayName: '' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('nazwę wyświetlaną');
    expect(bad.body).toContain(`action="/skracacz/${id}"`);
  });

  it('nieznana domena i zły identyfikator dają 404', async () => {
    expect((await page('/skracacz/999')).statusCode).toBe(404);
    expect((await page('/skracacz/abc')).statusCode).toBe(404);
    expect((await post('/skracacz/999/sprawdz')).statusCode).toBe(404);
    expect((await post('/skracacz/999/usun')).statusCode).toBe(404);
  });
});

describe('Skracacz linków: sprawdzenie domeny', () => {
  it('udane sprawdzenie zmienia plakietkę na „sprawdzona” z datą', async () => {
    const id = await created();
    redirectServer();
    const res = await post(`/skracacz/${id}/sprawdz`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/skracacz/${id}`);
    const detail = await page(`/skracacz/${id}`);
    expect(detail.body).toContain('Domena odpowiada');
    expect(detail.body).toContain('sprawdzona');
    expect(detail.body).toContain('2026-11-05 11:00');
    expect(actions()).toEqual(['skracacz.domena.utworzenie', 'skracacz.domena.sprawdzenie']);
  });

  it('sprawdzenie z listy wraca na listę', async () => {
    const id = await created();
    redirectServer();
    const res = await post(`/skracacz/${id}/sprawdz`, { back: 'lista' });
    expect(res.headers.location).toBe('/skracacz');
  });

  it('nieudane połączenie: krok, możliwa pętla zwrotna NAT i odesłanie do rozwiązywania problemów', async () => {
    const id = await created();
    h.domainNet.fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    }) as typeof fetch;
    await post(`/skracacz/${id}/sprawdz`);
    const detail = await page(`/skracacz/${id}`);
    expect(detail.body).toContain('sprawdzenie nieudane');
    expect(detail.body).toContain('pętli zwrotnej NAT');
    expect(detail.body).toContain('ECONNREFUSED');
    expect(detail.body).toContain('Krok sprawdzenia: połączenie');
    expect(detail.body).toContain('https://sqlik.github.io/multiinfo-gate/problemy/#skracacz-sprawdzenie-domeny');
    plainText(detail.body);
  });

  it('adres w sieci wewnętrznej: bramka nie łączy się z nim i wyjaśnia dlaczego', async () => {
    const id = await created();
    h.resolve.value = async () => ['192.168.1.20'];
    await post(`/skracacz/${id}/sprawdz`);
    const detail = await page(`/skracacz/${id}`);
    expect(detail.body).toContain('adres w sieci wewnętrznej 192.168.1.20');
    expect(detail.body).toContain('Krok sprawdzenia: rozwiązanie nazwy');
    expect(detail.body).toContain('albo ustaw zmienną MIG_LINKS_ALLOW_PRIVATE=1 w środowisku bramki');
    plainText(detail.body);
  });

  it('serwer pośredniczący bez zaufania: ostrzeżenie w komunikacie, na liście i na stronie domeny z wartością zmiennej', async () => {
    const id = await created();
    const viaProxy = (proxy: string) => {
      h.domainNet.fetch = (async (input: string | URL | Request) => {
        const u = new URL(String(input));
        const token = u.pathname.split('/').pop() ?? '';
        const domain = h.linkDomains.byDomain(u.hostname);
        return new Response(domain && h.domainChecks.answer(token, NOW, domain.id, proxy) ? token : 'Link wygasł');
      }) as typeof fetch;
    };
    viaProxy('172.18.0.3');
    const res = await post(`/skracacz/${id}/sprawdz`, { back: 'lista' });
    expect(res.headers.location).toBe('/skracacz');
    const list = await page('/skracacz');
    expect(list.body).toContain('Domena odpowiada, ale bramka nie ufa serwerowi pośredniczącemu 172.18.0.3. Szczegóły zawiera strona domeny');
    expect(list.body).toContain('flash-warn');
    expect(list.body).toContain('sprawdzona z ostrzeżeniem');
    const detail = await page(`/skracacz/${id}`);
    expect(detail.body).toContain('Linki tej domeny działają, ale kliknięcia przychodzą przez serwer pośredniczący 172.18.0.3, któremu bramka nie ufa.');
    expect(detail.body).toContain('limit 60 wejść na minutę obejmuje wtedy wszystkich odbiorców kampanii razem');
    expect(detail.body).toContain('Ustaw w środowisku bramki zmienną MIG_TRUSTED_PROXIES=172.16.0.0/12');
    expect(detail.body).toContain(`href="${problemUrl('skracacz-sprawdzenie-domeny')}"`);
    plainText(detail.body);

    viaProxy('192.0.2.10');
    await post(`/skracacz/${id}/sprawdz`);
    expect((await page(`/skracacz/${id}`)).body).toContain('zmienną MIG_TRUSTED_PROXIES=192.0.2.10');

    redirectServer();
    await post(`/skracacz/${id}/sprawdz`);
    const fixed = await page(`/skracacz/${id}`);
    expect(fixed.body).not.toContain('MIG_TRUSTED_PROXIES');
    expect(fixed.body).toContain('Linki tej domeny trafiają do tej bramki');
  });

  it('MIG_LINKS_ALLOW_PRIVATE=1: sprawdzenie łączy się z adresem w sieci wewnętrznej', async () => {
    h = await startAdminHarness(NOW, { allowPrivateLinks: true });
    const id = await created();
    h.resolve.value = async () => ['192.168.1.20'];
    redirectServer();
    await post(`/skracacz/${id}/sprawdz`);
    const detail = await page(`/skracacz/${id}`);
    expect(detail.body).toContain('Domena odpowiada');
    expect(detail.body).not.toContain('adres w sieci wewnętrznej');
  });

  it.each([
    ['dns ENOTFOUND', 'rekord A albo CNAME'],
    ['tls CERT_HAS_EXPIRED', 'Certyfikat'],
    ['response HTTP 404', 'HTTP 404'],
    ['response token', 'inny serwer'],
  ])('wynik %s ma opis kroku', async (stored, text) => {
    const id = await created();
    h.linkDomains.setCheck(id, false, stored, NOW);
    const detail = await page(`/skracacz/${id}`);
    expect(detail.body).toContain(text);
    expect(detail.body).not.toContain('pętli zwrotnej NAT');
    plainText(detail.body);
  });
});

describe('Skracacz linków: stan i usunięcie', () => {
  it('wyłączenie i włączenie domeny', async () => {
    const id = await created();
    expect((await post(`/skracacz/${id}/wylacz`)).headers.location).toBe(`/skracacz/${id}`);
    expect(h.linkDomains.get(id)!.enabled).toBe(0);
    expect((await page(`/skracacz/${id}`)).body).toContain(`action="/skracacz/${id}/wlacz"`);
    await post(`/skracacz/${id}/wlacz`);
    expect(h.linkDomains.get(id)!.enabled).toBe(1);
    expect(actions()).toEqual(['skracacz.domena.utworzenie', 'skracacz.domena.wylaczenie', 'skracacz.domena.wlaczenie']);
  });

  it('usunięcie domeny przypisanej do klucza zostaje odrzucone z komunikatem', async () => {
    const id = await created();
    assigned(id);
    const res = await post(`/skracacz/${id}/usun`);
    expect(res.headers.location).toBe(`/skracacz/${id}`);
    expect(h.linkDomains.get(id)).toBeDefined();
    const detail = await page(`/skracacz/${id}`);
    expect(detail.body).toContain('przypisana do klucza Serwis klimatyzacji');
    expect(detail.body).toContain('Serwis klimatyzacji');
  });

  it('usunięcie domeny wolnej wraca na listę', async () => {
    const id = await created();
    const res = await post(`/skracacz/${id}/usun`);
    expect(res.headers.location).toBe('/skracacz');
    expect(h.linkDomains.get(id)).toBeUndefined();
    expect((await page('/skracacz')).body).toContain('Domena usunięta');
  });
});

describe('Skracacz linków: ochrona formularzy', () => {
  it('żądanie z innej witryny zostaje odrzucone, zanim cokolwiek zapisze', async () => {
    const res = await post('/skracacz', FORM, { 'sec-fetch-site': 'cross-site' });
    expect(res.statusCode).toBe(403);
    expect(h.linkDomains.list()).toEqual([]);
    const id = await created();
    expect((await post(`/skracacz/${id}/usun`, {}, { 'sec-fetch-site': 'same-site' })).statusCode).toBe(403);
    expect(h.linkDomains.get(id)).toBeDefined();
  });

  it('bez sesji panel kieruje do logowania', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/skracacz', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/zaloguj');
  });
});
