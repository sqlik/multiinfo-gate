import { beforeEach, describe, expect, it } from 'vitest';
import { defaultMailInConfig } from '../../src/integrations/config.ts';
import { m365TokenReply, seedAccount, startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-11-04T12:00:00Z');
const TENANT = 'firma.onmicrosoft.com';
const CLIENT = '11111111-2222-3333-4444-555555555555';
const HOST = 'localhost:8081';
const REDIRECT = 'http://localhost:8081/m365/powrot';
const ADMIN = { id: 1, login: 'janek' };

let h: AdminHarness;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
});

const page = (url: string, host = HOST) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie, host } });
const anon = (url: string) => h.app.inject({ method: 'GET', url, headers: { host: HOST } });
const post = (url: string, payload: Record<string, string> = {}, opts: { cookie?: string | null; host?: string } = {}) =>
  h.app.inject({
    method: 'POST', url,
    headers: {
      ...(opts.cookie === null ? {} : { cookie: opts.cookie ?? h.cookie }),
      host: opts.host ?? HOST, 'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams(payload).toString(),
  });

const FORM = { name: 'Dyżur IT', tenant: TENANT, clientId: CLIENT };

const created = (): number => {
  const r = h.m365.create(FORM, ADMIN, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.id;
};

/** Konto połączone przez usługę, bez panelu: start logowania i powrót z kodem. */
const connected = async (): Promise<number> => {
  const id = created();
  const state = new URL(h.m365.startLogin(id, REDIRECT, ADMIN, NOW).url).searchParams.get('state')!;
  const r = await h.m365.finishLogin({ state, code: 'kod' }, ADMIN, NOW);
  if (!r.ok) throw new Error(r.error);
  return id;
};

/** Skrzynka Mail2SMS logująca się kontem Microsoft 365. */
const mailbox = (accountId: number): number => {
  const apiKeyId = h.apiKeys.insert({
    accountId: seedAccount(h), name: 'Serwis', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  const c = defaultMailInConfig();
  return h.integrations.insert({
    name: 'Alarmy serwisu', kind: 'mail_in', apiKeyId, serviceId: null, orig: null, preset: 'poczta-m365', enabled: 1,
    config: { ...c, imap: { ...c.imap, auth: { mode: 'm365', accountId } } }, secrets: {}, storePayloads: 0, createdAt: NOW,
  });
};

const stateFrom = (location: string): string => new URL(location).searchParams.get('state')!;

/** Panel używa wyłącznie łącznika i zapisu „na przykład”. */
const plainText = (html: string) => {
  expect(html).not.toMatch(/[\u2013\u2014]/);
  expect(html).not.toMatch(/\bnp\./);
};

describe('logowanie przez stronę pośrednią', () => {
  it('pełny przebieg: zapis z logowaniem, powrót bez sesji, dokończenie z sesją', async () => {
    const start = await post('/microsoft-365', { ...FORM, action: 'zaloguj' });
    expect(start.statusCode).toBe(303);
    const location = start.headers.location as string;
    expect(location.startsWith(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?`)).toBe(true);
    expect(location).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A8081%2Fm365%2Fpowrot');
    const state = stateFrom(location);

    const back = await anon(`/m365/powrot?code=c&state=${state}`);
    expect(back.statusCode).toBe(200);
    expect(back.headers['referrer-policy']).toBe('no-referrer');
    expect(back.headers['cache-control']).toBe('no-store');
    expect(back.body).toContain(`<meta http-equiv="refresh" content="0;url=/m365/dokoncz?code=c&amp;state=${state}">`);
    expect(back.body).toContain(`href="/m365/dokoncz?code=c&amp;state=${state}"`);
    expect(back.body).toContain('Kontynuuj');
    plainText(back.body);

    const done = await page(`/m365/dokoncz?code=c&state=${state}`);
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe('/microsoft-365/1');
    expect(h.m365Accounts.get(1)).toMatchObject({ state: 'connected', address: 'alarmy@firma.pl', redirectUri: REDIRECT, connectedBy: 'janek' });
    expect(h.m365Forms).toHaveLength(1);
    expect((await page('/microsoft-365/1')).body).toContain('Połączono jako alarmy@firma.pl');
  });

  it('dokończenie bez sesji prowadzi do logowania panelu i nie zmienia konta', async () => {
    const id = created();
    const state = stateFrom(h.m365.startLogin(id, REDIRECT, ADMIN, NOW).url);
    const res = await anon(`/m365/dokoncz?code=c&state=${state}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/zaloguj');
    expect(h.m365Accounts.get(id)!.state).toBe('new');
    expect(h.m365Forms).toHaveLength(0);
  });

  it('strona pośrednia przenosi wyłącznie code, state, error i error_description', async () => {
    const res = await anon('/m365/powrot?code=c&state=s&next=https%3A%2F%2Fevil.example&error=access_denied&error_description=Brak%20zgody&x=1');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('evil');
    expect(res.body).not.toContain('x=1');
    expect(res.body).toContain('url=/m365/dokoncz?code=c&amp;state=s&amp;error=access_denied&amp;error_description=Brak+zgody"');
  });

  it('odmowa Microsoftu kończy się komunikatem na szczegółach konta bez zmiany stanu', async () => {
    const id = created();
    const state = stateFrom(h.m365.startLogin(id, REDIRECT, ADMIN, NOW).url);
    const res = await page(`/m365/dokoncz?error=access_denied&error_description=Brak%20zgody&state=${state}`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/microsoft-365/${id}`);
    expect(h.m365Accounts.get(id)!.state).toBe('new');
    expect((await page(`/microsoft-365/${id}`)).body).toContain('Microsoft odrzucił logowanie: Brak zgody');
  });

  it('nieznany state prowadzi na listę kont z komunikatem', async () => {
    const res = await page('/m365/dokoncz?code=c&state=nieznany');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/microsoft-365');
    expect((await page('/microsoft-365')).body).toContain('Logowanie wygasło albo zostało już zakończone');
  });

  it('logowanie innym kontem niż poprzednio informuje o zmianie adresu skrzynki', async () => {
    const id = await connected();
    h.m365.setAddress(id, 'dyspozytornia@firma.pl', ADMIN, NOW);
    h.m365Reply.value = m365TokenReply({ oid: 'bbbbbbbb-0000-1111-2222-333344445555', preferred_username: 'serwis@firma.pl' });
    const start = await post(`/microsoft-365/${id}/zaloguj`);
    await page(`/m365/dokoncz?code=c&state=${stateFrom(start.headers.location as string)}`);
    const body = (await page(`/microsoft-365/${id}`)).body;
    expect(body).toContain('Zalogowano kontem serwis@firma.pl, innym niż poprzednio');
    expect(body).toContain('adres skrzynki zmieniono na serwis@firma.pl');
  });

  it('logowanie bez sesji panelu nie rozpoczyna logowania w Microsoft', async () => {
    const id = created();
    const res = await post(`/microsoft-365/${id}/zaloguj`, {}, { cookie: null });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/zaloguj');
  });

  it('adres przekierowania za serwerem pośredniczącym z HTTPS używa schematu https', async () => {
    const id = created();
    const res = await h.app.inject({
      method: 'POST', url: `/microsoft-365/${id}/zaloguj`,
      headers: { cookie: h.cookie, host: 'sms.firma.pl', 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain('redirect_uri=https%3A%2F%2Fsms.firma.pl%2Fm365%2Fpowrot');
  });

  it('nagłówek Host z niedozwolonymi znakami nie trafia do adresu przekierowania', async () => {
    const id = created();
    const res = await post(`/microsoft-365/${id}/zaloguj`, {}, { host: 'evil.example/x?' });
    expect(res.statusCode).toBe(400);
  });
});

describe('lista, formularz i szczegóły', () => {
  it('pusta lista zaprasza do dodania konta', async () => {
    const res = await page('/microsoft-365');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/microsoft-365/nowe"');
    plainText(res.body);
  });

  it('formularz pokazuje adres przekierowania z przyciskiem Kopiuj i zwiniętą instrukcję', async () => {
    const res = await page('/microsoft-365/nowe');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`id="redirect-uri">${REDIRECT}</div>`);
    expect(res.body).toContain('data-copy="#redirect-uri"');
    expect(res.body).toContain('<details>');
    expect(res.body).toContain('https://sqlik.github.io/multiinfo-gate/uruchomienie/#48-konto-microsoft-365');
    expect(res.body).toContain('Zapisz i zaloguj w Microsoft');
    plainText(res.body);
  });

  it('instrukcja w formularzu używa nazw z polskiego portalu Entra', async () => {
    const body = (await page('/microsoft-365/nowe')).body;
    expect(body).toContain('Klient publiczny/natywny (mobilne i klasyczne)');
    expect(body).toContain('Wyraź zgodę administratora dla katalogu');
    expect(body).not.toContain('Udziel zgody administratora');
  });

  it('zapis bez logowania prowadzi na szczegóły, a błędne dane wracają do formularza z komunikatem', async () => {
    const ok = await post('/microsoft-365', FORM);
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('/microsoft-365/1');
    expect(h.m365Accounts.get(1)).toMatchObject({ name: 'Dyżur IT', tenant: TENANT, state: 'new' });

    const bad = await post('/microsoft-365', { ...FORM, name: 'Biuro handlowe', tenant: 'zly katalog' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('Identyfikator katalogu musi być identyfikatorem GUID albo nazwą domeny');
    expect(bad.body).toContain('value="Biuro handlowe"');
    expect(h.m365Accounts.list()).toHaveLength(1);
  });

  it('lista pokazuje adres skrzynki, stan, ostatnie odświeżenie i odbiorców', async () => {
    const id = await connected();
    mailbox(id);
    const res = await page('/microsoft-365');
    expect(res.body).toContain('Dyżur IT');
    expect(res.body).toContain('alarmy@firma.pl');
    expect(res.body).toContain('Połączone');
    expect(res.body).toContain('1 integracja');
    plainText(res.body);
  });

  it('szczegóły pokazują tożsamość logowania, adres skrzynki i oznaczenie adresu ustawionego ręcznie', async () => {
    const id = await connected();
    let body = (await page(`/microsoft-365/${id}`)).body;
    expect(body).toContain('Zalogowano jako');
    expect(body).toContain('alarmy@firma.pl');
    expect(body).not.toContain('<span class="dim">ustawiony ręcznie</span>');
    expect(body).toContain('Zaloguj ponownie');
    expect(body).toContain(`action="/microsoft-365/${id}/rozlacz"`);
    expect(body).toContain(`action="/microsoft-365/${id}/usun"`);
    plainText(body);

    const res = await post(`/microsoft-365/${id}/adres`, { address: 'Dyspozytornia@Firma.pl' });
    expect(res.statusCode).toBe(303);
    expect(h.m365Accounts.get(id)).toMatchObject({ address: 'dyspozytornia@firma.pl', addressManual: true });
    body = (await page(`/microsoft-365/${id}`)).body;
    expect(body).toContain('dyspozytornia@firma.pl <span class="dim">ustawiony ręcznie</span>');
  });

  it('błędny adres skrzynki wraca z komunikatem bez zmiany', async () => {
    const id = await connected();
    await post(`/microsoft-365/${id}/adres`, { address: 'dyspozytornia' });
    expect(h.m365Accounts.get(id)!.address).toBe('alarmy@firma.pl');
    expect((await page(`/microsoft-365/${id}`)).body).toContain('Adres skrzynki musi być adresem e-mail');
  });

  it('szczegóły ostrzegają, gdy panel otwarto pod innym adresem niż przy logowaniu', async () => {
    const id = await connected();
    expect((await page(`/microsoft-365/${id}`)).body).not.toContain('różni się od adresu użytego przy ostatnim logowaniu');
    const other = await page(`/microsoft-365/${id}`, '127.0.0.1:8081');
    expect(other.body).toContain('różni się od adresu użytego przy ostatnim logowaniu');
    expect(other.body).toContain('http://127.0.0.1:8081/m365/powrot');
  });

  it('konto wymagające logowania pokazuje kod AADSTS i podpowiedź', async () => {
    const id = await connected();
    h.m365Accounts.failed(id, { state: 'needs_login', code: '50173', message: 'AADSTS50173: The provided grant has expired' }, NOW);
    const body = (await page(`/microsoft-365/${id}`)).body;
    expect(body).toContain('Wymaga logowania');
    expect(body).toContain('AADSTS50173');
    expect(body).toContain('Microsoft unieważnił logowanie po zmianie hasła konta albo odwołaniu sesji, dlatego należy kliknąć „Zaloguj ponownie”. Skrzynki Mail2SMS i maile powiadomień korzystające z tego konta czekają na ponowne logowanie.');
    expect(body).not.toContain('w szczegółach konta');
  });

  it('nieznany kod AADSTS: podpowiedź ogólna bez powtórzonego „Microsoft odrzucił”', async () => {
    const id = await connected();
    h.m365Accounts.failed(id, { state: 'needs_login', code: '99999', message: 'AADSTS99999: nieznany' }, NOW);
    const body = (await page(`/microsoft-365/${id}`)).body;
    expect(body).toContain('Microsoft odrzucił logowanie, dlatego należy kliknąć „Zaloguj ponownie”, a gdy błąd się powtórzy');
    expect(body.match(/Microsoft odrzucił/g)).toHaveLength(1);
  });

  it('edycja zmienia nazwę, a zmiana aplikacji rozłącza konto', async () => {
    const id = await connected();
    const form = await page(`/microsoft-365/${id}/edycja`);
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('value="Dyżur IT"');
    plainText(form.body);
    await post(`/microsoft-365/${id}`, { ...FORM, name: 'Dyspozytornia' });
    expect(h.m365Accounts.get(id)).toMatchObject({ name: 'Dyspozytornia', state: 'connected' });
    await post(`/microsoft-365/${id}`, { ...FORM, clientId: '99999999-2222-3333-4444-555555555555' });
    expect(h.m365Accounts.get(id)!.state).toBe('new');
  });

  it('rozłączenie kasuje token i informuje o cofnięciu zgody w Entra', async () => {
    const id = await connected();
    const res = await post(`/microsoft-365/${id}/rozlacz`);
    expect(res.statusCode).toBe(303);
    expect(h.m365Accounts.get(id)!.state).toBe('new');
    expect(h.m365Accounts.refreshToken(id)).toBeNull();
    expect((await page(`/microsoft-365/${id}`)).body).toContain('Entra');
  });

  it('usunięcie konta używanego przez integrację jest zablokowane z listą odbiorców', async () => {
    const id = await connected();
    mailbox(id);
    const res = await post(`/microsoft-365/${id}/usun`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/microsoft-365/${id}`);
    expect(h.m365Accounts.get(id)).toBeDefined();
    expect((await page(`/microsoft-365/${id}`)).body).toContain('Alarmy serwisu');
  });

  it('usunięcie nieużywanego konta prowadzi na listę', async () => {
    const id = created();
    const res = await post(`/microsoft-365/${id}/usun`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/microsoft-365');
    expect(h.m365Accounts.get(id)).toBeUndefined();
  });

  it('nieistniejące konto daje 404', async () => {
    expect((await page('/microsoft-365/99')).statusCode).toBe(404);
    expect((await page('/microsoft-365/99/edycja')).statusCode).toBe(404);
    expect((await post('/microsoft-365/99/zaloguj')).statusCode).toBe(404);
    expect((await post('/microsoft-365/99/rozlacz')).statusCode).toBe(404);
  });
});

describe('nawigacja, przegląd i /healthz', () => {
  it('nawigacja zawiera Konta Microsoft 365 z plakietką tylko przy kontach wymagających logowania', async () => {
    const id = await connected();
    let body = (await page('/przeglad')).body;
    expect(body).toContain('<a href="/microsoft-365">Konta Microsoft 365</a>');
    h.m365Accounts.failed(id, { state: 'needs_login', code: '50173', message: 'x' }, NOW);
    body = (await page('/przeglad')).body;
    expect(body).toContain('<a href="/microsoft-365">Konta Microsoft 365<span class="ct">1</span></a>');
    expect(body.indexOf('Konta Multiinfo')).toBeLessThan(body.indexOf('Konta Microsoft 365'));
  });

  it('pasek na przeglądzie przy koncie wymagającym logowania, bez paska przy połączonym', async () => {
    const id = await connected();
    expect((await page('/przeglad')).body).not.toContain('wymaga ponownego logowania');
    h.m365Accounts.failed(id, { state: 'needs_login', code: '50173', message: 'x' }, NOW);
    const body = (await page('/przeglad')).body;
    expect(body).toContain('Konto Microsoft 365 <strong>Dyżur IT</strong> wymaga ponownego logowania');
    expect(body).toContain(`action="/microsoft-365/${id}/zaloguj"`);
    plainText(body);
  });

  it('/healthz panelu podaje liczbę kont i kont wymagających logowania bez adresów', async () => {
    const id = await connected();
    created();
    h.m365Accounts.failed(id, { state: 'needs_login', code: '50173', message: 'x' }, NOW);
    const res = await h.app.inject({ method: 'GET', url: '/healthz', headers: { host: HOST } });
    expect(res.json().m365).toEqual({ accounts: 2, needsLogin: 1 });
    expect(res.body).not.toContain('alarmy@firma.pl');
  });
});
