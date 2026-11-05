import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { NotificationEvent } from '../../src/notifications/rules.ts';
import { M365AuthError, hintFor, type TokenFetch } from '../../src/m365/oauth.ts';
import { M365Tokens } from '../../src/m365/tokens.ts';
import type { Logger } from '../../src/log.ts';
import { openDatabase } from '../../src/store/db.ts';
import { M365AccountsRepo } from '../../src/store/m365-accounts.ts';
import { m365DetailPage } from '../../src/admin/views/m365.ts';

const T0 = new Date('2026-11-04T12:00:00Z');
const INPUT = { name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' };
const OLD_REFRESH = 'stary-token-odswiezania';

let accounts: M365AccountsRepo;
let id: number;

beforeEach(() => {
  accounts = new M365AccountsRepo(openDatabase(':memory:'), randomBytes(32));
  id = accounts.create(INPUT, T0);
  accounts.connected(id, { refreshToken: OLD_REFRESH, address: 'alarmy@firma.pl', redirectUri: 'http://localhost:8081/m365/powrot', by: 'admin', loginName: 'alarmy@firma.pl', loginOid: null, addressManual: false }, T0);
});

type Reply = { status: number; body: unknown };
const tokenBody = (n: number, expiresIn = 3600): Reply => ({
  status: 200,
  body: { token_type: 'Bearer', expires_in: expiresIn, access_token: `dostep-${n}`, refresh_token: `odswiezanie-${n}` },
});
const REVOKED: Reply = {
  status: 400,
  body: { error: 'invalid_grant', error_description: 'AADSTS50173: The provided grant has expired due to it being revoked. Trace ID: abc', error_codes: [50173] },
};

/** Atrapa punktu tokenów: odpowiedzi po kolei, opcjonalnie wstrzymane do `release()`. */
function fakeFetch(replies: Reply[], opts: { hold?: boolean } = {}) {
  const forms: URLSearchParams[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const f: TokenFetch = async (_url, form) => {
    forms.push(form);
    const reply = replies[Math.min(forms.length - 1, replies.length - 1)]!;
    if (opts.hold) await gate;
    return reply;
  };
  return { f, forms, release: () => release() };
}

function fakeNotifier() {
  const calls: { event: NotificationEvent; subjectKey: string | null; summary: string; now: Date; dedupKey: string | undefined }[] = [];
  return { calls, notify: (event: NotificationEvent, subjectKey: string | null, summary: string, now: Date, dedupKey?: string) => { calls.push({ event, subjectKey, summary, now, dedupKey }); } };
}

function recordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const put = (msg: string, fields?: Record<string, unknown>) => { lines.push(`${msg} ${JSON.stringify(fields ?? {})}`); };
  return { lines, error: put, warn: put, info: put, debug: put };
}

async function caught(p: Promise<unknown>): Promise<M365AuthError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(M365AuthError);
    return err as M365AuthError;
  }
  throw new Error('oczekiwano M365AuthError');
}

describe('M365Tokens.access', () => {
  it('po starcie bramki pierwsze użycie odświeża token i zwraca adres skrzynki', async () => {
    const { f, forms } = fakeFetch([tokenBody(1)]);
    const tokens = new M365Tokens({ accounts, fetch: f });
    expect(await tokens.access(id, T0)).toEqual({ token: 'dostep-1', address: 'alarmy@firma.pl' });
    expect(forms).toHaveLength(1);
    expect(forms[0]!.get('refresh_token')).toBe(OLD_REFRESH);
  });

  it('trzy równoległe wywołania przy wygasającym tokenie wysyłają jedno żądanie do Microsoftu', async () => {
    const { f, forms, release } = fakeFetch([tokenBody(1)], { hold: true });
    const tokens = new M365Tokens({ accounts, fetch: f });
    const all = Promise.all([tokens.access(id, T0), tokens.access(id, T0), tokens.access(id, T0)]);
    release();
    expect((await all).map((a) => a.token)).toEqual(['dostep-1', 'dostep-1', 'dostep-1']);
    expect(forms).toHaveLength(1);
  });

  it('token ważny dłużej niż 5 minut pochodzi z pamięci, krócej ważny jest odświeżany', async () => {
    const { f, forms } = fakeFetch([tokenBody(1, 3600), tokenBody(2, 3600)]);
    const tokens = new M365Tokens({ accounts, fetch: f });
    await tokens.access(id, T0);
    expect((await tokens.access(id, new Date(T0.getTime() + 54 * 60_000))).token).toBe('dostep-1');
    expect(forms).toHaveLength(1);
    expect((await tokens.access(id, new Date(T0.getTime() + 56 * 60_000))).token).toBe('dostep-2');
    expect(forms).toHaveLength(2);
  });

  it('nowy token odświeżania jest zapisany, zanim access zwróci token dostępu', async () => {
    const { f } = fakeFetch([tokenBody(1)]);
    const tokens = new M365Tokens({ accounts, fetch: f });
    const at = new Date(T0.getTime() + 60_000);
    await tokens.access(id, at);
    expect(accounts.refreshToken(id)).toBe('odswiezanie-1');
    expect(accounts.get(id)).toMatchObject({ state: 'connected', lastRefreshAt: at.toISOString() });
  });

  it('invalid_grant przełącza konto w needs_login i wysyła jedno powiadomienie z kluczem awarii', async () => {
    const { f, forms, release } = fakeFetch([REVOKED], { hold: true });
    const notifier = fakeNotifier();
    const tokens = new M365Tokens({ accounts, fetch: f, notifier });
    const all = Promise.allSettled([tokens.access(id, T0), tokens.access(id, T0)]);
    release();
    const results = await all;
    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof M365AuthError && r.reason.kind === 'needs_login')).toBe(true);
    const row = accounts.get(id)!;
    expect(row).toMatchObject({ state: 'needs_login', errorCode: '50173', errorSince: T0.toISOString(), notifiedAt: T0.toISOString() });
    expect(row.errorMessage).not.toContain('Trace ID');
    expect(notifier.calls).toEqual([{
      event: 'm365_disconnected', subjectKey: `m365:${id}`, summary: `Dyżur IT: ${hintFor('50173')}`, now: T0,
      dedupKey: `m365:${id}:${T0.toISOString()}`,
    }]);
    expect(forms).toHaveLength(1);
  });

  it('konto wymagające logowania odmawia bez wołania Microsoftu i bez kolejnego powiadomienia', async () => {
    const { f, forms } = fakeFetch([REVOKED, tokenBody(2)]);
    const notifier = fakeNotifier();
    const tokens = new M365Tokens({ accounts, fetch: f, notifier });
    await caught(tokens.access(id, T0));
    const err = await caught(tokens.access(id, new Date(T0.getTime() + 60_000)));
    expect(err.kind).toBe('needs_login');
    expect(err.code).toBe('50173');
    expect(forms).toHaveLength(1);
    expect(notifier.calls).toHaveLength(1);
  });

  it('odpowiedź 503 ustawia stan error bez powiadomienia, a następne użycie ponawia odświeżenie', async () => {
    const { f, forms } = fakeFetch([{ status: 503, body: null }, tokenBody(2)]);
    const notifier = fakeNotifier();
    const tokens = new M365Tokens({ accounts, fetch: f, notifier });
    expect((await caught(tokens.access(id, T0))).kind).toBe('error');
    expect(accounts.get(id)).toMatchObject({ state: 'error', errorSince: T0.toISOString(), notifiedAt: null });
    expect(notifier.calls).toHaveLength(0);
    expect((await tokens.access(id, new Date(T0.getTime() + 60_000))).token).toBe('dostep-2');
    expect(accounts.get(id)).toMatchObject({ state: 'connected', errorSince: null });
    expect(forms).toHaveLength(2);
  });

  it('konto new albo nieistniejące odmawia z needs_login bez wołania Microsoftu', async () => {
    const { f, forms } = fakeFetch([tokenBody(1)]);
    const tokens = new M365Tokens({ accounts, fetch: f });
    const fresh = accounts.create({ ...INPUT, name: 'Biuro handlowe' }, T0);
    expect((await caught(tokens.access(fresh, T0))).kind).toBe('needs_login');
    expect((await caught(tokens.access(999, T0))).kind).toBe('needs_login');
    expect(forms).toHaveLength(0);
  });

  it('rozłączenie w trakcie odświeżania nie przywraca konta ani tokenu', async () => {
    const { f, release } = fakeFetch([tokenBody(1)], { hold: true });
    const tokens = new M365Tokens({ accounts, fetch: f });
    const pending = tokens.access(id, T0);
    accounts.disconnect(id, T0);
    tokens.forget(id);
    release();
    expect((await caught(pending)).kind).toBe('error');
    expect(accounts.get(id)!.state).toBe('new');
    expect(accounts.refreshToken(id)).toBeNull();
  });

  it('odrzucenie starego tokenu po ponownym logowaniu w trakcie odświeżania nie psuje nowego połączenia', async () => {
    const { f, release } = fakeFetch([REVOKED], { hold: true });
    const notifier = fakeNotifier();
    const tokens = new M365Tokens({ accounts, fetch: f, notifier });
    const pending = tokens.access(id, T0);
    accounts.connected(id, { refreshToken: 'nowe-logowanie', address: 'alarmy@firma.pl', redirectUri: 'http://localhost:8081/m365/powrot', by: 'admin', loginName: 'alarmy@firma.pl', loginOid: null, addressManual: false }, T0);
    release();
    await caught(pending);
    expect(accounts.get(id)!.state).toBe('connected');
    expect(accounts.refreshToken(id)).toBe('nowe-logowanie');
    expect(notifier.calls).toHaveLength(0);
  });

  it('dziennik nie zawiera tokenów', async () => {
    const log = recordingLog();
    const { f } = fakeFetch([tokenBody(1), REVOKED]);
    const tokens = new M365Tokens({ accounts, fetch: f, log });
    await tokens.access(id, T0);
    tokens.forget(id);
    await caught(tokens.access(id, T0));
    const all = log.lines.join('\n');
    for (const secret of [OLD_REFRESH, 'dostep-1', 'odswiezanie-1']) expect(all).not.toContain(secret);
  });
});

describe('M365Tokens.remember i forget', () => {
  it('zapamiętany token służy bez wołania Microsoftu, a forget wymusza odświeżenie', async () => {
    const { f, forms } = fakeFetch([tokenBody(2)]);
    const tokens = new M365Tokens({ accounts, fetch: f });
    tokens.remember(id, { accessToken: 'z-logowania', refreshToken: 'r', expiresAt: new Date(T0.getTime() + 3600_000), claims: null });
    expect((await tokens.access(id, T0)).token).toBe('z-logowania');
    expect(forms).toHaveLength(0);
    tokens.forget(id);
    expect((await tokens.access(id, T0)).token).toBe('dostep-2');
    expect(forms).toHaveLength(1);
  });
});

describe('szczegóły konta po odrzuconym odświeżeniu', () => {
  it('„Ostatni błąd” podaje kod AADSTS jeden raz', async () => {
    const db = openDatabase(':memory:');
    const accounts = new M365AccountsRepo(db, randomBytes(32));
    const fetch: TokenFetch = async () => ({
      status: 400,
      body: { error: 'invalid_grant', error_codes: [50173], error_description: 'AADSTS50173: The provided grant has expired due to it being revoked. Trace ID: 1 Correlation ID: 2 Timestamp: 3' },
    });
    const tokens = new M365Tokens({ accounts, fetch });
    const at = new Date('2026-11-04T12:00:00Z');
    const id = accounts.create({ name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, at);
    accounts.connected(id, {
      refreshToken: 'r', address: 'alarmy@firma.pl', addressManual: false, loginName: 'alarmy@firma.pl', loginOid: null,
      redirectUri: 'http://localhost:8081/m365/powrot', by: 'admin',
    }, at);
    await tokens.access(id, at).catch(() => undefined);
    const html = m365DetailPage({ row: accounts.get(id)!, users: [] }, { redirectUri: 'http://localhost:8081/m365/powrot' });
    expect(html.match(/AADSTS50173/g)).toHaveLength(1);
  });
});

describe('M365Tokens.keepAlive - konto bezczynne nie wygasa', () => {
  const DAY = 86_400_000;
  const at = (ms: number) => new Date(T0.getTime() + ms);

  it('odświeża konto, którego ostatnie odświeżenie jest starsze niż 7 dni, i zapisuje nowy token odświeżania', async () => {
    const fetch = fakeFetch([tokenBody(1)]);
    const tokens = new M365Tokens({ accounts, fetch: fetch.f });
    await tokens.keepAlive(at(6 * DAY));
    expect(fetch.forms).toHaveLength(0);
    await tokens.keepAlive(at(7 * DAY + 1));
    expect(fetch.forms).toHaveLength(1);
    expect(accounts.refreshToken(id)).toBe('odswiezanie-1');
    expect(accounts.get(id)!.lastRefreshAt).toBe(at(7 * DAY + 1).toISOString());
    await tokens.keepAlive(at(8 * DAY));
    expect(fetch.forms).toHaveLength(1);
  });

  it('pomija konta wymagające logowania i nowe, a po nieudanej próbie czeka godzinę', async () => {
    const other = accounts.create({ ...INPUT, name: 'Biuro handlowe' }, T0);
    const fetch = fakeFetch([{ status: 503, body: {} }]);
    const tokens = new M365Tokens({ accounts, fetch: fetch.f });
    await tokens.keepAlive(at(8 * DAY));
    expect(fetch.forms).toHaveLength(1);
    expect(accounts.get(id)!.state).toBe('error');
    expect(accounts.get(other)!.state).toBe('new');
    await tokens.keepAlive(at(8 * DAY + 30 * 60_000));
    expect(fetch.forms).toHaveLength(1);
    await tokens.keepAlive(at(8 * DAY + 61 * 60_000));
    expect(fetch.forms).toHaveLength(2);
    accounts.failed(id, { state: 'needs_login', code: '50173', message: 'odwołane' }, at(9 * DAY));
    await tokens.keepAlive(at(10 * DAY));
    expect(fetch.forms).toHaveLength(2);
  });
});
