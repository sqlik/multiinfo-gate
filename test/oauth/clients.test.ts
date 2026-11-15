import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { redirectMatches, registerClient, resolveClient, validRedirectUri, type MetadataFetch } from '../../src/oauth/clients.ts';
import { registerOAuthRoutes, type OAuthDeps } from '../../src/oauth/routes.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, oauthDeps } from '../helpers/agent.ts';

const NOW = AGENT_SEED_AT;
const HOUR = 3_600_000;
const DOC_URL = 'https://chatgpt.example/oauth/client-metadata.json';
let db: Database;
let key: Buffer;

beforeEach(() => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
});

const doc = (over: Record<string, unknown> = {}) => JSON.stringify({
  client_id: DOC_URL, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.example/connector/oauth/callback'], ...over,
});

const counting = (body: string, status = 200): MetadataFetch & { calls: string[] } => {
  const calls: string[] = [];
  return Object.assign(async (url: string) => { calls.push(url); return { status, body }; }, { calls });
};

describe('adresy powrotu', () => {
  it('validRedirectUri przyjmuje https i pętlę zwrotną http, odrzuca inne http, fragment i inne schematy', () => {
    expect(validRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(validRedirectUri('http://127.0.0.1:53682/cb')).toBe(true);
    expect(validRedirectUri('http://localhost:6274/oauth/callback')).toBe(true);
    expect(validRedirectUri('http://[::1]:8080/cb')).toBe(true);
    expect(validRedirectUri('http://evil.example/cb')).toBe(false);
    expect(validRedirectUri('https://claude.ai/cb#x')).toBe(false);
    expect(validRedirectUri('javascript:alert(1)')).toBe(false);
    expect(validRedirectUri('nie adres')).toBe(false);
  });

  it('redirectMatches: inny port pętli zwrotnej pasuje, inny port https nie', () => {
    expect(redirectMatches(['http://127.0.0.1:53682/cb'], 'http://127.0.0.1:61000/cb')).toBe(true);
    expect(redirectMatches(['http://localhost/cb'], 'http://localhost:6274/cb')).toBe(true);
    expect(redirectMatches(['http://127.0.0.1:53682/cb'], 'http://127.0.0.1:61000/inna')).toBe(false);
    expect(redirectMatches(['http://127.0.0.1:53682/cb'], 'http://localhost:53682/cb')).toBe(false);
    expect(redirectMatches(['https://claude.ai/cb'], 'https://claude.ai:8443/cb')).toBe(false);
    expect(redirectMatches(['https://claude.ai/cb'], 'https://claude.ai/cb')).toBe(true);
    expect(redirectMatches(['https://claude.ai/cb'], 'https://claude.ai/cb?x=1')).toBe(false);
  });
});

describe('rejestracja dynamiczna', () => {
  const register = (deps: OAuthDeps, body: unknown, ip = '203.0.113.10') => registerClient(deps, body, ip, NOW);

  it('rejestracja: http://evil.example odrzucony, http://127.0.0.1:53682/cb przyjęty', async () => {
    const deps = oauthDeps(db, key);
    const bad = await register(deps, { redirect_uris: ['http://evil.example/cb'], client_name: 'Claude Code' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_redirect_uri');
    const ok = await register(deps, { redirect_uris: ['http://127.0.0.1:53682/cb'], client_name: 'Claude Code', application_type: 'native' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:53682/cb'], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'native',
    });
    const clientId = ok.body.client_id as string;
    expect(clientId).toMatch(/^cli_[A-Za-z0-9_-]{22}$/);
    expect(deps.oauth.getClient(clientId)).toMatchObject({ kind: 'dynamic', name: 'Claude Code', sourceIp: '203.0.113.10', createdAt: NOW.toISOString() });
  });

  it('rejestracja z client_secret_basic zwraca none bez sekretu', async () => {
    const res = await register(oauthDeps(db, key), { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'client_secret_basic' });
    expect(res.status).toBe(201);
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(res.body).not.toHaveProperty('client_secret');
    expect(res.body.client_name).toBe('Aplikacja bez nazwy');
  });

  it('rejestracja odrzuca brak adresów, jedenaście adresów i treść, która nie jest obiektem', async () => {
    const deps = oauthDeps(db, key);
    expect((await register(deps, { client_name: 'x' })).status).toBe(400);
    expect((await register(deps, { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://claude.ai/cb${i}`) })).status).toBe(400);
    expect((await register(deps, 'tekst')).status).toBe(400);
  });

  it('nazwa aplikacji dłuższa niż 100 znaków zostaje skrócona', async () => {
    const res = await register(oauthDeps(db, key), { redirect_uris: ['https://claude.ai/cb'], client_name: 'A'.repeat(150) });
    expect(res.body.client_name).toBe('A'.repeat(100));
  });

  it('rejestracja jedenasta z adresu w godzinie daje 429', async () => {
    const deps = oauthDeps(db, key);
    for (let i = 0; i < 10; i += 1) expect((await register(deps, { redirect_uris: ['https://claude.ai/cb'] })).status).toBe(201);
    const blocked = await register(deps, { redirect_uris: ['https://claude.ai/cb'] });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('too_many_requests');
    expect((await register(deps, { redirect_uris: ['https://claude.ai/cb'] }, '203.0.113.11')).status).toBe(201);
  });

  it('nieudane próby z wielu adresów nie zużywają limitu łącznego', async () => {
    const deps = oauthDeps(db, key);
    for (let i = 0; i < 120; i += 1) expect((await register(deps, { redirect_uris: ['http://evil.example/cb'] }, `198.51.100.${i}`)).status).toBe(400);
    expect((await register(deps, { redirect_uris: ['https://claude.ai/cb'] }, '203.0.113.50')).status).toBe(201);
  });

  it('adresy IPv6 z tej samej sieci /64 liczą się do jednego limitu', async () => {
    const deps = oauthDeps(db, key);
    for (let i = 1; i <= 10; i += 1) expect((await register(deps, { redirect_uris: ['https://claude.ai/cb'] }, `2001:db8:1:2::${i.toString(16)}`)).status).toBe(201);
    expect((await register(deps, { redirect_uris: ['https://claude.ai/cb'] }, '2001:db8:1:2::ff')).status).toBe(429);
    expect((await register(deps, { redirect_uris: ['https://claude.ai/cb'] }, '2001:db8:1:3::1')).status).toBe(201);
  });

  it('POST /oauth/register przyjmuje JSON i odpowiada 201', async () => {
    const server = Fastify();
    registerOAuthRoutes(server, oauthDeps(db, key));
    const res = await server.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' } });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().client_name).toBe('Claude');
  });
});

describe('dokument metadanych klienta', () => {
  it('dokument z publicznego adresu zapisuje klienta metadata', async () => {
    const fetchMetadata = counting(doc());
    const deps = oauthDeps(db, key, { fetchMetadata });
    const client = await resolveClient(deps, DOC_URL, NOW);
    expect(client).toMatchObject({ clientId: DOC_URL, kind: 'metadata', name: 'ChatGPT', redirectUris: ['https://chatgpt.example/connector/oauth/callback'], fetchedAt: NOW.toISOString() });
    expect(fetchMetadata.calls).toEqual([DOC_URL]);
  });

  it('dokument metadanych z adresem wewnętrznym odrzucony także przy allowPrivateWebhooks', async () => {
    const fetchMetadata = counting(doc());
    const deps = { ...oauthDeps(db, key, { fetchMetadata, resolve: async () => ['10.0.0.5'] }), allowPrivateWebhooks: true } as OAuthDeps;
    const result = await resolveClient(deps, DOC_URL, NOW);
    expect(result).toEqual({ error: expect.stringContaining('sieć wewnętrzną') });
    expect(fetchMetadata.calls).toEqual([]);
    expect(await resolveClient(deps, 'https://127.0.0.1/client.json', NOW)).toHaveProperty('error');
  });

  it('dokument metadanych z innym client_id odrzucony', async () => {
    const deps = oauthDeps(db, key, { fetchMetadata: counting(doc({ client_id: 'https://inny.example/client.json' })) });
    expect(await resolveClient(deps, DOC_URL, NOW)).toEqual({ error: expect.stringContaining('client_id') });
    expect(deps.oauth.getClient(DOC_URL)).toBeUndefined();
  });

  it('dokument bez nazwy, z błędnym adresem powrotu, z kodem 404 albo z niepoprawnym JSON odrzucony', async () => {
    for (const fetchMetadata of [
      counting(doc({ client_name: undefined })), counting(doc({ redirect_uris: ['http://evil.example/cb'] })), counting(doc(), 404), counting('{nie json'),
    ]) {
      expect(await resolveClient(oauthDeps(db, key, { fetchMetadata }), DOC_URL, NOW)).toHaveProperty('error');
    }
  });

  it('dokument metadanych w pamięci: drugie użycie w ciągu doby bez pobierania', async () => {
    const fetchMetadata = counting(doc());
    const deps = oauthDeps(db, key, { fetchMetadata });
    await resolveClient(deps, DOC_URL, NOW);
    await resolveClient(deps, DOC_URL, new Date(NOW.getTime() + 23 * HOUR));
    expect(fetchMetadata.calls).toHaveLength(1);
    await resolveClient(deps, DOC_URL, new Date(NOW.getTime() + 25 * HOUR));
    expect(fetchMetadata.calls).toHaveLength(2);
  });

  it('identyfikator rejestracji dynamicznej wskazuje zapisanego klienta, nieznany daje błąd', async () => {
    const deps = oauthDeps(db, key);
    const reg = await registerClient(deps, { redirect_uris: ['https://claude.ai/cb'], client_name: 'Claude' }, '203.0.113.10', NOW);
    expect(await resolveClient(deps, reg.body.client_id as string, NOW)).toMatchObject({ kind: 'dynamic', name: 'Claude' });
    expect(await resolveClient(deps, 'cli_nieznany', NOW)).toHaveProperty('error');
  });
});
