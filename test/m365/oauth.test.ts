import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  M365AuthError, M365_IMAP, M365_SCOPES, M365_SMTP, aadstsCode, addressFromClaims, authorizeUrl, fetchToken, hintFor,
  pkcePair, redeemCode, refreshTokens, validClientId, validTenant, type TokenFetch,
} from '../../src/m365/oauth.ts';

const NOW = new Date('2026-11-04T12:00:00Z');
const TENANT = 'firma.onmicrosoft.com';
const GUID = 'ae2e1bd7-666a-41db-82ce-3661a1afd121';
const CLIENT = '11111111-2222-3333-4444-555555555555';
const REDIRECT = 'http://localhost:8081/m365/powrot';
const SCOPE_IN_RESPONSE = 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send';

/** Atrapa id_token: nagłówek, roszczenia, pusty podpis. Bramka nie sprawdza podpisu (spec 5.3). */
function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.`;
}

function okBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token_type: 'Bearer', scope: SCOPE_IN_RESPONSE, expires_in: 4732, ext_expires_in: 4732,
    access_token: 'token-dostepu-abc', refresh_token: 'token-odswiezania-xyz',
    id_token: idToken({ tid: GUID, email: 'alarmy@firma.pl', preferred_username: 'alarmy@firma.pl' }),
    ...over,
  };
}

/** Atrapa TokenFetch zapisująca wywołania. */
function fake(status: number, body: unknown): TokenFetch & { calls: { url: string; form: URLSearchParams }[] } {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const f = (async (url: string, form: URLSearchParams) => {
    calls.push({ url, form });
    return { status, body };
  }) as TokenFetch & { calls: typeof calls };
  f.calls = calls;
  return f;
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

const REFRESH = { tenant: TENANT, clientId: CLIENT, refreshToken: 'stary-token-odswiezania' };
const REDEEM = { tenant: TENANT, clientId: CLIENT, redirectUri: REDIRECT, code: 'kod-autoryzacji', verifier: 'weryfikator-pkce' };

describe('stałe połączeń', () => {
  it('zakres jest dokładnie zakresem z ograniczeń globalnych, z profile', () => {
    expect(M365_SCOPES).toBe(
      'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
    );
  });

  it('IMAP i SMTP wskazują wyłącznie serwery Microsoftu', () => {
    expect(M365_IMAP).toEqual({ host: 'outlook.office365.com', port: 993, security: 'tls', verifyCert: true });
    expect(M365_SMTP).toEqual({ host: 'smtp.office365.com', port: 587, security: 'starttls' });
  });
});

describe('validTenant i validClientId', () => {
  it('przyjmuje domenę katalogu i identyfikator GUID', () => {
    expect(validTenant('firma.onmicrosoft.com')).toBe(true);
    expect(validTenant('firma.pl')).toBe(true);
    expect(validTenant(GUID)).toBe(true);
    expect(validTenant(GUID.toUpperCase())).toBe(true);
  });

  it('odrzuca ukośniki, znaki zapytania, kropki na brzegach i pusty napis', () => {
    for (const t of ['evil.com/x', 'a?b', '../x', '', '.firma.pl', 'firma.pl.', 'firma..pl', 'firma', 'fir ma.pl', 'firma.pl#x', 'a@b.pl', 'x'.repeat(250) + '.pl']) {
      expect(validTenant(t), t).toBe(false);
    }
  });

  it('identyfikator aplikacji musi być identyfikatorem GUID', () => {
    expect(validClientId(CLIENT)).toBe(true);
    expect(validClientId('firma.onmicrosoft.com')).toBe(false);
    expect(validClientId(`${CLIENT}x`)).toBe(false);
    expect(validClientId('')).toBe(false);
  });
});

describe('pkcePair', () => {
  it('challenge jest skrótem SHA-256 weryfikatora w base64url', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('każda para jest inna', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });
});

describe('authorizeUrl', () => {
  it('prowadzi do punktu autoryzacji katalogu ze wszystkimi parametrami PKCE', () => {
    const u = new URL(authorizeUrl({ tenant: TENANT, clientId: CLIENT, redirectUri: REDIRECT, state: 'stan-1', challenge: 'wyzwanie' }));
    expect(u.origin).toBe('https://login.microsoftonline.com');
    expect(u.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: CLIENT, response_type: 'code', redirect_uri: REDIRECT, response_mode: 'query', scope: M365_SCOPES,
      state: 'stan-1', code_challenge: 'wyzwanie', code_challenge_method: 'S256', prompt: 'select_account',
    });
  });

  it('odrzuca nieprawidłowy identyfikator katalogu, zamiast zbudować adres innego hosta', () => {
    expect(() => authorizeUrl({ tenant: 'evil.com/x', clientId: CLIENT, redirectUri: REDIRECT, state: 's', challenge: 'c' })).toThrow();
  });
});

describe('redeemCode', () => {
  it('wysyła wymianę kodu z PKCE do punktu tokenów katalogu, bez sekretu klienta', async () => {
    const f = fake(200, okBody());
    await redeemCode(f, REDEEM, NOW);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(Object.fromEntries(f.calls[0]!.form)).toEqual({
      client_id: CLIENT, grant_type: 'authorization_code', code: 'kod-autoryzacji', redirect_uri: REDIRECT,
      code_verifier: 'weryfikator-pkce', scope: M365_SCOPES,
    });
    expect(f.calls[0]!.form.has('client_secret')).toBe(false);
  });

  it('zwraca tokeny, czas wygaśnięcia i roszczenia z id_token', async () => {
    const set = await redeemCode(fake(200, okBody()), REDEEM, NOW);
    expect(set).toEqual({
      accessToken: 'token-dostepu-abc', refreshToken: 'token-odswiezania-xyz',
      expiresAt: new Date(NOW.getTime() + 4732_000),
      claims: { tid: GUID, email: 'alarmy@firma.pl', preferred_username: 'alarmy@firma.pl' },
    });
  });

  it('przyjmuje zakres w odpowiedzi bez offline_access, openid, email i profile', async () => {
    const set = await redeemCode(fake(200, okBody({ scope: SCOPE_IN_RESPONSE })), REDEEM, NOW);
    expect(set.refreshToken).toBe('token-odswiezania-xyz');
  });

  it('bez id_token albo z uszkodzonym id_token roszczenia są puste', async () => {
    expect((await redeemCode(fake(200, okBody({ id_token: undefined })), REDEEM, NOW)).claims).toBeNull();
    expect((await redeemCode(fake(200, okBody({ id_token: 'a.!!!.b' })), REDEEM, NOW)).claims).toBeNull();
  });

  it('odczytuje oid, czyli trwały identyfikator konta w katalogu', async () => {
    const set = await redeemCode(fake(200, okBody({ id_token: idToken({ tid: GUID, oid: 'f1e2d3c4-0000-1111-2222-333344445555', preferred_username: 'alarmy@firma.pl' }) })), REDEEM, NOW);
    expect(set.claims).toEqual({ tid: GUID, oid: 'f1e2d3c4-0000-1111-2222-333344445555', preferred_username: 'alarmy@firma.pl' });
  });

  it('pomija roszczenia, które nie są napisami', async () => {
    const set = await redeemCode(fake(200, okBody({ id_token: idToken({ tid: 5, oid: 7, email: 'alarmy@firma.pl' }) })), REDEEM, NOW);
    expect(set.claims).toEqual({ email: 'alarmy@firma.pl' });
  });

  it('odpowiedź bez tokenu odświeżania jest błędem', async () => {
    const err = await caught(redeemCode(fake(200, okBody({ refresh_token: undefined })), REDEEM, NOW));
    expect(err.kind).toBe('error');
  });

  it('odpowiedź bez tokenu dostępu albo bez czasu ważności jest błędem', async () => {
    expect((await caught(redeemCode(fake(200, okBody({ access_token: '' })), REDEEM, NOW))).kind).toBe('error');
    expect((await caught(redeemCode(fake(200, okBody({ expires_in: undefined })), REDEEM, NOW))).kind).toBe('error');
  });

  it('nieprawidłowy katalog przerywa bez wołania Microsoftu', async () => {
    const f = fake(200, okBody());
    const err = await caught(redeemCode(f, { ...REDEEM, tenant: 'evil.com/x' }, NOW));
    expect(err.kind).toBe('error');
    expect(f.calls).toHaveLength(0);
  });
});

describe('refreshTokens', () => {
  it('wysyła odświeżenie z zakresem i bez sekretu klienta', async () => {
    const f = fake(200, okBody());
    await refreshTokens(f, REFRESH, NOW);
    expect(f.calls[0]!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(Object.fromEntries(f.calls[0]!.form)).toEqual({
      client_id: CLIENT, grant_type: 'refresh_token', refresh_token: 'stary-token-odswiezania', scope: M365_SCOPES,
    });
  });

  it('zwraca nowy token odświeżania przy zakresie w odpowiedzi bez offline_access', async () => {
    const set = await refreshTokens(fake(200, okBody({ scope: SCOPE_IN_RESPONSE, expires_in: 4400 })), REFRESH, NOW);
    expect(set.refreshToken).toBe('token-odswiezania-xyz');
    expect(set.expiresAt).toEqual(new Date(NOW.getTime() + 4400_000));
  });

  it('brak tokenu odświeżania w odpowiedzi jest błędem', async () => {
    expect((await caught(refreshTokens(fake(200, okBody({ refresh_token: undefined })), REFRESH, NOW))).kind).toBe('error');
  });

  it('invalid_grant z AADSTS50173 wymaga logowania, z kodem i komunikatem bez identyfikatorów śledzenia', async () => {
    const err = await caught(refreshTokens(fake(400, {
      error: 'invalid_grant',
      error_description: "AADSTS50173: The provided grant has expired due to it being revoked, a fresh auth token is needed. "
        + "The user might have changed or reset their password.\r\nTrace ID: 0f1e-trace\r\nCorrelation ID: 9a8b-corr\r\n"
        + 'Timestamp: 2026-11-04 10:17:56Z',
      error_codes: [50173],
    }), REFRESH, NOW));
    expect(err.kind).toBe('needs_login');
    expect(err.code).toBe('50173');
    expect(err.message).toContain('AADSTS50173: The provided grant has expired');
    expect(err.message).not.toMatch(/Trace ID|Correlation ID|Timestamp|0f1e-trace|9a8b-corr/);
  });

  it('pokrewne odrzucenia też wymagają logowania', async () => {
    for (const error of ['interaction_required', 'consent_required', 'invalid_client', 'unauthorized_client']) {
      for (const status of [400, 401]) {
        const err = await caught(refreshTokens(fake(status, { error, error_description: 'AADSTS65001: consent' }), REFRESH, NOW));
        expect(err.kind, `${status} ${error}`).toBe('needs_login');
      }
    }
  });

  it('kod odczytuje z error_codes, gdy opis go nie zawiera', async () => {
    const err = await caught(refreshTokens(fake(400, { error: 'invalid_grant', error_codes: [700082] }), REFRESH, NOW));
    expect(err.code).toBe('700082');
    expect(err.message).toContain('invalid_grant');
  });

  it('inne błędy 400 są błędem, nie wymagają logowania', async () => {
    const err = await caught(refreshTokens(fake(400, { error: 'invalid_request', error_description: 'AADSTS90014: missing' }), REFRESH, NOW));
    expect(err.kind).toBe('error');
    expect(err.code).toBe('90014');
  });

  it('503 jest błędem z numerem odpowiedzi', async () => {
    const err = await caught(refreshTokens(fake(503, null), REFRESH, NOW));
    expect(err.kind).toBe('error');
    expect(err.code).toBeNull();
    expect(err.message).toContain('503');
  });

  it('odrzucony fetch jest błędem', async () => {
    const f: TokenFetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); };
    const err = await caught(refreshTokens(f, REFRESH, NOW));
    expect(err.kind).toBe('error');
    expect(err.message).toContain('login.microsoftonline.com');
  });

  it('przekroczony czas jest błędem z opisem', async () => {
    const f: TokenFetch = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
    const err = await caught(refreshTokens(f, REFRESH, NOW));
    expect(err.kind).toBe('error');
    expect(err.message).toContain('15 s');
  });

  it('żaden komunikat błędu nie zawiera tokenu odświeżania', async () => {
    const f: TokenFetch = async () => { throw new Error(`fetch failed: ${REFRESH.refreshToken}`); };
    const err = await caught(refreshTokens(f, REFRESH, NOW));
    expect(err.message).not.toContain(REFRESH.refreshToken);
  });
});

describe('fetchToken', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('wysyła formularz metodą POST z limitem czasu i bez podążania za przekierowaniem', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: 'a' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const res = await fetchToken('https://login.microsoftonline.com/x.pl/oauth2/v2.0/token', new URLSearchParams({ a: '1' }));
    expect(res).toEqual({ status: 200, body: { access_token: 'a' } });
    expect(calls[0]!.init.method).toBe('POST');
    expect(String(calls[0]!.init.body)).toBe('a=1');
    expect(new Headers(calls[0]!.init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init.redirect).toBe('error');
  });

  it('odmawia połączenia z hostem innym niż login.microsoftonline.com', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => { called = true; return new Response('{}'); });
    await expect(fetchToken('https://evil.example/oauth2/v2.0/token', new URLSearchParams())).rejects.toThrow();
    await expect(fetchToken('http://login.microsoftonline.com/x.pl/oauth2/v2.0/token', new URLSearchParams())).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('odpowiedź, która nie jest JSON-em, zwraca pusty body', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>Service Unavailable</html>', { status: 503 }));
    expect(await fetchToken('https://login.microsoftonline.com/x.pl/oauth2/v2.0/token', new URLSearchParams())).toEqual({ status: 503, body: null });
  });
});

describe('aadstsCode', () => {
  it('odczytuje numer kodu z opisu Microsoftu', () => {
    expect(aadstsCode('AADSTS50173: The provided grant has expired')).toBe('50173');
    expect(aadstsCode('Error: AADSTS7000112: Application is disabled.')).toBe('7000112');
    expect(aadstsCode('bez kodu')).toBeNull();
  });
});

describe('hintFor', () => {
  const codes = ['50173', '50133', '700082', '50076', '50079', '53003', '65001', '7000112', '700016', '50011'];

  it('każdy kod ze specyfikacji ma własną podpowiedź, różną od ogólnej', () => {
    const general = hintFor(null);
    for (const c of codes) expect(hintFor(c), c).not.toBe(general);
    expect(hintFor('99999')).toBe(general);
  });

  it('podpowiedzi są zgodne z kanonem: bez kropki na końcu, bez długich myślników, bez przecinka przed „i”', () => {
    for (const c of [...codes, null]) {
      const h = hintFor(c);
      expect(h.length, String(c)).toBeGreaterThan(20);
      expect(h, String(c)).not.toMatch(/\.$|[\u2014\u2013]|, i |\(|;/);
    }
  });
});

describe('hintFor na stronie konta', () => {
  const codes = ['50173', '50133', '700082', '50076', '50079', '53003', '65001', '7000112', '700016', '50011', null];

  it('bez odesłania do szczegółów konta, bo administrator już na nich jest; powiadomienie zachowuje odesłanie', () => {
    for (const c of codes) expect(hintFor(c, 'account'), String(c)).not.toContain('w szczegółach konta');
    expect(hintFor('50173', 'account')).toBe('Microsoft unieważnił logowanie po zmianie hasła konta albo odwołaniu sesji, dlatego należy kliknąć „Zaloguj ponownie”');
    expect(hintFor('50173')).toBe('Microsoft unieważnił logowanie po zmianie hasła konta albo odwołaniu sesji, dlatego należy kliknąć „Zaloguj ponownie” w szczegółach konta');
    expect(hintFor('53003', 'account')).toBe(hintFor('53003'));
  });
});

describe('addressFromClaims', () => {
  it('woli email, potem preferred_username, zawsze małymi literami', () => {
    expect(addressFromClaims({ preferred_username: 'Alarmy@Firma.pl' })).toBe('alarmy@firma.pl');
    expect(addressFromClaims({ email: 'Dyzur@Firma.pl', preferred_username: 'ts@firma.onmicrosoft.com' })).toBe('dyzur@firma.pl');
  });

  it('bez adresu zwraca null', () => {
    expect(addressFromClaims(null)).toBeNull();
    expect(addressFromClaims({})).toBeNull();
    expect(addressFromClaims({ preferred_username: '+48601000123' })).toBeNull();
  });
});
