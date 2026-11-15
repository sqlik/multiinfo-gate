import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { authorizationServerMetadata, gatewayBase, protectedResourceMetadata } from '../../src/oauth/metadata.ts';
import { registerOAuthRoutes } from '../../src/oauth/routes.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';
import { agentServerDeps, oauthDeps } from '../helpers/agent.ts';

const BASE = 'https://bramka.serwis.example';
let db: Database;
let key: Buffer;

beforeEach(() => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
});

async function app(apiUrl: string | null = BASE): Promise<FastifyInstance> {
  const server = Fastify();
  registerOAuthRoutes(server, oauthDeps(db, key, { apiUrl }));
  await server.ready();
  return server;
}

describe('adres bazowy', () => {
  it('gatewayBase usuwa końcowy ukośnik, a brak adresu daje null', () => {
    expect(gatewayBase('https://bramka.serwis.example/')).toBe(BASE);
    expect(gatewayBase(BASE)).toBe(BASE);
    expect(gatewayBase(null)).toBeNull();
    expect(gatewayBase('')).toBeNull();
  });
});

describe('metadane', () => {
  it('metadane zasobu pod obiema ścieżkami wskazują <base>/mcp', async () => {
    const server = await app();
    for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ resource: `${BASE}/mcp`, authorization_servers: [BASE], bearer_methods_supported: ['header'], resource_name: 'Multiinfo Gate' });
      expect(res.headers['access-control-allow-origin']).toBe('*');
      const preflight = await server.inject({ method: 'OPTIONS', url, headers: { origin: 'http://localhost:6274', 'access-control-request-headers': 'mcp-protocol-version' } });
      expect([preflight.statusCode, preflight.headers['access-control-allow-origin'], preflight.headers['access-control-allow-headers']]).toEqual([204, '*', '*']);
    }
    expect(protectedResourceMetadata(BASE)).not.toHaveProperty('scopes_supported');
  });

  it('metadane serwera autoryzacji: wyłącznie code i PKCE S256, klient publiczny, dokumenty metadanych klienta i iss', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(authorizationServerMetadata(BASE));
    expect(res.json()).toEqual({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('adres bazowy z ustawienia, nagłówek Host nie zmienia issuer', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    expect(res.json().issuer).toBe(BASE);
    expect(JSON.stringify(res.json())).not.toContain('evil.example');
  });

  it('bez adresu bramki 503 temporarily_unavailable', async () => {
    const server = await app(null);
    for (const [method, url] of [['GET', '/.well-known/oauth-protected-resource/mcp'], ['GET', '/.well-known/oauth-authorization-server'], ['POST', '/oauth/register']] as const) {
      const res = await server.inject({ method, url, ...(method === 'POST' ? { payload: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } } : {}) });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'temporarily_unavailable', error_description: expect.stringContaining('Adres bramki') });
    }
  });

  it('serwer API rejestruje trasy OAuth tylko z zależnościami agentów', async () => {
    const base = {
      accounts: new AccountsRepo(db, key), apiKeys: new ApiKeysRepo(db, key), messages: new MessagesRepo(db), jobs: new JobsRepo(db),
      events: new MessageEventsRepo(db), packages: new PackagesRepo(db), clients: {} as never, inbound: new InboundMessagesRepo(db),
      rateLimiter: new RateLimiter(), ...integrationDeps(db, key),
    };
    const without = buildApiServer(base);
    expect((await without.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).statusCode).toBe(404);
    const withAgents = buildApiServer({ ...base, agents: agentServerDeps(db, key) });
    expect((await withAgents.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).statusCode).toBe(200);
    const broken = await withAgents.inject({ method: 'POST', url: '/oauth/register', headers: { 'content-type': 'application/json' }, payload: '{nie json' });
    expect([broken.statusCode, broken.json().error]).toEqual([400, 'invalid_request']);
  });
});
