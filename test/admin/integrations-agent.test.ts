import { beforeEach, describe, expect, it } from 'vitest';
import { AGENTS_DOCS_URL } from '../../src/docs-links.ts';
import type { AgentConfig } from '../../src/integrations/config.ts';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-11-15T10:00:00Z');
let h: AdminHarness;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  const accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Dyspozytornia', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  h.settings.setApiUrl('https://sms.firma.pl', NOW);
});

const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string, fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
  return h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: params.toString() });
};
const formBody = (over: Record<string, string | string[]> = {}): Record<string, string | string[]> => ({
  name: 'Agent AI - dyspozytornia', apiKeyId: String(apiKeyId), serviceId: '', orig: '', enabled: '1', scopes: ['send', 'read_sent'],
  maxParts: '3', overflow: 'reject', throttleLimit: '30', throttleWindow: '60', throttleRecipients: '1000', eventLogLimit: '200', tryb: 'prosty', ...over,
});
const create = (over: Record<string, string | string[]> = {}) => post('/integracje', { kind: 'agent', preset: 'agent-ai', ...formBody(over) });
const agentRows = () => h.integrations.list().filter((r) => r.kind === 'agent');
const agentRow = () => agentRows()[0]!;
const scopesOf = (id: number) => (h.integrations.get(id)!.config as AgentConfig).scopes;
const NEW_FORM = '/integracje/nowa?rodzaj=agent&ustawienie=agent-ai';
const WARNING = 'Wysyłka SMS-ów razem z odczytem odebranych wymaga rozwagi.';

/** Połączenie z tokenem, czyli aktywne bez użycia kodu. */
function activeConnection(integrationId: number, name: string): number {
  const id = h.agentConnections.insert({ integrationId, name, method: 'token', expiresAt: null, createdBy: 'janek', createdAt: NOW });
  h.agentConnections.setToken(id, `skrot-${name}`);
  return id;
}

describe('katalog i formularz', () => {
  it('kafelek Agent AI w katalogu do SMS prowadzi do formularza', async () => {
    const catalog = (await get('/integracje/nowa?rodzaj=webhook_in')).body;
    const tile = 'href="/integracje/nowa?rodzaj=agent&amp;ustawienie=agent-ai"';
    expect(catalog).toContain(tile);
    expect(catalog).toContain('Wysyłka SMS-ów, przebieg doręczenia i wyniki kampanii w rozmowie z aplikacją AI');
    expect(catalog.indexOf(tile)).toBeGreaterThan(catalog.indexOf('ustawienie=power-automate'));
    expect(catalog.indexOf(tile)).toBeLessThan(catalog.indexOf('ustawienie=uptime-kuma'));

    const bare = await get('/integracje/nowa?rodzaj=agent');
    expect(bare.statusCode).toBe(302);
    expect(bare.headers.location).toBe(NEW_FORM);

    const res = await get(NEW_FORM);
    expect(res.statusCode).toBe(200);
    for (const t of ['Jak działa Agent AI', 'Podstawy', 'Zakresy', 'Wysyłka SMS-ów', 'Wysyłka do grup', 'Odczyt wysłanych', 'Wyniki kampanii',
      'Odczyt odebranych', 'Odpowiedź nadawcy', 'Narzędzie „Co mogę?” działa w każdym połączeniu', 'Treść', 'Limit części', 'skróć i wyślij',
      'nie wysyłaj, poproś agenta o krótszą treść', 'name="kind" value="agent"', 'Utwórz integrację', AGENTS_DOCS_URL,
      'Podstawy, zakresy i limit części. Tryb zaawansowany udostępnia ochronę przed burzą, dziennik i ładunki.']) {
      expect(res.body, t).toContain(t);
    }
    expect(res.body).toContain('name="scopes" value="send" checked');
    expect(res.body).toContain('name="scopes" value="read_sent" checked');
    expect(res.body).toContain('name="scopes" value="read_inbound">');
    for (const t of ['Ochrona i dziennik', 'Odbiorcy grupy', 'Kiedy wysyłać', 'Konektor Power Automate']) expect(res.body, t).not.toContain(t);
    expect(res.body).toContain('name="throttleRecipients" value="1000"');
  });

  it('tryb zaawansowany dokłada ochronę i dziennik z limitem odbiorców do 50 000', async () => {
    const form = (await get(`${NEW_FORM}&tryb=zaawansowany`)).body;
    for (const t of ['Ochrona i dziennik', 'Limit burzy', 'wysyłek na', 'Limit odbiorców', 'Wpisów w dzienniku', 'Przechowuj ładunki w dzienniku']) {
      expect(form, t).toContain(t);
    }
    expect(form).toContain('name="throttleWindow" type="number" min="1" max="1440" value="60"');
    expect(form).toContain('name="throttleRecipients" type="number" min="1" max="50000" value="1000"');
  });

  it('ostrzeżenie przy wysyłce z odczytem odebranych i informacje przy odpowiedzi czekają w formularzu na zaznaczenie', async () => {
    const form = (await get(NEW_FORM)).body;
    expect(form).toMatch(new RegExp(`data-scopes="send,read_inbound"[^>]*>${WARNING}`));
    expect(form).toContain('data-scopes="reply,!read_inbound"');
    expect(form).toContain('data-scopes="reply,read_inbound"');
    const script = (await h.app.inject({ method: 'GET', url: '/panel.js' })).body;
    expect(script).toContain('data-scopes');
  });

  it('podpowiedzi usługi i nadpisu mówią o wyborze agenta, a nazwa o stronie połączenia', async () => {
    const form = (await get(NEW_FORM)).body;
    expect(form).toContain('Agent może wybrać inną usługę tego klucza, a podgląd wysyłki ją pokazuje.');
    expect(form).toContain('Agent może wybrać inny nadpis tego klucza, a podgląd wysyłki go pokazuje.');
    expect(form).toContain('Pod tą nazwą integracja pojawia się na stronie połączenia aplikacji');
  });

  it('podpowiedź wysyłki obiecuje anulowanie tylko przed przekazaniem do sieci operatora', async () => {
    const form = (await get(NEW_FORM)).body;
    expect(form).toContain('Może też anulować wiadomość wysłaną przez tę integrację, której Multiinfo nie przekazało jeszcze do sieci operatora.');
    expect(form).not.toContain('abonentowi');
  });
});

describe('zapis', () => {
  it('tworzy integrację agenta z zakresami, audytem i przejściem na szczegóły', async () => {
    const res = await create();
    expect(res.statusCode).toBe(302);
    const row = agentRow();
    expect(res.headers.location).toBe(`/integracje/${row.id}`);
    expect(row).toMatchObject({ name: 'Agent AI - dyspozytornia', preset: 'agent-ai', enabled: 1, apiKeyId, hookId: null });
    expect(row.config).toEqual({ scopes: ['send', 'read_sent'], throttle: { limit: 30, windowMinutes: 60, recipients: 1000 }, eventLogLimit: 200, maxParts: 3, overflow: 'reject' });
    expect(h.audit.list(5, 0).map((a) => a.action)).toEqual(['integracja.utworzenie']);
    expect((await get(`/integracje/${row.id}`)).body).toContain('Integracja Agent AI - dyspozytornia utworzona.');
  });

  it('zapis z send i read_inbound zapisuje agent.zakresy_ostrzezenie', async () => {
    await create({ scopes: ['send', 'read_inbound'] });
    const row = agentRow();
    expect(scopesOf(row.id)).toEqual(['send', 'read_inbound']);
    expect(h.audit.list(5, 0)[0]).toMatchObject({
      action: 'agent.zakresy_ostrzezenie', target: `integracja:${row.id}`,
      meta: { nazwa: 'Agent AI - dyspozytornia', zakresy: ['send', 'read_inbound'] },
    });

    // Ponowny zapis bez zmiany zakresów nie powtarza wpisu, dołożenie odczytu do wysyłki w edycji go zapisuje.
    await post(`/integracje/${row.id}/edytuj`, formBody({ name: 'Agent AI - obsługa', scopes: ['send', 'read_inbound'] }));
    expect(h.audit.list(5, 0).filter((a) => a.action === 'agent.zakresy_ostrzezenie')).toHaveLength(1);
    await post(`/integracje/${row.id}/edytuj`, formBody({ scopes: ['send'] }));
    await post(`/integracje/${row.id}/edytuj`, formBody({ scopes: ['send', 'read_sent', 'read_inbound'] }));
    expect(h.audit.list(10, 0).filter((a) => a.action === 'agent.zakresy_ostrzezenie')).toHaveLength(2);
  });

  it('wysyłka do grup albo odpowiedź z odczytem odebranych nie zapisuje ostrzeżenia', async () => {
    await create({ scopes: ['send_group', 'read_inbound', 'reply'] });
    expect(h.audit.list(5, 0).map((a) => a.action)).toEqual(['integracja.utworzenie']);
  });

  it('zapis reply bez read_inbound dokłada read_inbound i pokazuje informację', async () => {
    const res = await create({ scopes: ['read_sent', 'reply'] });
    expect(res.statusCode).toBe(302);
    const row = agentRow();
    expect(scopesOf(row.id)).toEqual(['read_sent', 'read_inbound', 'reply']);
    const detail = (await get(`/integracje/${row.id}`)).body;
    expect(detail).toContain('Integracja Agent AI - dyspozytornia utworzona. Zakres „Odpowiedź nadawcy” wymaga odczytu odebranych, dlatego zapis zaznaczył także „Odczyt odebranych”.');
  });

  it('zapis bez zakresów: błąd „Zakresy: zaznacz co najmniej jeden zakres”', async () => {
    const res = await create({ scopes: [] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Zakresy: zaznacz co najmniej jeden zakres.');
    expect(agentRows()).toHaveLength(0);
    // Nieznany zakres nie liczy się jako zaznaczony.
    expect((await create({ scopes: ['admin'] })).statusCode).toBe(400);
  });

  it('limit odbiorców 50 001: błąd z zakresem 1-50000', async () => {
    const res = await create({ throttleRecipients: '50001', tryb: 'zaawansowany' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Limit odbiorców: podaj liczbę od 1 do 50\u00a0000.');
    expect(res.body).toContain('Ochrona i dziennik');
    expect((await create({ throttleRecipients: '50000', tryb: 'zaawansowany' })).statusCode).toBe(302);
  });

  it('limit części spoza 1-9 i zła nazwa dają 400 bez zapisu', async () => {
    expect((await create({ maxParts: '10' })).body).toContain('Limit części: podaj liczbę od 1 do 9.');
    expect((await create({ name: '' })).statusCode).toBe(400);
    expect(agentRows()).toHaveLength(0);
  });
});

describe('edycja', () => {
  it('tryb prosty zachowuje ochronę ustawioną w zaawansowanym', async () => {
    await create({ throttleLimit: '60', throttleRecipients: '5000', storePayloads: '1', tryb: 'zaawansowany' });
    const row = agentRow();
    const form = (await get(`/integracje/${row.id}/edytuj`)).body;
    expect(form).toContain('<input type="hidden" name="throttleLimit" value="60">');
    expect(form).toContain('<input type="hidden" name="throttleRecipients" value="5000">');
    expect(form).toContain('Ochrona przed burzą: najwyżej 60 wysyłek i 5000 odbiorców w ciągu 60 minut. Wartości zmienia tryb zaawansowany.');
    expect(form).toContain('Klucz jest przypisany na stałe.');
    expect(form).toContain('name="scopes" value="send" checked');

    const res = await post(`/integracje/${row.id}/edytuj`, formBody({ throttleLimit: '60', throttleRecipients: '5000', storePayloads: '1', scopes: ['read_sent'] }));
    expect(res.statusCode).toBe(302);
    const after = h.integrations.get(row.id)!;
    expect(after.config).toMatchObject({ scopes: ['read_sent'], throttle: { limit: 60, windowMinutes: 60, recipients: 5000 } });
    expect(after.storePayloads).toBe(1);
    expect(h.audit.list(5, 0)[0]).toMatchObject({ action: 'integracja.edycja', meta: expect.objectContaining({ pola: ['scopes'] }) });
  });

  it('tryb prosty z domyślną ochroną nie pokazuje zdania o ochronie', async () => {
    await create();
    expect((await get(`/integracje/${agentRow().id}/edytuj`)).body).not.toContain('Ochrona przed burzą: najwyżej');
  });
});

describe('adres bramki', () => {
  it('adres bramki http://: ostrzeżenie w formularzu i szczegółach', async () => {
    await create();
    const row = agentRow();
    h.settings.setApiUrl('http://10.10.10.159:8080', NOW);
    const sentence = 'Aplikacje z logowaniem, na przykład claude.ai i ChatGPT, nie połączą się z bramką.';
    for (const url of [NEW_FORM, `/integracje/${row.id}/edytuj`, `/integracje/${row.id}`]) {
      const body = (await get(url)).body;
      expect(body, url).toContain('nie zaczyna się od <code>https://</code>');
      expect(body, url).toContain(sentence);
      expect(body, url).toContain('href="#adres-bramki"');
      expect(body, url).toContain('id="adres-bramki"');
      expect(body, url).toContain('action="/adres-bramki"');
    }

    h.settings.setApiUrl(null, NOW);
    const empty = (await get(NEW_FORM)).body;
    expect(empty).toContain('Panel nie zna adresu bramki.');
    expect(empty).toContain('id="adres-bramki"');

    h.settings.setApiUrl('https://sms.firma.pl', NOW);
    for (const url of [NEW_FORM, `/integracje/${row.id}`]) {
      const body = (await get(url)).body;
      expect(body, url).not.toContain(sentence);
      expect(body, url).not.toContain('id="adres-bramki"');
    }
  });
});

describe('szczegóły, lista i kopia', () => {
  it('szczegóły: zakresy słowami, treść, limit burzy z odbiorcami, kolumna „Nadawca” bez próbki', async () => {
    await create({ scopes: ['send_group', 'read_sent', 'read_inbound', 'reply'], maxParts: '2' });
    const row = agentRow();
    h.integrationEvents.record({ integrationId: row.id, at: NOW, result: 'sent', sourceIp: 'MCP · Ewa Nowak', reason: 'Wyślij SMS, 1 odbiorca', payload: '{"to":["48601000011"]}', logLimit: 200 });
    const body = (await get(`/integracje/${row.id}`)).body;
    expect(body).toContain('Wysyłka do grup, Odczyt wysłanych, Odczyt odebranych, Odpowiedź nadawcy');
    expect(body).toContain('do 2 części, nadmiar: odrzucenie');
    expect(body).toContain('30 wysyłek i 1000 odbiorców na 60 minut');
    expect(body).toContain('>Nadawca</th>');
    expect(body).toContain('MCP · Ewa Nowak');
    expect(body).not.toContain('Użyj jako próbki');
  });

  it('potwierdzenie usunięcia integracji agenta mówi o połączeniach pracowników', async () => {
    await create();
    const body = (await get(`/integracje/${agentRow().id}`)).body;
    expect(body).toContain('data-confirm="Usunąć integrację „Agent AI - dyspozytornia”? Dziennik i wszystkie połączenia pracowników zostaną usunięte razem z nią, a aplikacje AI utracą dostęp do bramki."');
    expect(body).not.toContain('adres wejściowy przestanie działać');
  });

  it('pusty dziennik mówi o wysyłkach agenta', async () => {
    await create();
    const body = (await get(`/integracje/${agentRow().id}`)).body;
    expect(body).toContain('Dziennik jest pusty. Agent nie wykonał jeszcze żadnej wysyłki.');
    // Dwa zdania w nagłówku dziennika kończą się kropką jak każda wielozdaniowa podpowiedź panelu.
    expect(body).toContain('Ładunki nieprzechowywane. Przechowywanie można włączyć w edycji na czas konfiguracji.</div>');
  });

  it('lista: plakietka z liczbą aktywnych połączeń', async () => {
    await create();
    await create({ name: 'Agent AI - marketing' });
    const [first, second] = agentRows();
    activeConnection(first!.id, 'Ewa Nowak');
    activeConnection(first!.id, 'Marek Kowalski');
    // Połączenie czekające na kod nie jest aktywne.
    const waiting = h.agentConnections.insert({ integrationId: second!.id, name: 'Anna Wiśniewska', method: 'oauth', expiresAt: null, createdBy: 'janek', createdAt: NOW });
    h.agentConnections.setCode(waiting, 'skrot-kodu', new Date(NOW.getTime() + 3_600_000).toISOString());
    const list = (await get('/integracje')).body;
    expect(list).toContain('2 aktywne połączenia');
    expect(list).toContain('0 aktywnych połączeń');
    activeConnection(second!.id, 'Jan Zieliński');
    expect((await get('/integracje')).body).toContain('1 aktywne połączenie');
  });

  it('lista: połączenia wygasłe razem z kluczem nie są aktywne, tak jak w szczegółach', async () => {
    await create();
    const [row] = agentRows();
    activeConnection(row!.id, 'Ewa Nowak');
    expect((await get('/integracje')).body).toContain('1 aktywne połączenie');
    h.db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run('2026-11-01T00:00:00.000Z', row!.apiKeyId);
    expect((await get('/integracje')).body).toContain('0 aktywnych połączeń');
  });

  it('kopia integracji agenta nie ma połączeń', async () => {
    await create({ scopes: ['send_group', 'read_sent'] });
    const row = agentRow();
    activeConnection(row.id, 'Ewa Nowak');
    const res = await post(`/integracje/${row.id}/kopiuj`, {});
    expect(res.statusCode).toBe(302);
    const copy = agentRows().find((r) => r.id !== row.id)!;
    expect(copy).toMatchObject({ name: 'Agent AI - dyspozytornia (kopia)', enabled: 0, kind: 'agent' });
    expect(scopesOf(copy.id)).toEqual(['send_group', 'read_sent']);
    expect(h.agentConnections.listForIntegration(copy.id)).toEqual([]);
    expect(h.agentConnections.listForIntegration(row.id)).toHaveLength(1);
    expect((await get(res.headers.location as string)).body).toContain('Kopia utworzona jako wyłączona, bez połączeń. Po uzupełnieniu ustawień należy ją włączyć i dodać połączenia.');
  });

  it('filtr Do SMS obejmuje integracje agenta', async () => {
    await create();
    expect((await get('/integracje?rodzaj=in')).body).toContain('Agent AI - dyspozytornia');
    expect((await get('/integracje?rodzaj=out')).body).not.toContain('Agent AI - dyspozytornia');
  });
});
