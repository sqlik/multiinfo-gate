import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultMailInConfig } from '../../src/integrations/config.ts';
import { M365AuthError, type TokenFetch } from '../../src/m365/oauth.ts';
import { LOGIN_TTL_MS, M365Service } from '../../src/m365/service.ts';
import { M365Tokens } from '../../src/m365/tokens.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { AuditRepo } from '../../src/store/audit.ts';
import { openDatabase } from '../../src/store/db.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { M365AccountsRepo } from '../../src/store/m365-accounts.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';
import { accountInput } from '../store/helpers.ts';

const T0 = new Date('2026-11-04T12:00:00Z');
const GUID = 'ae2e1bd7-666a-41db-82ce-3661a1afd121';
const CLIENT = '11111111-2222-3333-4444-555555555555';
const REDIRECT = 'http://localhost:8081/m365/powrot';
const ADMIN = { id: 1, login: 'admin' };
const OTHER = { id: 2, login: 'dyzurny' };

function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.`;
}

let accounts: M365AccountsRepo;
let integrations: IntegrationsRepo;
let notifications: NotificationsRepo;
let audit: AuditRepo;
let apiKeyId: number;
let forms: URLSearchParams[];
let reply: { status: number; body: unknown };
let service: M365Service;
let tokens: M365Tokens;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  accounts = new M365AccountsRepo(db, key);
  integrations = new IntegrationsRepo(db, key);
  notifications = new NotificationsRepo(db, key);
  audit = new AuditRepo(db);
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  apiKeyId = new ApiKeysRepo(db, key).insert({
    accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  forms = [];
  reply = {
    status: 200,
    body: {
      token_type: 'Bearer', expires_in: 3600, access_token: 'token-dostepu-1', refresh_token: 'token-odswiezania-1',
      id_token: idToken({ tid: GUID, preferred_username: 'Alarmy@Firma.pl' }),
    },
  };
  const fetch: TokenFetch = async (_url, form) => { forms.push(form); return reply; };
  tokens = new M365Tokens({ accounts, fetch });
  service = new M365Service({ accounts, tokens, fetch, integrations, notifications, audit });
});

const created = (tenant = GUID): number => {
  const r = service.create({ name: 'Dyżur IT', tenant, clientId: CLIENT }, ADMIN, T0);
  if (!r.ok) throw new Error(r.error);
  return r.id;
};

const stateOf = (url: string): string => new URL(url).searchParams.get('state')!;

describe('create i update', () => {
  it('zakłada konto w stanie new z wpisem w dzienniku zdarzeń', () => {
    const id = created();
    expect(accounts.get(id)).toMatchObject({ name: 'Dyżur IT', tenant: GUID, clientId: CLIENT, state: 'new' });
    expect(audit.list(10, 0)[0]).toMatchObject({ actor: 'admin', action: 'm365.dodano', target: `m365:${id}` });
  });

  it('identyfikatory zapisuje małymi literami bez spacji na brzegach', () => {
    const r = service.create({ name: ' Dyżur IT ', tenant: ` ${GUID.toUpperCase()} `, clientId: CLIENT.toUpperCase() }, ADMIN, T0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(accounts.get(r.id)).toMatchObject({ name: 'Dyżur IT', tenant: GUID, clientId: CLIENT });
  });

  it('odrzuca nieprawidłowy katalog, identyfikator aplikacji i pustą nazwę z komunikatem', () => {
    for (const input of [
      { name: 'Dyżur IT', tenant: 'evil.com/x', clientId: CLIENT },
      { name: 'Dyżur IT', tenant: GUID, clientId: 'firma' },
      { name: '  ', tenant: GUID, clientId: CLIENT },
    ]) {
      const r = service.create(input, ADMIN, T0);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
    expect(accounts.list()).toHaveLength(0);
  });

  it('zmiana katalogu kasuje połączenie i token w pamięci', async () => {
    const id = created();
    accounts.connected(id, { refreshToken: 'r', address: 'alarmy@firma.pl', redirectUri: REDIRECT, by: 'admin', loginName: 'alarmy@firma.pl', loginOid: null, addressManual: false }, T0);
    tokens.remember(id, { accessToken: 'stary', refreshToken: 'r', expiresAt: new Date(T0.getTime() + 3600_000), claims: null });
    expect(service.update(id, { name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: CLIENT }, ADMIN, T0)).toEqual({ ok: true });
    expect(accounts.get(id)).toMatchObject({ state: 'new', tenant: 'firma.onmicrosoft.com' });
    expect((await tokens.access(id, T0).catch((e: unknown) => e)) instanceof M365AuthError).toBe(true);
    expect(audit.list(10, 0)[0]).toMatchObject({ action: 'm365.zmieniono', target: `m365:${id}` });
  });

  it('zmiana nieistniejącego konta zwraca błąd', () => {
    expect(service.update(999, { name: 'x', tenant: GUID, clientId: CLIENT }, ADMIN, T0).ok).toBe(false);
  });
});

describe('startLogin i finishLogin', () => {
  it('startLogin zwraca adres logowania z identyfikatorem state i wyzwaniem PKCE', () => {
    const id = created();
    const u = new URL(service.startLogin(id, REDIRECT, ADMIN, T0).url);
    expect(u.host).toBe('login.microsoftonline.com');
    expect(u.pathname).toBe(`/${GUID}/oauth2/v2.0/authorize`);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('poprawny powrót łączy konto, zapisuje adres z roszczeń i token tylko w postaci zaszyfrowanej', async () => {
    const id = created();
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    const r = await service.finishLogin({ state: stateOf(url), code: 'kod-1' }, ADMIN, new Date(T0.getTime() + 60_000));
    expect(r).toEqual({ ok: true, accountId: id, address: 'alarmy@firma.pl', login: 'Alarmy@Firma.pl', switched: false });
    expect(accounts.get(id)).toMatchObject({ state: 'connected', address: 'alarmy@firma.pl', redirectUri: REDIRECT, connectedBy: 'admin' });
    expect(accounts.refreshToken(id)).toBe('token-odswiezania-1');
    expect(forms).toHaveLength(1);
    expect(forms[0]!.get('code')).toBe('kod-1');
    expect(forms[0]!.get('redirect_uri')).toBe(REDIRECT);
    const challenge = new URL(url).searchParams.get('code_challenge');
    expect(createHash('sha256').update(forms[0]!.get('code_verifier')!).digest('base64url')).toBe(challenge);
    const entry = audit.list(10, 0)[0]!;
    expect(entry).toMatchObject({ actor: 'admin', action: 'm365.zalogowano', target: `m365:${id}` });
    expect(JSON.stringify(entry)).toContain('alarmy@firma.pl');
    expect(JSON.stringify(entry)).not.toMatch(/token-dostepu-1|token-odswiezania-1|kod-1/);
  });

  it('token dostępu z logowania służy bez ponownego wołania Microsoftu', async () => {
    const id = created();
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    await service.finishLogin({ state: stateOf(url), code: 'kod-1' }, ADMIN, T0);
    expect(await tokens.access(id, T0)).toEqual({ token: 'token-dostepu-1', address: 'alarmy@firma.pl' });
    expect(forms).toHaveLength(1);
  });

  it('powrót z sesją innego użytkownika panelu jest odrzucony bez zapisu tokenu', async () => {
    const id = created();
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    const r = await service.finishLogin({ state: stateOf(url), code: 'kod-1' }, OTHER, T0);
    expect(r.ok).toBe(false);
    expect(accounts.refreshToken(id)).toBeNull();
    expect(accounts.get(id)!.state).toBe('new');
    expect(forms).toHaveLength(0);
  });

  it('wygasły state jest odrzucony', async () => {
    const id = created();
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    const r = await service.finishLogin({ state: stateOf(url), code: 'kod-1' }, ADMIN, new Date(T0.getTime() + LOGIN_TTL_MS + 1));
    expect(r).toMatchObject({ ok: false, accountId: id });
    expect(accounts.refreshToken(id)).toBeNull();
    expect(forms).toHaveLength(0);
  });

  it('state można użyć tylko raz', async () => {
    const id = created();
    const state = stateOf(service.startLogin(id, REDIRECT, ADMIN, T0).url);
    expect((await service.finishLogin({ state, code: 'kod-1' }, ADMIN, T0)).ok).toBe(true);
    const again = await service.finishLogin({ state, code: 'kod-1' }, ADMIN, T0);
    expect(again).toMatchObject({ ok: false, accountId: null });
    expect(forms).toHaveLength(1);
  });

  it('nieznany albo brakujący state jest odrzucony bez numeru konta', async () => {
    created();
    expect(await service.finishLogin({ state: 'cudzy', code: 'kod-1' }, ADMIN, T0)).toMatchObject({ ok: false, accountId: null });
    expect(await service.finishLogin({ code: 'kod-1' }, ADMIN, T0)).toMatchObject({ ok: false, accountId: null });
    expect(forms).toHaveLength(0);
  });

  it('error=access_denied od Microsoftu kończy logowanie bez zmiany stanu konta', async () => {
    const id = created();
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    const r = await service.finishLogin({ state: stateOf(url), error: 'access_denied', error_description: 'AADSTS65004: User declined to consent. Trace ID: x' }, ADMIN, T0);
    expect(r).toMatchObject({ ok: false, accountId: id });
    if (!r.ok) expect(r.error).not.toContain('Trace ID');
    expect(accounts.get(id)!.state).toBe('new');
    expect(forms).toHaveLength(0);
  });

  it('odrzucenie wymiany kodu przez Microsoft kończy logowanie bez zapisu tokenu', async () => {
    const id = created();
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    reply = { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70008: The provided authorization code has expired.' } };
    const r = await service.finishLogin({ state: stateOf(url), code: 'kod-1' }, ADMIN, T0);
    expect(r).toMatchObject({ ok: false, accountId: id });
    expect(accounts.get(id)!.state).toBe('new');
    expect(accounts.refreshToken(id)).toBeNull();
  });

  it('logowanie kontem z innego katalogu niż GUID konta jest odrzucone', async () => {
    const id = created();
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    reply = { status: 200, body: { ...(reply.body as object), id_token: idToken({ tid: '99999999-0000-0000-0000-000000000000', preferred_username: 'x@inna.pl' }) } };
    const r = await service.finishLogin({ state: stateOf(url), code: 'kod-1' }, ADMIN, T0);
    expect(r).toMatchObject({ ok: false, accountId: id });
    expect(accounts.refreshToken(id)).toBeNull();
  });

  it('przy katalogu podanym nazwą domeny tid nie jest porównywany', async () => {
    const id = created('firma.onmicrosoft.com');
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    expect((await service.finishLogin({ state: stateOf(url), code: 'kod-1' }, ADMIN, T0)).ok).toBe(true);
  });

  it('odpowiedź bez adresu w roszczeniach jest odrzucona', async () => {
    const id = created();
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    reply = { status: 200, body: { ...(reply.body as object), id_token: idToken({ tid: GUID }) } };
    expect((await service.finishLogin({ state: stateOf(url), code: 'kod-1' }, ADMIN, T0)).ok).toBe(false);
    expect(accounts.refreshToken(id)).toBeNull();
  });

  it('zmiana katalogu po rozpoczęciu logowania unieważnia logowanie', async () => {
    const id = created();
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    service.update(id, { name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: CLIENT }, ADMIN, T0);
    expect((await service.finishLogin({ state: stateOf(url), code: 'kod-1' }, ADMIN, T0)).ok).toBe(false);
    expect(forms).toHaveLength(0);
  });
});

describe('ponowne logowanie i adres ustawiony ręcznie', () => {
  const OID_A = 'aaaaaaaa-0000-1111-2222-333344445555';
  const OID_B = 'bbbbbbbb-0000-1111-2222-333344445555';

  const loginAs = async (id: number, claims: Record<string, unknown>) => {
    reply = { status: 200, body: { ...(reply.body as object), id_token: idToken({ tid: GUID, ...claims }) } };
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    return service.finishLogin({ state: stateOf(url), code: 'kod' }, ADMIN, T0);
  };

  it('pierwsze logowanie zapisuje tożsamość i adres z roszczeń, bez zmiany konta', async () => {
    const id = created();
    const r = await loginAs(id, { oid: OID_A, preferred_username: 'alarmy@firma.pl' });
    expect(r).toEqual({ ok: true, accountId: id, address: 'alarmy@firma.pl', login: 'alarmy@firma.pl', switched: false });
    expect(accounts.get(id)).toMatchObject({ loginOid: OID_A, loginName: 'alarmy@firma.pl', addressManual: false });
  });

  it('ponowne logowanie tym samym oid zachowuje adres ustawiony ręcznie', async () => {
    const id = created();
    await loginAs(id, { oid: OID_A, preferred_username: 'alarmy@firma.pl' });
    service.setAddress(id, 'dyspozytornia@firma.pl', ADMIN, T0);
    const r = await loginAs(id, { oid: OID_A, preferred_username: 'alarmy@firma.pl' });
    expect(r).toMatchObject({ ok: true, address: 'dyspozytornia@firma.pl', switched: false });
    expect(accounts.get(id)).toMatchObject({ address: 'dyspozytornia@firma.pl', addressManual: true });
  });

  it('po rozłączeniu ponowne logowanie tym samym kontem nadal zachowuje adres ustawiony ręcznie', async () => {
    const id = created();
    await loginAs(id, { oid: OID_A, preferred_username: 'alarmy@firma.pl' });
    service.setAddress(id, 'dyspozytornia@firma.pl', ADMIN, T0);
    service.disconnect(id, ADMIN, T0);
    const r = await loginAs(id, { oid: OID_A, preferred_username: 'alarmy@firma.pl' });
    expect(r).toMatchObject({ ok: true, address: 'dyspozytornia@firma.pl', switched: false });
  });

  it('logowanie innym oid zmienia adres na adres z roszczeń, kasuje znacznik i zgłasza zmianę konta', async () => {
    const id = created();
    await loginAs(id, { oid: OID_A, preferred_username: 'alarmy@firma.pl' });
    service.setAddress(id, 'dyspozytornia@firma.pl', ADMIN, T0);
    const r = await loginAs(id, { oid: OID_B, preferred_username: 'serwis@firma.pl' });
    expect(r).toEqual({ ok: true, accountId: id, address: 'serwis@firma.pl', login: 'serwis@firma.pl', switched: true });
    expect(accounts.get(id)).toMatchObject({ address: 'serwis@firma.pl', addressManual: false, loginOid: OID_B, loginName: 'serwis@firma.pl' });
    const entry = audit.list(10, 0)[0]!;
    expect(entry).toMatchObject({ action: 'm365.zalogowano' });
    expect(entry.meta).toMatchObject({ address: 'serwis@firma.pl', login: 'serwis@firma.pl', switched: true });
  });

  it('ten sam oid przy innej nazwie logowania oznacza to samo konto', async () => {
    const id = created();
    await loginAs(id, { oid: OID_A, preferred_username: 'alarmy@firma.pl' });
    service.setAddress(id, 'dyspozytornia@firma.pl', ADMIN, T0);
    const r = await loginAs(id, { oid: OID_A, preferred_username: 'alarmy-it@firma.pl' });
    expect(r).toMatchObject({ ok: true, address: 'dyspozytornia@firma.pl', login: 'alarmy-it@firma.pl', switched: false });
  });

  it('bez oid konto rozpoznaje po nazwie logowania bez rozróżniania wielkości liter', async () => {
    const id = created();
    await loginAs(id, { preferred_username: 'Alarmy@Firma.pl' });
    service.setAddress(id, 'dyspozytornia@firma.pl', ADMIN, T0);
    const same = await loginAs(id, { oid: OID_A, preferred_username: 'alarmy@firma.pl' });
    expect(same).toMatchObject({ ok: true, address: 'dyspozytornia@firma.pl', switched: false });
    const other = await loginAs(id, { preferred_username: 'serwis@firma.pl' });
    expect(other).toMatchObject({ ok: true, address: 'serwis@firma.pl', switched: true });
    expect(accounts.get(id)!.addressManual).toBe(false);
  });
});

describe('setAddress, disconnect, remove i users', () => {
  it('setAddress zapisuje adres małymi literami i odrzuca napis bez małpy', () => {
    const id = created();
    expect(service.setAddress(id, ' Dyzur@Firma.pl ', ADMIN, T0)).toEqual({ ok: true });
    expect(accounts.get(id)!.address).toBe('dyzur@firma.pl');
    expect(audit.list(10, 0)[0]).toMatchObject({ action: 'm365.adres', target: `m365:${id}` });
    expect(service.setAddress(id, 'dyzur', ADMIN, T0).ok).toBe(false);
    expect(accounts.get(id)!.address).toBe('dyzur@firma.pl');
  });

  it('disconnect kasuje token, ustawia new i zapisuje wpis w dzienniku zdarzeń', async () => {
    const id = created();
    const url = service.startLogin(id, REDIRECT, ADMIN, T0).url;
    await service.finishLogin({ state: stateOf(url), code: 'kod-1' }, ADMIN, T0);
    service.disconnect(id, ADMIN, T0);
    expect(accounts.get(id)!.state).toBe('new');
    expect(accounts.refreshToken(id)).toBeNull();
    expect((await tokens.access(id, T0).catch((e: unknown) => e) as M365AuthError).kind).toBe('needs_login');
    expect(audit.list(10, 0)[0]).toMatchObject({ action: 'm365.rozlaczono', target: `m365:${id}` });
  });

  it('konta wskazanego przez skrzynkę Mail2SMS nie można usunąć, a błąd podaje odbiorców', () => {
    const id = created();
    const c = defaultMailInConfig();
    const mailbox = integrations.insert({
      name: 'Alarmy serwisu', kind: 'mail_in', apiKeyId, serviceId: null, orig: null, preset: 'poczta-m365', enabled: 1,
      config: { ...c, imap: { ...c.imap, auth: { mode: 'm365', accountId: id } } }, secrets: {}, storePayloads: 0, createdAt: T0,
    });
    integrations.insert({
      name: 'Skrzynka z hasłem', kind: 'mail_in', apiKeyId, serviceId: null, orig: null, preset: 'poczta-wlasny', enabled: 1,
      config: c, secrets: { imap_password: 'x' }, storePayloads: 0, createdAt: T0,
    });
    expect(service.users(id)).toEqual([{ kind: 'integration', id: mailbox, name: 'Alarmy serwisu' }]);
    const r = service.remove(id, ADMIN, T0);
    expect(r).toMatchObject({ ok: false, users: [{ kind: 'integration', id: mailbox, name: 'Alarmy serwisu' }] });
    expect(accounts.get(id)).toBeDefined();
  });

  it('konta wskazanego w ustawieniach SMTP nie można usunąć', () => {
    const id = created();
    notifications.saveSmtp({
      host: 'smtp.office365.com', port: 587, security: 'starttls', user: 'alarmy@firma.pl', fromAddress: 'alarmy@firma.pl',
      fromName: 'Bramka', recipients: ['dyzur@firma.pl'], instanceName: 'Bramka', panelUrl: null, authMode: 'm365', m365AccountId: id,
    }, T0);
    expect(service.remove(id, ADMIN, T0)).toMatchObject({ ok: false, users: [{ kind: 'smtp' }] });
    expect(accounts.get(id)).toBeDefined();
  });

  it('nieużywane konto usuwa z wpisem w dzienniku zdarzeń', () => {
    const id = created();
    expect(service.remove(id, ADMIN, T0)).toEqual({ ok: true });
    expect(accounts.get(id)).toBeUndefined();
    expect(audit.list(10, 0)[0]).toMatchObject({ action: 'm365.usunieto', target: `m365:${id}` });
  });
});

describe('zmiany konta w trakcie wymiany kodu', () => {
  let release: () => void;
  let slow: M365Service;
  let slowTokens: M365Tokens;

  beforeEach(() => {
    // Punkt tokenów odpowiada dopiero po `release()`: okno, w którym administrator klika w drugiej karcie.
    const fetch: TokenFetch = () => new Promise((resolve) => { release = () => resolve(reply); });
    slowTokens = new M365Tokens({ accounts, fetch });
    slow = new M365Service({ accounts, tokens: slowTokens, fetch, integrations, notifications, audit });
  });

  const begin = (id: number) => slow.finishLogin({ state: stateOf(slow.startLogin(id, REDIRECT, ADMIN, T0).url), code: 'kod' }, ADMIN, T0);
  const account = (): number => {
    const r = slow.create({ name: 'Dyżur IT', tenant: GUID, clientId: CLIENT }, ADMIN, T0);
    if (!r.ok) throw new Error(r.error);
    return r.id;
  };

  it('rozłączenie zostaje w mocy: konto bez tokenu', async () => {
    const id = account();
    const finishing = begin(id);
    slow.disconnect(id, ADMIN, T0);
    release();
    expect(await finishing).toMatchObject({ ok: false, error: expect.stringContaining('zmieniły się w trakcie logowania') });
    expect(accounts.get(id)!.state).toBe('new');
    expect(accounts.refreshToken(id)).toBeNull();
  });

  it('zmiana aplikacji: token starej aplikacji nie trafia do konta', async () => {
    const id = account();
    const finishing = begin(id);
    expect(slow.update(id, { name: 'Dyżur IT', tenant: GUID, clientId: '99999999-2222-3333-4444-555555555555' }, ADMIN, T0).ok).toBe(true);
    release();
    expect((await finishing).ok).toBe(false);
    expect(accounts.get(id)!.state).toBe('new');
    expect(accounts.refreshToken(id)).toBeNull();
  });

  it('usunięcie konta: logowanie odrzucone, token nie zostaje w pamięci dostawcy', async () => {
    const id = account();
    const finishing = begin(id);
    expect(slow.remove(id, ADMIN, T0).ok).toBe(true);
    release();
    expect(await finishing).toMatchObject({ ok: false, accountId: null });
    expect(audit.list(50, 0).some((e) => e.action === 'm365.zalogowano')).toBe(false);
    await expect(slowTokens.access(id, T0)).rejects.toThrow();
  });
});

describe('znaki sterujące w adresie skrzynki', () => {
  it('setAddress odrzuca adres ze znakiem sterującym', () => {
    const id = created();
    expect(service.setAddress(id, 'alarmy\u0001host=x@firma.pl', ADMIN, T0).ok).toBe(false);
  });

  it('roszczenia z adresem ze znakiem sterującym nie łączą konta', async () => {
    const id = created();
    reply = { ...reply, body: { ...(reply.body as object), id_token: idToken({ tid: GUID, preferred_username: 'alarmy\u0001x@firma.pl' }) } };
    const r = await service.finishLogin({ state: stateOf(service.startLogin(id, REDIRECT, ADMIN, T0).url), code: 'kod' }, ADMIN, T0);
    expect(r.ok).toBe(false);
    expect(accounts.get(id)!.state).toBe('new');
  });
});
