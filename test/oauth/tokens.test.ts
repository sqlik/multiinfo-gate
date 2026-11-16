import { createHash, randomBytes } from 'node:crypto';
import fastifyFormbody from '@fastify/formbody';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { registerOAuthRoutes, type OAuthDeps } from '../../src/oauth/routes.ts';
import { issueAuthCode, pkceMatches } from '../../src/oauth/tokens.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';
import { AGENT_SEED_AT, oauthDeps, seedAgent } from '../helpers/agent.ts';

const BASE = 'https://bramka.serwis.example';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const MIN = 60_000;

let db: Database;
let key: Buffer;
let clock: Date;
let seed: ReturnType<typeof seedAgent>;
let deps: OAuthDeps;
let server: FastifyInstance;

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

beforeEach(async () => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
  clock = new Date(AGENT_SEED_AT.getTime() + MIN);
  seed = seedAgent(db, key, { method: 'oauth' });
  deps = oauthDeps(db, key, { now: () => clock });
  deps.oauth.upsertClient({
    clientId: 'cli_claude', kind: 'dynamic', name: 'Claude', redirectUris: [REDIRECT], sourceIp: null, createdAt: AGENT_SEED_AT.toISOString(), fetchedAt: null,
  });
  deps.connectionsRepo.useCode(seed.connectionId, { clientId: 'cli_claude', clientName: 'Claude' }, clock);
  server = Fastify();
  await server.register(fastifyFormbody);
  registerOAuthRoutes(server, deps);
});

const post = (url: string, form: Record<string, string>, ip = '198.51.100.7') => server.inject({
  method: 'POST', url, remoteAddress: ip, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(form).toString(),
});

/** Kod autoryzacji wydany tak, jak robi to strona połączenia po poprawnym kodzie jednorazowym. */
function authCode(challenge: string): string {
  return issueAuthCode(deps, { connectionId: seed.connectionId, clientId: 'cli_claude', redirectUri: REDIRECT, codeChallenge: challenge, resource: RESOURCE }, clock);
}

async function pair(): Promise<{ access_token: string; refresh_token: string }> {
  const p = pkce();
  const res = await post('/oauth/token', {
    grant_type: 'authorization_code', code: authCode(p.challenge), code_verifier: p.verifier, client_id: 'cli_claude', redirect_uri: REDIRECT,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const refresh = (token: string, over: Record<string, string> = {}) =>
  post('/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: 'cli_claude', ...over });
const errorOf = (res: { statusCode: number; json: () => { error?: string } }) => [res.statusCode, res.json().error];

describe('PKCE', () => {
  it('pkceMatches porównuje skrót SHA-256 w base64url i odrzuca weryfikator spoza RFC 7636', () => {
    const p = pkce();
    expect(pkceMatches(p.verifier, p.challenge)).toBe(true);
    expect(pkceMatches(`${p.verifier}x`, p.challenge)).toBe(false);
    expect(pkceMatches('krótki', createHash('sha256').update('krótki').digest('base64url'))).toBe(false);
    const long = 'a'.repeat(129);
    expect(pkceMatches(long, createHash('sha256').update(long).digest('base64url'))).toBe(false);
  });

  it('PKCE: zły code_verifier daje invalid_grant', async () => {
    const p = pkce();
    const code = authCode(p.challenge);
    const bad = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: 'cli_claude', redirect_uri: REDIRECT });
    expect(errorOf(bad)).toEqual([400, 'invalid_grant']);
    // Kod jest jednorazowy także po nieudanej wymianie.
    const retry = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: 'cli_claude', redirect_uri: REDIRECT });
    expect(errorOf(retry)).toEqual([400, 'invalid_grant']);
  });
});

describe('wymiana kodu autoryzacji', () => {
  it('kod autoryzacji po 61 s daje invalid_grant', async () => {
    const p = pkce();
    const code = authCode(p.challenge);
    clock = new Date(clock.getTime() + 61_000);
    const res = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: 'cli_claude', redirect_uri: REDIRECT });
    expect(errorOf(res)).toEqual([400, 'invalid_grant']);
  });

  it('kod związany z klientem, adresem powrotu i zasobem', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ client_id: 'cli_inny' }, 'invalid_grant'],
      [{ redirect_uri: 'https://claude.ai/inny' }, 'invalid_grant'],
      [{ resource: 'https://inny.example/mcp' }, 'invalid_target'],
    ];
    for (const [over, error] of cases) {
      const p = pkce();
      const res = await post('/oauth/token', {
        grant_type: 'authorization_code', code: authCode(p.challenge), code_verifier: p.verifier, client_id: 'cli_claude', redirect_uri: REDIRECT, ...over,
      });
      expect(errorOf(res)).toEqual([400, error]);
    }
  });

  it('brak parametrów i nieznany rodzaj wymiany', async () => {
    expect(errorOf(await post('/oauth/token', { grant_type: 'password', username: 'x', password: 'y' }))).toEqual([400, 'unsupported_grant_type']);
    expect(errorOf(await post('/oauth/token', { grant_type: 'authorization_code', client_id: 'cli_claude' }))).toEqual([400, 'invalid_request']);
    expect(errorOf(await post('/oauth/token', {}))).toEqual([400, 'invalid_request']);
  });

  it('para tokenów z nagłówkiem no-store, w bazie wyłącznie skróty', async () => {
    const tokens = await pair();
    const stored = JSON.stringify(db.prepare('SELECT * FROM oauth_tokens').all());
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
    const rows = db.prepare('SELECT kind, expires_at FROM oauth_tokens ORDER BY kind').all();
    // Token odświeżania żyje tyle, co połączenie: 90 dni od założenia.
    expect(rows).toEqual([
      { kind: 'access', expires_at: new Date(clock.getTime() + 3_600_000).toISOString() },
      { kind: 'refresh', expires_at: new Date(AGENT_SEED_AT.getTime() + 90 * 86_400_000).toISOString() },
    ]);
  });

  it('sześćdziesiąte pierwsze żądanie tokenu w minucie z adresu daje 429', async () => {
    for (let n = 0; n < 60; n += 1) expect((await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'mig_rt_x' })).statusCode).toBe(400);
    const limited = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'mig_rt_x' });
    expect(limited.statusCode).toBe(429);
    expect((await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'mig_rt_x' }, '203.0.113.99')).statusCode).toBe(400);
  });
});

describe('odświeżanie', () => {
  it('rotacja: zużyty token odświeżania w 60 s zwraca tę samą parę, po 61 s odwołuje połączenie', async () => {
    const first = await pair();
    const second = await refresh(first.refresh_token);
    expect(second.statusCode).toBe(200);
    expect(second.headers['cache-control']).toBe('no-store');
    const next = second.json();
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(deps.connections.authenticate(`Bearer ${next.access_token}`, clock).ok).toBe(true);

    clock = new Date(clock.getTime() + 30_000);
    const parallel = await refresh(first.refresh_token);
    expect(parallel.statusCode).toBe(200);
    expect(parallel.json()).toEqual(next);

    clock = new Date(clock.getTime() + 31_000);
    const reuse = await refresh(first.refresh_token);
    expect(errorOf(reuse)).toEqual([400, 'invalid_grant']);
    expect(deps.connectionsRepo.get(seed.connectionId)).toMatchObject({ revokedAt: clock.toISOString(), revokedReason: 'reuse' });
    expect(deps.connections.authenticate(`Bearer ${next.access_token}`, clock)).toEqual({ ok: false, code: 'invalid' });
    const entry = deps.audit.list(10, 0).find((e) => e.action === 'agent.odwolanie');
    expect(entry).toMatchObject({ actor: 'aplikacja', target: 'Agent AI - dyspozytornia / Ewa Nowak' });
    expect(JSON.stringify(entry)).not.toContain(first.refresh_token);
  });

  it('nowy token odświeżania działa, a token dostępu wygasa po godzinie', async () => {
    const first = await pair();
    clock = new Date(clock.getTime() + 3_600_000);
    expect(deps.connections.authenticate(`Bearer ${first.access_token}`, clock)).toEqual({ ok: false, code: 'invalid' });
    const next = await refresh(first.refresh_token);
    expect(next.statusCode).toBe(200);
    expect(deps.connections.authenticate(`Bearer ${next.json().access_token}`, clock).ok).toBe(true);
  });

  it('token odświeżania innego klienta, nieznany albo token dostępu w miejscu odświeżania: invalid_grant', async () => {
    const first = await pair();
    expect(errorOf(await refresh(first.refresh_token, { client_id: 'cli_inny' }))).toEqual([400, 'invalid_grant']);
    expect(errorOf(await refresh(first.access_token))).toEqual([400, 'invalid_grant']);
    expect(errorOf(await refresh('mig_rt_nieznany'))).toEqual([400, 'invalid_grant']);
    expect(deps.connectionsRepo.get(seed.connectionId)!.revokedAt).toBeNull();
  });

  it('ważność odświeżania liczona przy każdym żądaniu: koniec klucza zatrzymuje, przedłużenie klucza przywraca', async () => {
    const first = await pair();
    db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(new Date(clock.getTime() - 1000).toISOString(), seed.keyId);
    expect(errorOf(await refresh(first.refresh_token))).toEqual([400, 'invalid_grant']);
    const extended = new Date(clock.getTime() + 10 * 86_400_000).toISOString();
    db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(extended, seed.keyId);
    const res = await refresh(first.refresh_token);
    expect(res.statusCode).toBe(200);
    const row = db.prepare("SELECT expires_at FROM oauth_tokens WHERE kind = 'refresh' AND rotated_at IS NULL").get() as { expires_at: string };
    expect(row.expires_at).toBe(extended);
  });

  it('odwołane połączenie: invalid_grant', async () => {
    const first = await pair();
    seed.service.revoke(seed.connectionId, clock);
    expect(errorOf(await refresh(first.refresh_token))).toEqual([400, 'invalid_grant']);
  });
});

describe('odwołanie tokenu przez aplikację', () => {
  it('revoke tokenu odświeżania usuwa oba tokeny, połączenie zostaje nieodwołane', async () => {
    const first = await pair();
    const res = await post('/oauth/revoke', { token: first.refresh_token, token_type_hint: 'refresh_token' });
    expect(res.statusCode).toBe(200);
    expect(deps.connections.authenticate(`Bearer ${first.access_token}`, clock)).toEqual({ ok: false, code: 'invalid' });
    expect(errorOf(await refresh(first.refresh_token))).toEqual([400, 'invalid_grant']);
    expect(deps.connectionsRepo.get(seed.connectionId)!.revokedAt).toBeNull();
  });

  it('revoke tokenu dostępu usuwa tylko jego, nieznany token daje 200', async () => {
    const first = await pair();
    expect((await post('/oauth/revoke', { token: first.access_token })).statusCode).toBe(200);
    expect(deps.connections.authenticate(`Bearer ${first.access_token}`, clock)).toEqual({ ok: false, code: 'invalid' });
    expect((await refresh(first.refresh_token)).statusCode).toBe(200);
    expect((await post('/oauth/revoke', { token: 'mig_at_nieznany' })).statusCode).toBe(200);
    expect((await post('/oauth/revoke', {})).statusCode).toBe(200);
  });

  it('punkty tokenu i odwołania odpowiadają na zapytanie wstępne CORS', async () => {
    for (const url of ['/oauth/token', '/oauth/revoke', '/oauth/register']) {
      const res = await server.inject({ method: 'OPTIONS', url, headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'POST' } });
      expect([res.statusCode, res.headers['access-control-allow-origin']]).toEqual([204, '*']);
    }
  });
});

describe('dziennik błędów serwera API', () => {
  it('log błędu API nie zawiera tokenu z adresu /pobierz/ ani zapytania', async () => {
    const error = vi.fn();
    const app = buildApiServer({
      accounts: new AccountsRepo(db, key), apiKeys: new ApiKeysRepo(db, key), messages: new MessagesRepo(db), jobs: new JobsRepo(db),
      events: new MessageEventsRepo(db), packages: new PackagesRepo(db), clients: {} as never, inbound: new InboundMessagesRepo(db),
      rateLimiter: new RateLimiter(), ...integrationDeps(db, key), log: { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    });
    app.get('/pobierz/:token', async () => { throw new Error('awaria odczytu'); });
    app.get('/v1/awaria', async () => { throw new Error('awaria odczytu'); });
    expect((await app.inject({ method: 'GET', url: '/pobierz/dl_Sekretny4Token9?klucz=tajne' })).statusCode).toBe(500);
    expect((await app.inject({ method: 'GET', url: '/v1/awaria?numer=48601000011' })).statusCode).toBe(500);
    const logged = JSON.stringify(error.mock.calls.map(([event, data]) => [event, (data as { url: string }).url]));
    expect(logged).toBe(JSON.stringify([['api.wyjatek', '/pobierz/…'], ['api.wyjatek', '/v1/awaria']]));
  });
});
