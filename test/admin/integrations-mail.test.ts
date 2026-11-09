import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';
import { M365_IMAP } from '../../src/m365/oauth.ts';

const NOW = new Date('2026-10-21T10:00:00Z');
let h: AdminHarness;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  const accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Monitoring NOC', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
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
  name: 'Alarmy z UPS-a', apiKeyId: String(apiKeyId), serviceId: '', orig: '', enabled: '1',
  host: 'imap.przyklad.test', port: '993', security: 'tls', verifyCert: 'on', user: 'u', password: 'TajneHaslo9', folder: 'INBOX', intervalSec: '60',
  senders: '@przyklad.test', toFallback: '48601000009', textMode: 'simple', textVariant: 'subject_text', maxParts: '1', overflow: 'truncate',
  afterAction: 'keep', afterFolder: '', throttleLimit: '10', throttleWindow: '10', eventLogLimit: '200', conditionMode: 'builder', tryb: 'prosty',
  cutFrom: '', recipientsWhere: 'subject', ...over,
});

describe('formularz skrzynki', () => {
  it('kafelek „Z poczty” prowadzi do wyboru ustawienia poczty, a ten do formularza skrzynki w trybie prostym', async () => {
    expect((await get('/integracje/nowa')).body).toContain('rodzaj=mail_in');
    const choose = await get('/integracje/nowa?rodzaj=mail_in');
    expect(choose.body).toContain('Własny serwer');
    expect(choose.body).toContain('Gdzie znajduje się skrzynka?');
    const form = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-wlasny')).body;
    expect(form).toContain('Serwer IMAP');
    expect(form).toContain('Kto może wysyłać');
    expect(form).toContain('Sprawdź połączenie');
    expect(form).not.toContain('Szablon Liquid');
    expect(form).not.toContain('Sprawdzaj certyfikat');
    const advanced = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-wlasny&tryb=zaawansowany')).body;
    expect(advanced).toContain('Szablon Liquid');
    expect(advanced).toContain('Sprawdzaj certyfikat');
  });

  it('zapis tworzy integrację mail_in z zaszyfrowanym hasłem, stanem skrzynki i progiem od teraz; pole zaległych ustawia backlog', async () => {
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ backlog: 'on' }) });
    expect(res.statusCode).toBe(302);
    const row = h.integrations.list()[0]!;
    expect(row.kind).toBe('mail_in');
    expect(row.config).toMatchObject({ imap: { host: 'imap.przyklad.test', port: 993, security: 'tls', verifyCert: true, user: 'u' }, senders: [{ pattern: '@przyklad.test', recipients: [] }] });
    expect(h.integrations.secrets(row.id)).toEqual({ imap_password: 'TajneHaslo9' });
    expect(h.mailIn.state(row.id)).toMatchObject({ backlog: 1, uidFloor: 0 });
    expect(h.audit.list(10, 0)[0]!.meta.sekrety).toEqual(['imap_password']);
    expect(JSON.stringify(h.audit.list(10, 0))).not.toContain('TajneHaslo9');
  });

  it('pole „Pomijaj wiadomości starsze niż”: nowy formularz zaznacza 24 h, zapis przyjmuje wybór, a integracja bez limitu pokazuje „bez limitu”', async () => {
    const form = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-wlasny')).body;
    expect(form).toContain('<label for="maxAgeHours">Pomijaj wiadomości starsze niż</label>');
    expect(form).toContain('<option value="24" selected>24 h</option>');
    expect(form).toContain('Dla alarmów zalecany jest limit 1 h, a dla zamówień i zgłoszeń wariant bez limitu');
    expect(form).toContain('Ustawienie „Pomijaj wiadomości starsze niż” obowiązuje także dla zaległych wiadomości');
    expect((await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ maxAgeHours: '1' }) })).statusCode).toBe(302);
    const row = h.integrations.list()[0]!;
    expect(row.config).toMatchObject({ maxAgeHours: 1 });
    expect((await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', maxAgeHours: '' }))).statusCode).toBe(302);
    expect(h.integrations.get(row.id)!.config).toMatchObject({ maxAgeHours: null });
    expect((await get(`/integracje/${row.id}/edytuj`)).body).toContain('<option value="" selected>bez limitu</option>');
  });

  it('błąd formularza wraca stroną z komunikatem i bez zapisu; hasło zostaje w polu, nie w komunikacie', async () => {
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ host: '' }) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Podaj serwer IMAP.');
    expect(res.body.split('value="TajneHaslo9"').join('')).not.toContain('TajneHaslo9');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('edycja bez nowego hasła zachowuje stare; z nowym podmienia; zmiana folderu zeruje próg', async () => {
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody() });
    const row = h.integrations.list()[0]!;
    h.mailIn.setFloor(row.id, 5, 7);
    const edit = await get(`/integracje/${row.id}/edytuj`);
    expect(edit.body).toContain('Hasło jest zapisane');
    expect(edit.body).not.toContain('TajneHaslo9');
    expect((await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', name: 'Inna nazwa' }))).statusCode).toBe(302);
    expect(h.integrations.secrets(row.id)).toEqual({ imap_password: 'TajneHaslo9' });
    expect(h.integrations.get(row.id)?.name).toBe('Inna nazwa');
    expect(h.mailIn.state(row.id)).toMatchObject({ uidFloor: 5, uidvalidity: 7 });
    expect((await post(`/integracje/${row.id}/edytuj`, formBody({ password: 'NoweHaslo1', folder: 'Alarmy' }))).statusCode).toBe(302);
    expect(h.integrations.secrets(row.id)).toEqual({ imap_password: 'NoweHaslo1' });
    expect(h.mailIn.state(row.id)).toMatchObject({ uidFloor: 0, uidvalidity: 0, nextPollAt: NOW.toISOString() });
    expect((await get(`/integracje/${row.id}`)).statusCode).toBe(200);
  });

  it('zmiana serwera, portu, zabezpieczenia albo loginu przy zapisanym haśle wymaga podania hasła ponownie, także przy sprawdzaniu połączenia', async () => {
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody() });
    const row = h.integrations.list()[0]!;
    for (const over of [{ host: 'imap.obcy.test' }, { port: '143' }, { security: 'none', port: '143' }, { user: 'inny' }, { verifyCert: '0' }]) {
      const res = await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', ...over }));
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('podaj hasło ponownie');
      const check = await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', action: 'polaczenie', ...over }));
      expect(check.statusCode).toBe(400);
      expect(check.body).toContain('podaj hasło ponownie');
    }
    expect(h.integrations.get(row.id)?.config).toMatchObject({ imap: { host: 'imap.przyklad.test' } });
    expect((await post(`/integracje/${row.id}/edytuj`, formBody({ password: 'NoweHaslo1', host: 'imap.obcy.test' }))).statusCode).toBe(302);
    expect((await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', folder: 'Inny', host: 'imap.obcy.test' }))).statusCode).toBe(302);
  });

  it('Sprawdź połączenie przed zapisem: wynik z liczbą nieprzeczytanych i listą folderów na tej samej stronie', async () => {
    h.mailbox.add({ uid: 1, seen: false, source: 'Subject: a\r\n\r\nx' });
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Połączenie nawiązane');
    expect(res.body).toContain('nieprzeczytanych: 1');
    expect(res.body).toContain('data-fill="#folder"');
    expect(res.body).toContain('INBOX');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('Sprawdź połączenie ze złą nazwą folderu pokazuje błąd folderu razem z listą folderów do kliknięcia', async () => {
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody({ folder: 'Nieistniejacy' }) });
    expect(res.body).toContain('Folder nie istnieje');
    expect(res.body).toContain('data-fill="#folder"');
    expect(res.body).toContain('data-value="INBOX"');
  });

  it('zmiana częstotliwości w edycji przestawia najbliższe sprawdzenie na teraz', async () => {
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody() });
    const row = h.integrations.list()[0]!;
    const far = new Date(NOW.getTime() + 3_600_000);
    h.mailIn.recordPoll(row.id, { ok: true, uidvalidity: 1, unseen: 0, at: NOW, nextPollAt: far });
    await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', intervalSec: '30' }));
    expect(Date.parse(h.mailIn.state(row.id)!.nextPollAt)).toBeLessThan(far.getTime());
  });

  it('włączenie skrzynki przez formularz edycji ustawia próg od nowa', async () => {
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ enabled: '' }) });
    const row = h.integrations.list()[0]!;
    h.mailIn.setFloor(row.id, 5, 7);
    await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', enabled: '1' }));
    expect(h.mailIn.state(row.id)).toMatchObject({ uidFloor: 0, uidvalidity: 0 });
  });

  it('Sprawdź połączenie przy złym haśle pokazuje błąd logowania bez hasła w treści; dla zapisanej skrzynki używa zapisanego hasła', async () => {
    const bad = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody({ password: 'Inne' }) });
    expect(bad.body).toContain('Logowanie odrzucone');
    // Hasło wraca tylko w polu formularza, nie w komunikacie.
    expect(bad.body.split('value="Inne"').join('')).not.toContain('Inne');
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody() });
    const row = h.integrations.list()[0]!;
    const ok = await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', action: 'polaczenie' }));
    expect(ok.body).toContain('Połączenie nawiązane');
    h.mailbox.failConnect = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect((await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', action: 'polaczenie' }))).body).toContain('Serwer nie odpowiada');
  });

  it('wpisane hasło zostaje w polu po „Sprawdź połączenie” i po błędzie walidacji, zakodowane; edycja zapisanej skrzynki ma pole puste', async () => {
    const check = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody() });
    expect(check.statusCode).toBe(200);
    expect(check.body).toMatch(/name="password" type="password" value="TajneHaslo9"/);
    const invalid = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ password: 'Ta"jne<', folder: '' }) });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toContain('value="Ta&quot;jne&lt;"');
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody() });
    const row = h.integrations.list()[0]!;
    expect((await get(`/integracje/${row.id}/edytuj`)).body).toMatch(/name="password" type="password" value=""/);
  });

  it('Sprawdź szablon z nadawcą „Nazwa <adres>” ucina podpis od nazwy jak w wysyłce', async () => {
    const res = await post('/integracje', {
      kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz',
      ...formBody({ senders: 'jan@przyklad.test', sampleFrom: 'Jan Kowalski <jan@przyklad.test>', sampleSubject: 'Awaria', sampleText: 'Pompa stoi\n\nJan Kowalski\nSpecjalista ds. IT' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Nadawca na liście');
    const sms = /<div class="ruler"[^>]*>([^<]*)<\/div>/.exec(res.body)?.[1];
    expect(sms).toBe('Awaria\nPompa stoi');
  });

  it('strony formularza skrzynki nie są zapisywane w pamięci podręcznej przeglądarki', async () => {
    const form = await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-wlasny');
    expect(form.headers['cache-control']).toBe('no-store');
    const check = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody() });
    expect(check.headers['cache-control']).toBe('no-store');
  });

  it('Sprawdź szablon z trzech pól pokazuje nadawcę, poziom odbiorców, wycinki, treść i części, nic nie zapisuje', async () => {
    const res = await post('/integracje', {
      kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz',
      ...formBody({ sampleFrom: 'ups@przyklad.test', sampleSubject: 'Alarm', sampleText: 'Error code: E042', 'fields[0][name]': 'kod', 'fields[0][mode]': 'between', 'fields[0][after]': 'Error code:' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Nadawca na liście');
    expect(res.body).toContain('ze stałej listy');
    expect(res.body).toContain('E042');
    expect(res.body).toContain('48601000009');
    expect(h.integrations.list()).toHaveLength(0);
    const obcy = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz', ...formBody({ sampleFrom: 'x@inna.pl', sampleSubject: 'A', sampleText: 'b' }) });
    expect(obcy.body).toContain('Nadawca spoza listy');
    const bez = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz', ...formBody() });
    expect(bez.statusCode).toBe(400);
    expect(bez.body).toContain('Podaj próbkę');
  });

  it('Sprawdź szablon z wklejonym surowym mailem używa parseMail', async () => {
    const raw = readFileSync(new URL('../fixtures/mail/html-tabela-ups.eml', import.meta.url), 'utf8');
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz', ...formBody({ sampleRaw: raw }) });
    expect(res.body).toContain('UPS-01');
    expect(res.body).toContain('Nadawca na liście');
  });

  it('ostrzeżenie o braku szyfrowania pojawia się przy zapisie z security=none i w edycji', async () => {
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz', ...formBody({ security: 'none', port: '143', sampleFrom: 'a@przyklad.test', sampleSubject: 'x', sampleText: 'y' }) });
    expect(res.body).toContain('Połączenie bez szyfrowania');
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ security: 'none', port: '143' }) });
    const row = h.integrations.list()[0]!;
    expect((await get(`/integracje/${row.id}/edytuj`)).body).toContain('Połączenie bez szyfrowania');
  });

  it('edycja skrzynki z szablonem Liquid otwiera się w trybie zaawansowanym z wyjaśnieniem', async () => {
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ tryb: 'zaawansowany', textMode: 'liquid', textTemplate: '{{ subject }}' }) });
    const row = h.integrations.list()[0]!;
    expect(row.config).toMatchObject({ text: { mode: 'liquid', template: '{{ subject }}' } });
    const edit = (await get(`/integracje/${row.id}/edytuj`)).body;
    expect(edit).toContain('Szablon Liquid');
    expect(edit).toContain('trybie zaawansowanym');
  });
});

describe('serwer IMAP w sieci wewnętrznej', () => {
  beforeEach(() => { h.resolve.value = async () => ['10.0.0.5']; });

  it('zapis skrzynki wraca błędem z komunikatem o MIG_MAIL_ALLOW_PRIVATE i bez zapisu', async () => {
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ host: 'imap.firma.lan' }) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('MIG_MAIL_ALLOW_PRIVATE=1');
    expect(res.body).toContain('(10.0.0.5)');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('z allowPrivateMail zapis przechodzi', async () => {
    h = await startAdminHarness(NOW, { allowPrivateMail: true });
    h.resolve.value = async () => ['10.0.0.5'];
    const accountId = seedAccount(h);
    const keyId = h.apiKeys.insert({ accountId, name: 'k', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ host: 'imap.firma.lan', apiKeyId: String(keyId) }) });
    expect(res.statusCode).toBe(302);
    expect(h.integrations.list()).toHaveLength(1);
  });

  it('Sprawdź połączenie pokazuje ten sam komunikat jako błąd formularza, bez próby połączenia', async () => {
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody({ host: 'imap.firma.lan' }) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('MIG_MAIL_ALLOW_PRIVATE=1');
    expect(h.mailbox.calls).not.toContain('connect');
  });

  it('nazwa bez adresu w DNS wraca błędem formularza z powodem', async () => {
    h.resolve.value = async () => [];
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ host: 'brak.przyklad.test' }) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Nazwa serwera IMAP nie rozwiązuje się na adres IP: nazwa nie ma żadnego adresu.');
  });
});

describe('nazwa serwera w nagłówku Authentication-Results', () => {
  it('pole jest w trybie zaawansowanym, w prostym jako pole ukryte z zachowaną wartością', async () => {
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody() });
    const id = h.integrations.list()[0]!.id;
    const adv = await get(`/integracje/${id}/edytuj?tryb=zaawansowany`);
    expect(adv.body).toContain('Nazwa serwera w nagłówku Authentication-Results');
    expect(adv.body).toContain('placeholder="mx.google.com"');
    const simple = await get(`/integracje/${id}/edytuj?tryb=prosty`);
    expect(simple.body).toContain('name="authservId"');
    expect(simple.body).not.toContain('Nazwa serwera w nagłówku Authentication-Results');
  });
  it('skrzynka z nazwą serwera otwiera się w trybie zaawansowanym z notatką, a szczegóły pokazują nazwę', async () => {
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ tryb: 'zaawansowany', authservId: 'mx.google.com', requireAuthResults: 'on' }) });
    const id = h.integrations.list()[0]!.id;
    expect(h.integrations.get(id)!.config).toMatchObject({ authservId: 'mx.google.com' });
    const edit = await get(`/integracje/${id}/edytuj`);
    expect(edit.body).toContain('albo nazwa serwera w nagłówku Authentication-Results), dlatego otwiera się w trybie zaawansowanym.');
    expect(edit.body).toContain('value="mx.google.com"');
    expect((await get(`/integracje/${id}`)).body).toContain('· wymagane SPF/DKIM od mx.google.com');
  });
});

describe('Sprawdź połączenie i authserv-id', () => {
  it('w trybie zaawansowanym pokazuje nazwę serwera z przyciskiem wpisującym do pola, w prostym samą nazwę z podpowiedzią', async () => {
    h.mailbox.authservId = 'mx.google.com';
    const adv = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody({ tryb: 'zaawansowany' }) });
    expect(adv.body).toContain('data-fill="#authservId" data-value="mx.google.com"');
    expect(adv.body).toContain('Authentication-Results');
    const simple = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody() });
    expect(simple.body).not.toContain('data-fill="#authservId"');
    expect(simple.body).toContain('mx.google.com');
    expect(simple.body).toContain('Pole jest w trybie zaawansowanym');
  });
  it('bez nagłówka w ostatniej wiadomości pokazuje informację zamiast przycisku', async () => {
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody() });
    expect(res.body).toContain('brak nagłówka w ostatniej wiadomości');
    expect(res.body).not.toContain('data-fill="#authservId"');
  });
});

describe('skrzynka Microsoft 365', () => {
  const account = (state: 'connected' | 'needs_login' = 'connected'): number => {
    const id = h.m365Accounts.create({ name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, NOW);
    h.m365Accounts.connected(id, {
      refreshToken: 'token-odswiezania-0', address: 'alarmy@firma.pl', addressManual: false, loginName: 'alarmy@firma.pl', loginOid: null,
      redirectUri: 'http://localhost:8081/m365/powrot', by: 'janek',
    }, NOW);
    if (state === 'needs_login') h.m365Accounts.failed(id, { state: 'needs_login', code: '50173', message: 'x' }, NOW);
    return id;
  };
  const m365Body = (accountId: number, over: Record<string, string> = {}) =>
    formBody({ authMode: 'm365', m365AccountId: String(accountId), user: 'alarmy@firma.pl', password: '', host: 'evil.example', port: '143', security: 'none', ...over });

  it('katalog Mail2SMS zawiera kafelek Microsoft 365', async () => {
    const body = (await get('/integracje/nowa?rodzaj=mail_in')).body;
    expect(body).toContain('ustawienie=poczta-m365');
    expect(body).toContain('Microsoft 365');
  });

  it('formularz bez kont zamiast listy pokazuje odnośnik do dodania konta i nie pyta o serwer ani hasło', async () => {
    const body = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-m365')).body;
    expect(body).toContain('href="/microsoft-365/nowe"');
    expect(body).toContain('Dodaj konto Microsoft 365');
    expect(body).toContain('Dodaj konto na ekranie Konta Microsoft 365 i zaloguj je adresem skrzynki bramki');
    expect(body).toContain('</strong> oznacza adres tego konta');
    expect(body).not.toMatch(/techniczn/i);
    expect(body).not.toContain('name="password"');
    expect(body).not.toContain('Serwer IMAP');
  });

  it('formularz z połączonym kontem wybiera je domyślnie, a adres skrzynki podaje w podpowiedzi pustego pola', async () => {
    const id = account();
    const body = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-m365')).body;
    expect(body).toContain(`<option value="${id}" selected data-address="alarmy@firma.pl">Dyżur IT · połączone</option>`);
    expect(body).toContain('name="user" value="" placeholder="alarmy@firma.pl"');
    expect(body).toContain('name="authMode" value="m365"');
    expect(body).toContain('<option value="24" selected>24 h</option>');
  });

  it('nowa skrzynka Microsoft 365 ma domyślnie zaznaczone potwierdzenie nadawcy (SPF/DKIM), inne kafelki nie', async () => {
    account();
    const m365 = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-m365')).body;
    expect(m365).toContain('<input type="checkbox" name="requireAuthResults" value="1" checked>');
    const gmail = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-gmail')).body;
    expect(gmail).toContain('<input type="checkbox" name="requireAuthResults" value="1">');
  });

  it('podpowiedź przy sprawdzaniu nadawcy w skrzynce Microsoft 365 mówi o wiadomościach wewnętrznych, a przy serwerze z hasłem nie', async () => {
    account();
    const sentence = 'Wiadomość od nadawcy z domeny skrzynki przechodzi także wtedy, gdy Exchange oznaczył ją jako wysłaną wewnątrz organizacji';
    const m365 = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-m365')).body;
    expect(m365).toContain(sentence);
    expect(m365).not.toContain('Zalecane u dostawców publicznych');
    const own = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-wlasny')).body;
    expect(own).not.toContain(sentence);
    expect(own).toContain('Zalecane u dostawców publicznych');
    expect(own).toContain('Po włączeniu wyślij wiadomość próbną od każdego nadawcy i sprawdź wpis w dzienniku');
  });

  it('zapis bez hasła wymusza serwer Microsoft 365 niezależnie od przesłanego serwera', async () => {
    const id = account();
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-m365', ...m365Body(id) });
    expect(res.statusCode).toBe(302);
    const row = h.integrations.list()[0]!;
    expect((row.config as { imap: unknown }).imap).toEqual({ ...M365_IMAP, user: 'alarmy@firma.pl', passRef: 'imap_password', auth: { mode: 'm365', accountId: id } });
    expect(h.integrations.secretNames(row.id)).toEqual([]);
  });

  it('zmiana konta przy tym samym adresie zostawia próg, a zmiana adresu skrzynki ustawia go od nowa', async () => {
    const a = account();
    const b = account();
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-m365', ...m365Body(a) });
    const row = h.integrations.list()[0]!;
    h.mailIn.setFloor(row.id, 5, 7);
    expect((await post(`/integracje/${row.id}/edytuj`, m365Body(a, { name: 'Inna nazwa' }))).statusCode).toBe(302);
    expect(h.mailIn.state(row.id)).toMatchObject({ uidFloor: 5, uidvalidity: 7 });
    expect((await post(`/integracje/${row.id}/edytuj`, m365Body(b))).statusCode).toBe(302);
    expect(h.mailIn.state(row.id)).toMatchObject({ uidFloor: 5, uidvalidity: 7 });
    expect((await post(`/integracje/${row.id}/edytuj`, m365Body(b, { user: 'dyspozytornia@firma.pl' }))).statusCode).toBe(302);
    expect(h.mailIn.state(row.id)).toMatchObject({ uidFloor: 0, uidvalidity: 0, nextPollAt: NOW.toISOString() });
  });

  it('edycja skrzynki konta: puste pole adresu, adres wybranego konta w podpowiedzi pola i przy każdym koncie listy', async () => {
    const a = account();
    const b = account();
    h.m365Accounts.setAddress(b, 'serwis@firma.pl', NOW);
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-m365', ...m365Body(a) });
    const row = h.integrations.list()[0]!;
    const body = (await get(`/integracje/${row.id}/edytuj`)).body;
    expect(body).toContain('<input id="user" name="user" value="" placeholder="alarmy@firma.pl" data-address-of="m365AccountId"');
    expect(body).toContain(`<option value="${b}" data-address="serwis@firma.pl">`);
  });

  it('edycja skrzynki współdzielonej zostawia jej adres w polu', async () => {
    const a = account();
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-m365', ...m365Body(a, { user: 'dyspozytornia@firma.pl' }) });
    const row = h.integrations.list()[0]!;
    expect((await get(`/integracje/${row.id}/edytuj`)).body).toContain('<input id="user" name="user" value="dyspozytornia@firma.pl" placeholder="alarmy@firma.pl"');
  });

  it('przejście z Microsoft 365 na hasło wymaga podania hasła, mimo że stare jest zapisane', async () => {
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ host: M365_IMAP.host }) });
    const row = h.integrations.list()[0]!;
    const id = account();
    expect((await post(`/integracje/${row.id}/edytuj`, m365Body(id))).statusCode).toBe(302);
    const back = await post(`/integracje/${row.id}/edytuj`, formBody({ host: M365_IMAP.host, user: 'alarmy@firma.pl', password: '' }));
    expect(back.statusCode).toBe(400);
    expect(back.body).toContain('podaj hasło ponownie');
  });

  it('Sprawdź połączenie z kontem wymagającym logowania pokazuje błąd konta bez łączenia się', async () => {
    const id = account('needs_login');
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-m365', ...m365Body(id), action: 'polaczenie' });
    expect(res.body).toContain('Konto Microsoft 365 wymaga logowania');
    expect(h.mailbox.calls).not.toContain('connect');
  });

  it('Sprawdź połączenie z połączonym kontem loguje się tokenem dostępu', async () => {
    const id = account();
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-m365', ...m365Body(id), action: 'polaczenie' });
    expect(res.body).toContain('Połączenie nawiązane');
    expect(h.mailbox.lastAuth).toEqual({ kind: 'oauth2', accessToken: 'token-dostepu-1' });
    expect(h.mailbox.lastUser).toBe('alarmy@firma.pl');
  });

  it('Sprawdź połączenie odrzucone przez Exchange przy sprawnym koncie wymienia literówkę w adresie, IMAP i skrzynkę współdzieloną', async () => {
    const id = account();
    h.mailbox.accessToken = 'inny-token';
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-m365', ...m365Body(id, { user: 'alarmy@frima.pl' }), action: 'polaczenie' });
    expect(res.body).toContain('Logowanie odrzucone');
    expect(res.body).toContain('Sprawdź pisownię adresu skrzynki oraz ustawienie IMAP na karcie Poczta skrzynki bramki. Dla skrzynki współdzielonej sprawdź także, czy skrzynka bramki posiada do niej uprawnienie pełnego dostępu');
  });

  it('szczegóły skrzynki z błędem konta odsyłają do konta Microsoft 365', async () => {
    const id = account('needs_login');
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-m365', ...m365Body(id) });
    const row = h.integrations.list()[0]!;
    h.mailIn.recordPoll(row.id, { ok: false, error: 'Konto Microsoft 365 wymaga logowania', errorKind: 'account', at: NOW, nextPollAt: NOW });
    const body = (await get(`/integracje/${row.id}`)).body;
    expect(body).toContain('Konto Microsoft 365 wymaga logowania');
    expect(body).toContain(`href="/microsoft-365/${id}"`);
  });
});
