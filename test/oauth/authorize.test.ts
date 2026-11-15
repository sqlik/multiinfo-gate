import { createHash, randomBytes } from 'node:crypto';
import fastifyFormbody from '@fastify/formbody';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerOAuthRoutes, type OAuthDeps } from '../../src/oauth/routes.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, oauthDeps, seedAgent } from '../helpers/agent.ts';

const BASE = 'https://bramka.serwis.example';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK = 'http://127.0.0.1:53682/cb';
const INVALID = 'Kod jest nieprawidłowy albo nieaktualny. Poproś administratora bramki o nowy kod.';
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const MIN = 60_000;

let db: Database;
let key: Buffer;
let clock: Date;
let seed: ReturnType<typeof seedAgent>;
let deps: OAuthDeps;
let notify: ReturnType<typeof vi.fn>;
let server: FastifyInstance;

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

beforeEach(async () => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
  clock = new Date(AGENT_SEED_AT.getTime() + MIN);
  seed = seedAgent(db, key, { method: 'oauth', scopes: ['send', 'read_sent'] });
  notify = vi.fn();
  deps = oauthDeps(db, key, { now: () => clock, notifier: { notify } });
  const client = { kind: 'dynamic' as const, sourceIp: '203.0.113.5', createdAt: AGENT_SEED_AT.toISOString(), fetchedAt: null };
  deps.oauth.upsertClient({ ...client, clientId: 'cli_claude', name: 'Claude', redirectUris: [REDIRECT] });
  deps.oauth.upsertClient({ ...client, clientId: 'cli_code', name: 'Claude Code', redirectUris: [LOOPBACK] });
  server = Fastify();
  await server.register(fastifyFormbody);
  registerOAuthRoutes(server, deps);
});

function authorizeUrl(challenge: string, over: Record<string, string | undefined> = {}): string {
  const params: Record<string, string | undefined> = {
    response_type: 'code', client_id: 'cli_claude', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256',
    state: 'st-1', resource: RESOURCE, scope: 'mcp', ...over,
  };
  const defined = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined);
  return `/oauth/authorize?${new URLSearchParams(defined).toString()}`;
}

async function start(challenge: string, over: Record<string, string | undefined> = {}) {
  const res = await server.inject({ method: 'GET', url: authorizeUrl(challenge, over) });
  return { res, requestId: /name="request_id" value="([^"]+)"/.exec(res.body)?.[1] ?? '' };
}

const submit = (requestId: string, code: string, ip = '198.51.100.7') => server.inject({
  method: 'POST', url: '/oauth/authorize', remoteAddress: ip, headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ request_id: requestId, code }).toString(),
});

const errorText = (html: string): string | undefined => /<p class="error"[^>]*>([^<]*)</.exec(html)?.[1];
const returnUrl = (html: string): URL => new URL((/<a href="([^"]+)"/.exec(html)?.[1] ?? '').replaceAll('&amp;', '&'));

const tokenRequest = (form: Record<string, string>) => server.inject({
  method: 'POST', url: '/oauth/token', remoteAddress: '198.51.100.7', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(form).toString(),
});

/** Pełne połączenie: strona z kodem, potwierdzenie, wymiana kodu autoryzacji na tokeny. */
async function connect(code: string, clientId = 'cli_claude', redirect = REDIRECT) {
  const p = pkce();
  const { requestId } = await start(p.challenge, { client_id: clientId, redirect_uri: redirect });
  const page = await submit(requestId, code);
  const back = returnUrl(page.body);
  const res = await tokenRequest({
    grant_type: 'authorization_code', code: back.searchParams.get('code') ?? '', code_verifier: p.verifier, client_id: clientId,
    redirect_uri: redirect, resource: RESOURCE,
  });
  return { page, back, res, tokens: res.json() as Record<string, unknown> };
}

describe('strona połączenia', () => {
  it('strona połączenia z nagłówkami CSP i X-Frame-Options DENY, bez zewnętrznych zasobów', async () => {
    const { res, requestId } = await start(pkce().challenge);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-security-policy']).toBe(CSP);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(res.body).toContain('<strong>Claude</strong>');
    expect(res.body).toContain('<strong>claude.ai</strong>');
    expect(res.body).toMatch(/<input[^>]+name="code"/);
    expect(res.body).toContain('>Połącz</button>');
    expect(res.body).not.toMatch(/<script|<link|<img|src=|url\(/i);
  });

  it('nazwa aplikacji z dokumentu albo rejestracji pokazana jako tekst', async () => {
    deps.oauth.upsertClient({
      clientId: 'cli_zly', kind: 'dynamic', name: '<img src=x onerror=alert(1)>', redirectUris: [REDIRECT], sourceIp: null,
      createdAt: AGENT_SEED_AT.toISOString(), fetchedAt: null,
    });
    const { res } = await start(pkce().challenge, { client_id: 'cli_zly' });
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.body).not.toContain('<img');
  });

  it('nieznany redirect_uri: strona błędu bez przekierowania', async () => {
    const wrong = await start(pkce().challenge, { redirect_uri: 'https://evil.example/cb' });
    expect(wrong.res.statusCode).toBe(400);
    expect(wrong.res.headers.location).toBeUndefined();
    expect(wrong.res.headers['content-security-policy']).toBe(CSP);
    expect(wrong.res.body).toContain('Adres powrotu nie zgadza się');
    expect(wrong.requestId).toBe('');
    const missing = await start(pkce().challenge, { redirect_uri: undefined });
    expect([missing.res.statusCode, missing.res.headers.location]).toEqual([400, undefined]);
    const unknown = await start(pkce().challenge, { client_id: 'cli_nieznany' });
    expect([unknown.res.statusCode, unknown.res.headers.location]).toEqual([400, undefined]);
    expect(unknown.res.body).toContain('Aplikacja nie jest zarejestrowana w bramce');
  });

  it('pozostałe błędy żądania: przekierowanie z error, state i iss', async () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ resource: 'https://inny.example/mcp' }, 'invalid_target'],
    ];
    for (const [over, error] of cases) {
      const { res } = await start(pkce().challenge, over);
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
      expect(location.searchParams.get('error')).toBe(error);
      expect(location.searchParams.get('state')).toBe('st-1');
      expect(location.searchParams.get('iss')).toBe(BASE);
    }
    const withoutResource = await start(pkce().challenge, { resource: undefined });
    expect(withoutResource.res.statusCode).toBe(200);
  });

  it('bez adresu bramki strona błędu 503', async () => {
    const other = Fastify();
    await other.register(fastifyFormbody);
    registerOAuthRoutes(other, oauthDeps(openDatabase(':memory:'), key, { apiUrl: null }));
    const res = await other.inject({ method: 'GET', url: authorizeUrl(pkce().challenge) });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('Adres bramki nie jest ustawiony');
  });

  it('nieznane albo przeterminowane żądanie połączenia: strona z prośbą o ponowne łączenie', async () => {
    const unknown = await submit('nieznane', seed.secret);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toContain('Żądanie połączenia wygasło');
    const { requestId } = await start(pkce().challenge);
    clock = new Date(clock.getTime() + 15 * MIN);
    const late = await submit(requestId, seed.secret);
    expect(late.statusCode).toBe(400);
    expect(late.body).toContain('Żądanie połączenia wygasło');
    expect(deps.connectionsRepo.get(seed.connectionId)!.codeUsedAt).toBeNull();
  });
});

describe('kod jednorazowy', () => {
  it('poprawny kod: strona potwierdzenia z meta refresh, kod autoryzacji wymieniany na parę tokenów', async () => {
    const p = pkce();
    const { requestId } = await start(p.challenge);
    const page = await submit(requestId, seed.secret.toLowerCase().replaceAll('-', ' '));
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toBe(CSP);
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers.location).toBeUndefined();
    expect(page.body).toContain('Ewa Nowak');
    expect(page.body).toContain('Wysyłka SMS-ów');
    expect(page.body).toContain('Odczyt wysłanych');
    expect(page.body).toContain('Wróć do aplikacji');
    const back = returnUrl(page.body);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st-1');
    expect(back.searchParams.get('iss')).toBe(BASE);
    const code = back.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const refresh = /<meta http-equiv="refresh" content="3;url=([^"]+)">/.exec(page.body)?.[1];
    expect(refresh?.replaceAll('&amp;', '&')).toBe(back.toString());

    const connection = deps.connectionsRepo.get(seed.connectionId)!;
    expect(connection).toMatchObject({ clientId: 'cli_claude', clientName: 'Claude', codeUsedAt: clock.toISOString() });
    expect(deps.oauth.getClient('cli_claude')!.connectedAt).toBe(clock.toISOString());

    const res = await tokenRequest({
      grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: 'cli_claude', redirect_uri: REDIRECT, resource: RESOURCE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const tokens = res.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(tokens.access_token).toMatch(/^mig_at_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^mig_rt_[A-Za-z0-9_-]{43}$/);
    expect(deps.connections.authenticate(`Bearer ${tokens.access_token}`, clock)).toEqual({ ok: true, connectionId: seed.connectionId });
  });

  it('ten sam kod drugi raz: ten sam komunikat co kod błędny', async () => {
    const first = await connect(seed.secret);
    expect(first.res.statusCode).toBe(200);
    const again = await submit((await start(pkce().challenge)).requestId, seed.secret);
    const wrong = await submit((await start(pkce().challenge)).requestId, 'AAAA-BBBB-CCCC');
    const garbage = await submit((await start(pkce().challenge)).requestId, 'nie kod');
    for (const res of [again, wrong, garbage]) {
      expect(res.statusCode).toBe(400);
      expect(errorText(res.body)).toBe(INVALID);
      expect(res.body).toMatch(/name="request_id"/);
    }
  });

  it('kod po terminie, odwołane połączenie i wyłączona integracja: ten sam komunikat', async () => {
    clock = new Date(AGENT_SEED_AT.getTime() + 24 * 60 * MIN - 5 * MIN);
    const late = await start(pkce().challenge);
    clock = new Date(AGENT_SEED_AT.getTime() + 24 * 60 * MIN);
    expect(errorText((await submit(late.requestId, seed.secret)).body)).toBe(INVALID);

    clock = new Date(AGENT_SEED_AT.getTime() + MIN);
    const { requestId } = await start(pkce().challenge);
    db.prepare('UPDATE integrations SET enabled = 0 WHERE id = ?').run(seed.integrationId);
    expect(errorText((await submit(requestId, seed.secret)).body)).toBe(INVALID);
    db.prepare('UPDATE integrations SET enabled = 1 WHERE id = ?').run(seed.integrationId);

    seed.service.revoke(seed.connectionId, clock);
    expect(errorText((await submit(requestId, seed.secret)).body)).toBe(INVALID);
    expect(deps.connectionsRepo.get(seed.connectionId)!.codeUsedAt).toBeNull();
  });

  it('jedenasta nieudana próba z adresu: 429, setna globalnie: 429 dla innego adresu', async () => {
    const { requestId } = await start(pkce().challenge);
    for (let n = 0; n < 10; n += 1) expect((await submit(requestId, 'AAAA-BBBB-CCCC', '203.0.113.10')).statusCode).toBe(400);
    const blocked = await submit(requestId, seed.secret, '203.0.113.10');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toContain('Zbyt wiele nieudanych prób');
    expect(deps.connectionsRepo.get(seed.connectionId)!.codeUsedAt).toBeNull();
    // Ta sama sieć IPv6 /64 to jedno źródło.
    for (let n = 0; n < 10; n += 1) await submit(requestId, 'AAAA-BBBB-CCCC', `2001:db8:1:2::${n + 1}`);
    expect((await submit(requestId, 'AAAA-BBBB-CCCC', '2001:db8:1:2::ff')).statusCode).toBe(429);

    for (let ip = 1; ip <= 8; ip += 1) {
      for (let n = 0; n < 10; n += 1) expect((await submit(requestId, 'AAAA-BBBB-CCCC', `198.51.100.${ip}`)).statusCode).toBe(400);
    }
    const global = await submit(requestId, seed.secret, '192.0.2.200');
    expect(global.statusCode).toBe(429);

    clock = new Date(clock.getTime() + 15 * MIN);
    const fresh = await start(pkce().challenge);
    expect((await submit(fresh.requestId, seed.secret, '203.0.113.10')).statusCode).toBe(200);
  });

  it('nowy kod dla aktywnego połączenia: użycie unieważnia stare tokeny', async () => {
    const old = (await connect(seed.secret)).tokens;
    const { code } = seed.service.newCode(seed.connectionId, '24h', clock);
    clock = new Date(clock.getTime() + MIN);
    const fresh = await connect(code, 'cli_code', 'http://127.0.0.1:61000/cb');
    expect(fresh.res.statusCode).toBe(200);
    expect(deps.connectionsRepo.get(seed.connectionId)).toMatchObject({ clientId: 'cli_code', clientName: 'Claude Code' });
    expect(deps.connections.authenticate(`Bearer ${old.access_token as string}`, clock)).toEqual({ ok: false, code: 'invalid' });
    const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: old.refresh_token as string, client_id: 'cli_claude' });
    expect([refresh.statusCode, refresh.json().error]).toEqual([400, 'invalid_grant']);
    expect(deps.connections.authenticate(`Bearer ${fresh.tokens.access_token as string}`, clock).ok).toBe(true);
  });

  it('użycie kodu zapisuje agent.polaczenie i zgłasza agent_connected', async () => {
    await connect(seed.secret);
    const entry = deps.audit.list(10, 0).find((e) => e.action === 'agent.polaczenie');
    expect(entry).toMatchObject({ actor: 'aplikacja', target: 'Agent AI - dyspozytornia / Ewa Nowak', ip: '198.51.100.7' });
    expect(entry!.meta).toMatchObject({ aplikacja: 'Claude', klient: 'cli_claude', zakresy: ['Wysyłka SMS-ów', 'Odczyt wysłanych'] });
    expect(notify).toHaveBeenCalledTimes(1);
    const [event, subject, summary, at] = notify.mock.calls[0]!;
    expect([event, subject, at]).toEqual(['agent_connected', `agent:${seed.connectionId}`, clock]);
    for (const part of ['Agent AI - dyspozytornia', 'Ewa Nowak', 'Claude', '198.51.100.7', 'Wysyłka SMS-ów']) expect(summary).toContain(part);
    const raw = seed.secret.replaceAll('-', '');
    expect(JSON.stringify(entry)).not.toContain(raw);
    expect(summary).not.toContain(raw);
  });
});
