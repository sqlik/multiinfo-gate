// Odporność serwera OAuth na nadużycia: limity pobrań i żądań, sprzątanie klientów, kod autoryzacji
// jednorazowy z odwołaniem przy ponownym użyciu, strony błędów zamiast przekierowań i niepodzielne użycie kodu.
import { createHash, randomBytes } from 'node:crypto';
import fastifyFormbody from '@fastify/formbody';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerClient, resolveClient, type MetadataFetch } from '../../src/oauth/clients.ts';
import { registerOAuthRoutes, type OAuthDeps } from '../../src/oauth/routes.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, oauthDeps, seedAgent } from '../helpers/agent.ts';

const BASE = 'https://bramka.serwis.example';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const MIN = 60_000;
const DAY = 86_400_000;

let db: Database;
let key: Buffer;
let clock: Date;
let seed: ReturnType<typeof seedAgent>;
let deps: OAuthDeps;
let server: FastifyInstance;
let fetches: string[];

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** Dokument metadanych klienta: każdy adres pod domeną napastnika zwraca poprawny dokument z 10 adresami powrotu. */
const attackerDocs: MetadataFetch = async (url) => {
  fetches.push(url);
  const pad = 'x'.repeat(1500);
  return {
    status: 200,
    body: JSON.stringify({ client_id: url, client_name: 'Claude', redirect_uris: Array.from({ length: 10 }, (_, i) => `https://napastnik.example/${i}/${pad}`) }),
  };
};

beforeEach(async () => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
  clock = new Date(AGENT_SEED_AT.getTime() + MIN);
  fetches = [];
  seed = seedAgent(db, key, { method: 'oauth', scopes: ['send', 'read_sent'] });
  deps = { ...oauthDeps(db, key, { now: () => clock, fetchMetadata: attackerDocs }), notifier: { notify: vi.fn() } as never };
  const client = { kind: 'dynamic' as const, sourceIp: '203.0.113.5', createdAt: AGENT_SEED_AT.toISOString(), fetchedAt: null };
  deps.oauth.upsertClient({ ...client, clientId: 'cli_claude', name: 'Claude', redirectUris: [REDIRECT] });
  server = Fastify();
  await server.register(fastifyFormbody);
  registerOAuthRoutes(server, deps);
});

function authorizeUrl(challenge: string, over: Record<string, string | undefined> = {}): string {
  const params: Record<string, string | undefined> = {
    response_type: 'code', client_id: 'cli_claude', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256',
    state: 'st-1', resource: RESOURCE, ...over,
  };
  const defined = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined);
  return `/oauth/authorize?${new URLSearchParams(defined).toString()}`;
}

async function start(challenge: string, over: Record<string, string | undefined> = {}, ip = '198.51.100.7') {
  const res = await server.inject({ method: 'GET', url: authorizeUrl(challenge, over), remoteAddress: ip });
  return { res, requestId: /name="request_id" value="([^"]+)"/.exec(res.body)?.[1] ?? '' };
}

const submit = (requestId: string, code: string, ip = '198.51.100.7') => server.inject({
  method: 'POST', url: '/oauth/authorize', remoteAddress: ip, headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ request_id: requestId, code }).toString(),
});

const returnUrl = (html: string): URL => new URL((/<a href="([^"]+)"/.exec(html)?.[1] ?? '').replaceAll('&amp;', '&'));

const tokenRequest = (form: Record<string, string>) => server.inject({
  method: 'POST', url: '/oauth/token', remoteAddress: '198.51.100.7', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(form).toString(),
});

async function connect(code: string, clientId = 'cli_claude', redirect = REDIRECT) {
  const p = pkce();
  const { requestId } = await start(p.challenge, { client_id: clientId, redirect_uri: redirect });
  const page = await submit(requestId, code);
  const back = returnUrl(page.body);
  const authCode = back.searchParams.get('code') ?? '';
  const form = { grant_type: 'authorization_code', code: authCode, code_verifier: p.verifier, client_id: clientId, redirect_uri: redirect, resource: RESOURCE };
  const res = await tokenRequest(form);
  return { page, form, res, tokens: res.json() as Record<string, string> };
}


const docUrl = (n: number) => `https://napastnik.example/doc/${n}`;

describe('dokumenty metadanych klienta', () => {
  it('pobranie nowych dokumentów jest ograniczone: 10 na źródło i 100 łącznie na godzinę', async () => {
    for (let n = 0; n < 30; n += 1) await start(pkce().challenge, { client_id: docUrl(n), redirect_uri: 'https://napastnik.example/0/x' }, '203.0.113.66');
    expect(fetches).toHaveLength(10);
    for (let n = 30; n < 300; n += 1) {
      await start(pkce().challenge, { client_id: docUrl(n), redirect_uri: 'https://napastnik.example/0/x' }, `10.${Math.floor(n / 250)}.${n % 250}.1`);
    }
    expect(fetches.length).toBeLessThanOrEqual(100);
    const blocked = await start(pkce().challenge, { client_id: docUrl(5000), redirect_uri: 'https://napastnik.example/0/x' }, '198.51.100.99');
    expect(blocked.res.statusCode).toBe(429);
  });

  /** Wyczerpanie limitu łącznego przez obcego ze 150 adresów po dobie od pierwszego pobrania dokumentu 0. */
  async function exhaustAfterDay(): Promise<void> {
    await start(pkce().challenge, { client_id: docUrl(0), redirect_uri: 'https://napastnik.example/0/x' }, '198.51.100.7');
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    for (let n = 1; n <= 150; n += 1) {
      await start(pkce().challenge, { client_id: docUrl(n), redirect_uri: 'https://napastnik.example/0/x' }, `10.0.${n}.9`);
    }
  }

  it('aplikacja połączona kodem odświeża dokument także po wyczerpaniu limitu łącznego przez obcych', async () => {
    await exhaustAfterDay();
    deps.oauth.markConnected(docUrl(0), clock);
    const before = fetches.length;
    const known = await start(pkce().challenge, { client_id: docUrl(0), redirect_uri: 'https://napastnik.example/0/x' }, '198.51.100.7');
    expect(known.res.statusCode).not.toBe(429);
    expect(fetches).toHaveLength(before + 1);
  });

  it('dokument zapisany bez połączenia podlega limitom jak nowy', async () => {
    await exhaustAfterDay();
    const before = fetches.length;
    const stale = await start(pkce().challenge, { client_id: docUrl(0), redirect_uri: 'https://napastnik.example/0/x' }, '198.51.100.7');
    expect(stale.res.statusCode).toBe(429);
    expect(fetches).toHaveLength(before);
  });

  it('nieudane odświeżenie dokumentu połączonej aplikacji zostawia zapisany dokument', async () => {
    await start(pkce().challenge, { client_id: docUrl(0), redirect_uri: 'https://napastnik.example/0/x' }, '198.51.100.7');
    deps.oauth.markConnected(docUrl(0), clock);
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    deps = { ...deps, fetchMetadata: async (url) => { fetches.push(url); return { status: 503, body: '' }; } };
    const client = await resolveClient(deps, docUrl(0), '198.51.100.7', clock);
    expect(client).toMatchObject({ clientId: docUrl(0), kind: 'metadata' });
    expect(await resolveClient(deps, docUrl(0), '198.51.100.7', clock)).toMatchObject({ clientId: docUrl(0) });
    expect(fetches).toHaveLength(2);
  });

  it('żądanie bez poprawnego adresu powrotu nie pobiera dokumentu', async () => {
    await start(pkce().challenge, { client_id: docUrl(1), redirect_uri: undefined }, '203.0.113.66');
    await start(pkce().challenge, { client_id: docUrl(2), redirect_uri: 'javascript:alert(1)' }, '203.0.113.66');
    expect(fetches).toHaveLength(0);
  });

  it('nieudane pobranie zostaje zapamiętane, więc ponowienie nie pobiera dokumentu drugi raz', async () => {
    deps = { ...deps, fetchMetadata: async (url) => { fetches.push(url); return { status: 404, body: '' }; } };
    server = Fastify();
    await server.register(fastifyFormbody);
    registerOAuthRoutes(server, deps);
    const first = await start(pkce().challenge, { client_id: docUrl(1) }, '203.0.113.66');
    const again = await start(pkce().challenge, { client_id: docUrl(1) }, '203.0.113.67');
    expect(first.res.statusCode).toBe(400);
    expect(again.res.body).toContain('404');
    expect(fetches).toHaveLength(1);
  });

  it('klient z dokumentu bez połączenia znika po dobie od pobrania, a klient połączenia zostaje', async () => {
    for (let n = 0; n < 5; n += 1) await start(pkce().challenge, { client_id: docUrl(n), redirect_uri: 'https://napastnik.example/0/x' }, '203.0.113.66');
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE kind = 'metadata'").get() as { n: number }).n;
    expect(count()).toBe(5);
    db.prepare('UPDATE agent_connections SET client_id = ? WHERE id = ?').run(docUrl(0), seed.connectionId);
    deps.oauth.prune(new Date(clock.getTime() + 2 * DAY));
    expect(count()).toBe(1);
  });
});

describe('oczekujące żądania połączenia', () => {
  it('seria żądań z jednego adresu dostaje 429 i nie wypiera żądania pracownika', async () => {
    const { requestId } = await start(pkce().challenge);
    let limited = 0;
    for (let n = 0; n < 1000; n += 1) if ((await start(pkce().challenge, {}, '203.0.113.66')).res.statusCode === 429) limited += 1;
    expect(limited).toBeGreaterThan(900);
    const res = await submit(requestId, seed.secret);
    expect(res.statusCode).toBe(200);
  });
});

describe('limit łączny nieudanych kodów', () => {
  it('100 błędnych kodów z 10 adresów nie blokuje pracownika z poprawnym kodem', async () => {
    const attacker = await start(pkce().challenge, {}, '203.0.113.66');
    for (let ip = 1; ip <= 10; ip += 1) {
      for (let n = 0; n < 10; n += 1) await submit(attacker.requestId, 'AAAA-BBBB-CCCC', `192.0.2.${ip}`);
    }
    const employee = await start(pkce().challenge, {}, '198.51.100.7');
    expect((await submit(employee.requestId, seed.secret, '198.51.100.7')).statusCode).toBe(200);
  });

  it('5000 nieudanych kodów wstrzymuje sprawdzanie i raz zgłasza to administratorowi', async () => {
    const attacker = await start(pkce().challenge, {}, '203.0.113.66');
    for (let ip = 0; ip < 500; ip += 1) {
      for (let n = 0; n < 10; n += 1) await submit(attacker.requestId, 'AAAA-BBBB-CCCC', `10.${Math.floor(ip / 250)}.${ip % 250}.1`);
    }
    const employee = await start(pkce().challenge, {}, '198.51.100.7');
    expect((await submit(employee.requestId, seed.secret, '198.51.100.7')).statusCode).toBe(429);
    await submit(employee.requestId, seed.secret, '198.51.100.8');
    const notify = deps.notifier!.notify as ReturnType<typeof vi.fn>;
    const calls = notify.mock.calls.filter((c) => c[0] === 'agent_connected' && String(c[1]).includes('kody'));
    expect(calls).toHaveLength(1);
    expect(String(calls[0]![2])).toContain('5000');
  });
});

describe('błędy żądania autoryzacji', () => {
  it('niezweryfikowany klient nie zamienia bramki w przekierowanie na dowolny adres', async () => {
    const reg = await registerClient(deps, { client_name: 'Bramka SMS', redirect_uris: ['https://phishing.example/logowanie'] }, '203.0.113.66', clock);
    const clientId = reg.body.client_id as string;
    const res = await server.inject({
      method: 'GET', url: `/oauth/authorize?${new URLSearchParams({ response_type: 'token', client_id: clientId, redirect_uri: 'https://phishing.example/logowanie' })}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toContain('response_type=code');
  });
});

describe('ponowne użycie kodu autoryzacji', () => {
  it('drugie użycie kodu odwołuje tokeny wydane na jego podstawie', async () => {
    const first = await connect(seed.secret);
    expect(first.res.statusCode).toBe(200);
    clock = new Date(clock.getTime() + 10_000);
    expect((await tokenRequest(first.form)).statusCode).toBe(400);
    expect(deps.connections.authenticate(`Bearer ${first.tokens.access_token}`, clock).ok).toBe(false);
  });
});

describe('rejestracja dynamiczna', () => {
  it('adres powrotu dłuższy niż 2048 znaków zostaje odrzucony', async () => {
    const reg = await registerClient(deps, { client_name: 'x', redirect_uris: [`https://napastnik.example/${'a'.repeat(2100)}`] }, '203.0.113.66', clock);
    expect(reg.status).toBe(400);
  });

  it('nazwa aplikacji bez znaków formatujących Unicode, które odwracają kierunek tekstu', async () => {
    const reg = await registerClient(deps, { client_name: '‮ia.edualc​', redirect_uris: ['https://napastnik.example/cb'] }, '203.0.113.66', clock);
    expect(reg.status).toBe(201);
    expect(reg.body.client_name).toBe('ia.edualc');
  });
});

describe('użycie kodu jednorazowego', () => {
  it('klient usunięty przez sprzątanie w trakcie łączenia: strona błędu, kod i działające tokeny bez zmian', async () => {
    const active = await connect(seed.secret);
    expect(active.res.statusCode).toBe(200);
    deps.oauth.upsertClient({
      clientId: 'cli_stary', kind: 'dynamic', name: 'Claude Code', redirectUris: ['http://127.0.0.1:53682/cb'], sourceIp: '198.51.100.7',
      createdAt: new Date(clock.getTime() - DAY - 15 * MIN).toISOString(), fetchedAt: null,
    });
    const { code } = seed.service.newCode(seed.connectionId, '24h', clock);
    const { requestId } = await start(pkce().challenge, { client_id: 'cli_stary', redirect_uri: 'http://127.0.0.1:53682/cb' });
    clock = new Date(clock.getTime() + 2 * MIN);
    deps.oauth.prune(clock);
    const res = await submit(requestId, code);
    expect(res.statusCode).toBe(400);
    expect(deps.connectionsRepo.get(seed.connectionId)!.clientId).toBe('cli_claude');
    expect(deps.connectionsRepo.get(seed.connectionId)!.codeUsedAt).toBeNull();
    expect(deps.connections.authenticate(`Bearer ${active.tokens.access_token}`, clock).ok).toBe(true);
  });

  it('klient dynamiczny bez połączenia zostaje dobę i kwadrans, czyli dłużej niż żądanie połączenia', () => {
    const at = (ms: number) => new Date(clock.getTime() - ms).toISOString();
    deps.oauth.upsertClient({ clientId: 'cli_doba', kind: 'dynamic', name: 'x', redirectUris: [REDIRECT], sourceIp: null, createdAt: at(DAY + 10 * MIN), fetchedAt: null });
    deps.oauth.upsertClient({ clientId: 'cli_stary', kind: 'dynamic', name: 'x', redirectUris: [REDIRECT], sourceIp: null, createdAt: at(DAY + 16 * MIN), fetchedAt: null });
    deps.oauth.prune(clock);
    expect(deps.oauth.getClient('cli_doba')).toBeDefined();
    expect(deps.oauth.getClient('cli_stary')).toBeUndefined();
  });
});
