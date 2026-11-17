import { beforeEach, describe, expect, it } from 'vitest';
import { defaultAgentConfig, defaultPowerAutomateConfig } from '../../src/integrations/config.ts';
import { FileSendsRepo } from '../../src/store/file-sends.ts';
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

describe('rozsyłka przez agenta AI', () => {
  it('lista i szczegół pokazują źródło z połączeniem, szczegół wiersz „Połączenie”', async () => {
    const agentId = h.integrations.insert({
      name: 'Agent AI - marketing', kind: 'agent', apiKeyId, serviceId: null, orig: null, preset: 'agent-ai', enabled: 1,
      config: defaultAgentConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    const connectionId = h.agentConnections.insert({ integrationId: agentId, name: 'Ewa Nowak', method: 'token', expiresAt: null, createdBy: 'janek', createdAt: NOW });
    h.packages.insert({
      id: 'pkg_agent', apiKeyId, accountId, serviceId: '24138', defaultText: 'Przegląd klimatyzacji', orig: null,
      costCenter: null, startAt: null, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: NOW.toISOString(),
      integrationId: agentId, requestedBy: 'Ewa Nowak', agentConnectionId: connectionId,
    }, [{ dest: '48601000011', text: null, clientId: null }]);
    const list = (await page('/rozsylki')).body;
    expect(list).toContain(`<a href="/integracje/${agentId}">agent Agent AI - marketing · Ewa Nowak</a>`);
    const detail = (await page('/rozsylki/pkg_agent')).body;
    expect(detail).toContain('<div>Źródło</div><div>agent Agent AI - marketing · Ewa Nowak</div>');
    expect(detail).toContain(`<div>Połączenie</div><div>Ewa Nowak · <a href="/integracje/${agentId}">Agent AI - marketing</a></div>`);
    expect(detail).not.toContain('>Zlecający<');
  });

  it('panel: źródło z dopiskiem plik, wiersz Plik z nazwą w szczegółach rozsyłki', async () => {
    const agentId = h.integrations.insert({
      name: 'Agent AI - biuro handlowe', kind: 'agent', apiKeyId, serviceId: null, orig: null, preset: 'agent-ai', enabled: 1,
      config: defaultAgentConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    const connectionId = h.agentConnections.insert({ integrationId: agentId, name: 'Ewa Nowak', method: 'token', expiresAt: null, createdBy: 'janek', createdAt: NOW });
    const fileSendId = new FileSendsRepo(h.db).insert({
      apiKeyId, integrationId: agentId, connectionId, requestedBy: 'Ewa Nowak', name: 'przypomnienia-<b>listopad</b>.xlsx', recipients: 3,
      startAt: null, createdAt: NOW.toISOString(),
    });
    for (const [id, dest] of [['pkg_plik_1', '48601000011'], ['pkg_plik_2', '48601000012']] as const) {
      h.packages.insert({
        id, apiKeyId, accountId, serviceId: '24138', defaultText: null, orig: null, costCenter: null, startAt: null, deliveryReport: 1,
        encoding: 'gsm', multipart: 0, createdAt: NOW.toISOString(), integrationId: agentId, requestedBy: 'Ewa Nowak', agentConnectionId: connectionId, fileSendId,
      }, [{ dest, text: 'Przypominamy o fakturze.', clientId: null, fileLine: 2 }]);
    }
    const list = (await page('/rozsylki')).body;
    expect(list).toContain(`<a href="/integracje/${agentId}">agent Agent AI - biuro handlowe · Ewa Nowak · plik</a>`);
    const detail = (await page('/rozsylki/pkg_plik_1')).body;
    expect(detail).toContain('<div>Źródło</div><div>agent Agent AI - biuro handlowe · Ewa Nowak · plik</div>');
    expect(detail).toContain('<div>Plik</div><div>przypomnienia-&lt;b&gt;listopad&lt;/b&gt;.xlsx · wysyłka z pliku w 2 rozsyłkach</div>');
    expect(detail).not.toContain('<b>listopad</b>');
    // Rozsyłka spoza wysyłki z pliku nie zawiera wiersza „Plik”.
    seed('pkg_api');
    expect((await page('/rozsylki/pkg_api')).body).not.toContain('<div>Plik</div>');
  });
});

describe('GET /rozsylki/:id/raport.csv', () => {
  it('plik z panelu zaczyna się od znacznika BOM, a identyfikator klienta od znaku formuły dostaje apostrof', async () => {
    seed('pkg_1', [
      { dest: '48601135134', text: null, clientId: null },
      { dest: '48501052442', text: 'Indywidualna', clientId: '-faktura-114' },
    ]);
    ready('pkg_1');
    const res = await page('/rozsylki/pkg_1/raport.csv');
    expect(res.statusCode).toBe(200);
    expect(res.body.startsWith('\uFEFFnumer;')).toBe(true);
    expect(res.body).toContain(`48501052442;"'-faktura-114";`);
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

  // Data ważności dotyczy kopii raportu w Multiinfo. CSV i statusy pochodzą z bazy bramki, więc są dostępne także później.
  it('stan gotowego raportu nie pokazuje daty ważności kopii w Multiinfo', async () => {
    seed();
    ready('pkg_1');
    const res = await page('/rozsylki/pkg_1');
    expect(res.body).toContain('gotowy · 2 odbiorców');
    expect(res.body).not.toContain('ważny do');
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
      expect(body, id).toContain('Podsumowanie nie jest dostępne, ponieważ raport powstaje wyłącznie dla zakończonej rozsyłki.');
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

  it('przy wyniku nieznanym -72 odsyła do opisu postępowania', async () => {
    seed();
    h.packages.setFailed('pkg_1', -72, 'Multiinfo nie odpowiedziało w wyznaczonym czasie. Bramka nie ponawia rozsyłki', NOW);
    const res = await page('/rozsylki/pkg_1');
    expect(res.body).toContain('problemy/#rozsylka-bez-potwierdzenia');
    expect(res.body).toContain('Jak ustalić, czy SMS-y zostały wysłane');
  });

  it('przy innym błędzie nie odsyła do opisu wyniku nieznanego', async () => {
    seed();
    h.packages.setFailed('pkg_1', -63, 'Zbyt wielu odbiorców', NOW);
    expect((await page('/rozsylki/pkg_1')).body).not.toContain('rozsylka-bez-potwierdzenia');
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

describe('rozsyłka z integracji z Power Automate', () => {
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
    expect(lines[0]).toBe('\uFEFFnumer;identyfikator_klienta;id_multiinfo;status;status_multiinfo;czas');
    expect(lines[1]).toBe('48601135134;;9001;delivered;21;2026-08-25 12:00:00');
    expect(lines[2]).toBe('48501052442;faktura-114;9002;failed;11;2026-08-25 12:00:01');
  });

  it('odmawia, gdy raport nie jest gotowy', async () => {
    seed();
    expect((await page('/rozsylki/pkg_1/raport.csv')).statusCode).toBe(409);
    expect((await page('/rozsylki/pkg_nie_ma/raport.csv')).statusCode).toBe(404);
  });
});

describe('rozsyłka z terminem przechowywana przez bramkę', () => {
  const HOUR = 3600_000;
  const post = (url: string) => h.app.inject({
    method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: '',
  });
  const jobs = () => (h.db.prepare("SELECT payload FROM jobs WHERE type = 'package.create' ORDER BY id").all() as Array<{ payload: string }>)
    .map((j) => JSON.parse(j.payload) as Record<string, unknown>);

  /** `scheduled` z terminem 16:00 w Polsce, `overdue` z terminem 10:00 w Polsce, obie po dwóch odbiorców. */
  function seedPending(id: string, status: 'scheduled' | 'overdue', integrationId: number | null = null) {
    const startAt = new Date(NOW.getTime() + (status === 'scheduled' ? 4 : -2) * HOUR).toISOString();
    h.packages.insert({
      id, apiKeyId, accountId, serviceId: '24138', defaultText: 'Przegląd klimatyzacji w czwartek o 9:00', orig: null,
      costCenter: null, startAt, deliveryReport: 1, encoding: 'gsm', multipart: 0,
      createdAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(), status, integrationId,
    }, [{ dest: '48601000011', text: null, clientId: null }, { dest: '48601000012', text: null, clientId: null }]);
    return id;
  }
  /** Cały wiersz listy z odnośnikiem do rozsyłki. */
  const rowOf = (body: string, id: string) => body.slice(body.lastIndexOf('<tr>', body.indexOf(`href="/rozsylki/${id}"`))).split('</tr>')[0]!;

  it('lista: etykiety zaplanowana i termin minął, kolumna terminu w czasie polskim', async () => {
    seedPending('pkg_s', 'scheduled');
    seedPending('pkg_o', 'overdue');
    seed('pkg_n');
    const body = (await page('/rozsylki')).body;
    expect(body).toMatch(/<th[^>]*>Termin<\/th>/);
    expect(rowOf(body, 'pkg_s')).toContain('zaplanowana');
    expect(rowOf(body, 'pkg_s')).toContain('2026-08-25 16:00:00');
    expect(rowOf(body, 'pkg_o')).toContain('termin minął');
    expect(rowOf(body, 'pkg_o')).toContain('2026-08-25 10:00:00');
    expect(body).toMatch(/2026-08-25 12:00:00<\/td>\s*<td class="m"><span class="dim">-<\/span><\/td>\s*<td class="m"><a href="\/rozsylki\/pkg_n">/);
  });

  it('filtr stan=overdue pokazuje wyłącznie rozsyłki po terminie', async () => {
    seedPending('pkg_s', 'scheduled');
    seedPending('pkg_o', 'overdue');
    seed('pkg_n');
    const body = (await page('/rozsylki?stan=overdue')).body;
    expect(body).toContain('href="/rozsylki/pkg_o"');
    expect(body).not.toContain('href="/rozsylki/pkg_s"');
    expect(body).not.toContain('href="/rozsylki/pkg_n"');
    expect(body).toContain('<a href="/rozsylki?stan=overdue" class="on">Termin minął</a>');
    expect(body).toContain('<a href="/rozsylki?stan=scheduled">Zaplanowane</a>');
    expect(body).toContain('<a href="/rozsylki">Wszystkie</a>');

    const scheduled = (await page('/rozsylki?stan=scheduled')).body;
    expect(scheduled).toContain('href="/rozsylki/pkg_s"');
    expect(scheduled).not.toContain('href="/rozsylki/pkg_o"');

    // Nieznany stan nie filtruje listy.
    const all = (await page('/rozsylki?stan=queued%27')).body;
    expect(all).toContain('href="/rozsylki/pkg_n"');
    expect(all).toContain('<a href="/rozsylki" class="on">Wszystkie</a>');
  });

  it('stronicowanie zachowuje filtr stanu', async () => {
    for (let i = 0; i < 26; i++) seedPending(`pkg_o${String(i).padStart(2, '0')}`, 'overdue');
    const body = (await page('/rozsylki?stan=overdue')).body;
    expect(body).toContain('href="/rozsylki?stan=overdue&amp;offset=25">Następne</a>');
  });

  it('szczegóły scheduled: termin, chwila przekazania, Anuluj rozsyłkę z potwierdzeniem, bez Wyślij teraz', async () => {
    seedPending('pkg_s', 'scheduled');
    const body = (await page('/rozsylki/pkg_s')).body;
    expect(body).toContain('<div>Termin</div><div class="m">2026-08-25 16:00:00</div>');
    expect(body).toContain('<div>Przekazanie do Multiinfo</div><div class="m">2026-08-25 15:50:00</div>');
    expect(body).toContain('action="/rozsylki/pkg_s/anuluj"');
    expect(body).toContain('data-confirm="Anulować rozsyłkę pkg_s do 2 odbiorców z terminem 25.08.2026 16:00? Bramka nie przekaże jej do Multiinfo, a anulowania nie można cofnąć."');
    expect(body).toContain('data-confirm-ok="Anuluj rozsyłkę" data-confirm-cancel="Wróć"');
    expect(body).toContain('Anulowanie jest możliwe do chwili przekazania rozsyłki do Multiinfo, zwykle 10 minut przed terminem');
    expect(body).not.toContain('wyslij-teraz');
  });

  it('szczegóły overdue: Anuluj rozsyłkę i Wyślij teraz z potwierdzeniami', async () => {
    seedPending('pkg_o', 'overdue');
    const body = (await page('/rozsylki/pkg_o')).body;
    expect(body).toContain('<div>Termin</div><div class="m">2026-08-25 10:00:00</div>');
    expect(body).not.toContain('Przekazanie do Multiinfo</div>');
    expect(body).toContain('data-confirm="Anulować rozsyłkę pkg_o do 2 odbiorców z terminem 25.08.2026 10:00? Bramka nie przekaże jej do Multiinfo, a anulowania nie można cofnąć."');
    expect(body).toContain('action="/rozsylki/pkg_o/wyslij-teraz"');
    expect(body).toContain('data-confirm="Wysłać teraz rozsyłkę pkg_o do 2 odbiorców z terminem 25.08.2026 10:00? Multiinfo rozpocznie wysyłkę natychmiast po przekazaniu."');
    expect(body).toContain('data-confirm-ok="Wyślij teraz"');
    expect(body).toContain('Bramka nie przekazała rozsyłki do Multiinfo w ciągu 60 minut od terminu. Rozsyłka czeka na decyzję administratora.');
  });

  it('rozsyłka bez terminu: wiersz Termin bez terminu i bez przycisków', async () => {
    seed('pkg_n');
    const body = (await page('/rozsylki/pkg_n')).body;
    expect(body).toContain('<div>Termin</div><div class="m">bez terminu</div>');
    expect(body).not.toContain('/anuluj"');
    expect(body).not.toContain('wyslij-teraz');
  });

  it('anulowana przez bramkę: wiersz Powód anulowania zamiast Błąd', async () => {
    seedPending('pkg_s', 'scheduled');
    h.packages.cancelPending('pkg_s', NOW, 'Klucz API został odwołany przed przekazaniem rozsyłki.');
    const body = (await page('/rozsylki/pkg_s')).body;
    expect(body).toContain('Powód anulowania</div>');
    expect(body).toContain('Klucz API został odwołany przed przekazaniem rozsyłki.');
    expect(body).not.toContain('>Błąd</div>');
    expect(body).not.toContain('Przekazanie do Multiinfo</div>');
  });

  it('POST anuluj: stan cancelled, wpis w dzienniku panelu z nazwą administratora, komunikat', async () => {
    seedPending('pkg_s', 'scheduled');
    h.jobs.enqueue('package.create', { packageId: 'pkg_s', scheduled: true }, new Date(NOW.getTime() + 3 * HOUR));
    const res = await post('/rozsylki/pkg_s/anuluj');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/rozsylki/pkg_s');
    expect(h.packages.get('pkg_s')!.status).toBe('cancelled');
    expect(h.packages.get('pkg_s')!.error).toBeNull();
    expect(jobs()).toEqual([]);
    const entry = h.audit.list(10, 0).find((e) => e.action === 'rozsylka.anulowanie');
    expect(entry).toMatchObject({ actor: 'janek', target: 'rozsylka:pkg_s', meta: { stan: 'scheduled', odbiorcy: 2 } });
    expect((await page('/rozsylki/pkg_s')).body).toContain('Rozsyłka pkg_s została anulowana.');
  });

  it('POST anuluj dla rozsyłki przekazanej: ostrzeżenie, stan bez zmian', async () => {
    seed('pkg_n');
    h.packages.setCreated('pkg_n', '14');
    const res = await post('/rozsylki/pkg_n/anuluj');
    expect(res.statusCode).toBe(302);
    expect(h.packages.get('pkg_n')!.status).toBe('open');
    expect(h.audit.list(10, 0).filter((e) => e.action === 'rozsylka.anulowanie')).toEqual([]);
    expect((await page('/rozsylki/pkg_n')).body).toContain('Rozsyłka została już przekazana do Multiinfo, które nie pozwala jej anulować.');
  });

  it('POST wyslij-teraz: stan queued, jedno zadanie package.create bez znacznika scheduled, wpis w dzienniku, liczniki burzy bez zmian', async () => {
    const integrationId = h.integrations.insert({
      name: 'Dyspozytornia', kind: 'power_automate', apiKeyId, serviceId: null, orig: null, preset: 'power-automate',
      enabled: 1, config: defaultPowerAutomateConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    seedPending('pkg_o', 'overdue', integrationId);
    const guardsBefore = h.guards.peek(integrationId, 60, NOW);
    const res = await post('/rozsylki/pkg_o/wyslij-teraz');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/rozsylki/pkg_o');
    expect(h.packages.get('pkg_o')!.status).toBe('queued');
    expect(jobs()).toEqual([{ packageId: 'pkg_o', sendNow: true }]);
    expect(h.guards.peek(integrationId, 60, NOW)).toEqual(guardsBefore);
    const entry = h.audit.list(10, 0).find((e) => e.action === 'rozsylka.wyslanie_teraz');
    expect(entry).toMatchObject({ actor: 'janek', target: 'rozsylka:pkg_o', meta: { odbiorcy: 2 } });
    expect((await page('/rozsylki/pkg_o')).body).toContain('Bramka przekaże rozsyłkę pkg_o do Multiinfo, które rozpocznie wysyłkę natychmiast.');
  });

  it('POST wyslij-teraz przy odwołanym kluczu: bramka anuluje rozsyłkę z powodem zamiast ją wysłać', async () => {
    seedPending('pkg_o', 'overdue');
    h.db.prepare('UPDATE api_keys SET revoked_at = ?').run(NOW.toISOString());
    const res = await post('/rozsylki/pkg_o/wyslij-teraz');
    expect(res.statusCode).toBe(302);
    const reason = 'Klucz API rozsyłki został odwołany przed przekazaniem do Multiinfo';
    expect(h.packages.get('pkg_o')).toMatchObject({ status: 'cancelled', error: reason });
    expect(jobs()).toEqual([]);
    expect(h.audit.list(10, 0).find((e) => e.action === 'rozsylka.anulowanie')).toMatchObject({ actor: 'janek', meta: { powod: reason } });
    expect(h.audit.list(10, 0).filter((e) => e.action === 'rozsylka.wyslanie_teraz')).toEqual([]);
    expect((await page('/rozsylki/pkg_o')).body).toContain(`Bramka anulowała rozsyłkę pkg_o zamiast ją wysłać. ${reason}.`);
  });

  it('POST wyslij-teraz przy wyłączonej integracji zlecającej: ostrzeżenie, stan bez zmian', async () => {
    const integrationId = h.integrations.insert({
      name: 'Dyspozytornia', kind: 'power_automate', apiKeyId, serviceId: null, orig: null, preset: 'power-automate',
      enabled: 0, config: defaultPowerAutomateConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    seedPending('pkg_o', 'overdue', integrationId);
    await post('/rozsylki/pkg_o/wyslij-teraz');
    expect(h.packages.get('pkg_o')!.status).toBe('overdue');
    expect(jobs()).toEqual([]);
    expect((await page('/rozsylki/pkg_o')).body)
      .toContain('Integracja Dyspozytornia, która zleciła rozsyłkę, jest wyłączona. Należy ją włączyć albo anulować rozsyłkę.');
  });

  it('POST wyslij-teraz przy koncie wstrzymanym: ostrzeżenie, stan overdue bez zmian, bez zadania przekazania', async () => {
    seedPending('pkg_o', 'overdue');
    h.accounts.pause(accountId, 'Multiinfo odrzuciło certyfikat bramki (-85).');
    const res = await post('/rozsylki/pkg_o/wyslij-teraz');
    expect(res.statusCode).toBe(302);
    expect(h.packages.get('pkg_o')!.status).toBe('overdue');
    expect(jobs()).toEqual([]);
    expect(h.audit.list(10, 0).filter((e) => e.action === 'rozsylka.wyslanie_teraz')).toEqual([]);
    expect((await page('/rozsylki/pkg_o')).body)
      .toContain('Konto Multiinfo Firma Info, z którego bramka wysyła rozsyłkę, jest wstrzymane. Należy je wznowić albo anulować rozsyłkę.');
  });

  it('POST wyslij-teraz przy koncie wyłączonym: ostrzeżenie, stan overdue bez zmian, bez zadania przekazania', async () => {
    seedPending('pkg_o', 'overdue');
    h.db.prepare('UPDATE accounts SET active = 0').run();
    await post('/rozsylki/pkg_o/wyslij-teraz');
    expect(h.packages.get('pkg_o')!.status).toBe('overdue');
    expect(jobs()).toEqual([]);
    expect((await page('/rozsylki/pkg_o')).body)
      .toContain('Konto Multiinfo Firma Info, z którego bramka wysyła rozsyłkę, jest wyłączone. Należy je włączyć albo anulować rozsyłkę.');
  });

  it('POST wyslij-teraz dla scheduled: ostrzeżenie, stan bez zmian', async () => {
    seedPending('pkg_s', 'scheduled');
    const res = await post('/rozsylki/pkg_s/wyslij-teraz');
    expect(res.statusCode).toBe(302);
    expect(h.packages.get('pkg_s')!.status).toBe('scheduled');
    expect(jobs()).toEqual([]);
    expect(h.audit.list(10, 0).filter((e) => e.action === 'rozsylka.wyslanie_teraz')).toEqual([]);
    expect((await page('/rozsylki/pkg_s')).body).toContain('Przycisk „Wyślij teraz” dotyczy wyłącznie rozsyłki, której termin minął o więcej niż 60 minut.');
  });

  it('POST dla nieznanej rozsyłki: 404', async () => {
    expect((await post('/rozsylki/pkg_nie_ma/anuluj')).statusCode).toBe(404);
    expect((await post('/rozsylki/pkg_nie_ma/wyslij-teraz')).statusCode).toBe(404);
  });

  it('okno potwierdzenia przyjmuje własny napis przycisku rezygnacji', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/panel.js' });
    expect(res.body).toContain("form.getAttribute('data-confirm-cancel') || 'Anuluj'");
  });
});
