import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApiServer } from '../../src/api/server.ts';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.ts';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../../src/mcp/protocol.ts';
import type { ToolDef } from '../../src/mcp/tools.ts';
import { viewProbeTool } from '../../src/mcp/tools/probe.ts';
import { connectionStatusTool } from '../../src/mcp/tools/status.ts';
import { viewHtml, viewResources } from '../../src/mcp/views/index.ts';
import { openDatabase } from '../../src/store/db.ts';
import { SettingsRepo } from '../../src/store/settings.ts';
import { AGENT_SEED_AT, agentApiDeps, seedAgent } from '../helpers/agent.ts';
import { prepareSms, sendPrepared } from '../helpers/mcp.ts';

const BASE = 'https://bramka.serwis.example';
const APPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPS_KEY = 'io.modelcontextprotocol/clientCapabilities';

let db: Database;
let key: Buffer;
let clock: Date;
let seed: ReturnType<typeof seedAgent>;
let app: FastifyInstance;
let info: ReturnType<typeof vi.fn>;

function server(over: { apiUrl?: string | null; tools?: readonly ToolDef[] } = {}): FastifyInstance {
  info = vi.fn();
  return buildApiServer(agentApiDeps(db, key, { now: () => clock, log: { error: vi.fn(), warn: vi.fn(), info, debug: vi.fn() }, ...over }));
}

beforeEach(() => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
  clock = new Date(AGENT_SEED_AT.getTime() + 60_000);
  seed = seedAgent(db, key, { scopes: ['read_sent'] });
  app = server({ tools: [connectionStatusTool, prepareSms, sendPrepared] });
});

const rpc = (id: number | null, method: string, params?: Record<string, unknown>) => ({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) });

const post = (body: unknown, headers: Record<string, string> = {}, token: string | null = seed.secret, target = app) => target.inject({
  method: 'POST', url: '/mcp', payload: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
});

async function initialize(capabilities: Record<string, unknown> = {}, protocolVersion = '2025-11-25', target = app, token = seed.secret) {
  const res = await post(rpc(1, 'initialize', { protocolVersion, capabilities, clientInfo: { name: 'claude-ai', version: '1.0' } }), {}, token, target);
  return { res, session: res.headers['mcp-session-id'] as string };
}

const legacy = (session: string, body: unknown, version = '2025-11-25') => post(body, { 'mcp-session-id': session, 'mcp-protocol-version': version });

function modern(method: string, params: Record<string, unknown> = {}, opts: { caps?: unknown; version?: string; headers?: Record<string, string>; name?: string } = {}) {
  const version = opts.version ?? '2026-07-28';
  const headers: Record<string, string> = { 'mcp-protocol-version': version, 'mcp-method': method };
  const name = opts.name ?? (typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : undefined);
  if (name !== undefined) headers['mcp-name'] = name;
  return post(rpc(5, method, { ...params, _meta: { [VERSION_KEY]: version, [CAPS_KEY]: opts.caps ?? {} } }), { ...headers, ...opts.headers });
}

describe('era poprzednia: initialize i sesje', () => {
  it('initialize zwraca Mcp-Session-Id, instrukcje i wersję uzgodnioną z klientem', async () => {
    const { res, session } = await initialize();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(session).toMatch(/^[0-9a-f]{32}$/);
    expect(res.json()).toEqual({
      jsonrpc: '2.0', id: 1,
      result: {
        protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'multiinfo-gate', title: 'Multiinfo Gate', version: expect.any(String) }, instructions: SERVER_INSTRUCTIONS,
      },
    });
    expect((await initialize({}, '2025-06-18')).res.json().result.protocolVersion).toBe('2025-06-18');
    expect(info).toHaveBeenCalledWith('mcp.polaczenie', expect.objectContaining({ era: 'legacy', protocolVersion: '2025-11-25', client: 'claude-ai', connectionId: seed.connectionId }));
  });

  it('nieznana wersja klienta: odpowiedź z najnowszą obsługiwaną', async () => {
    expect((await initialize({}, '2024-11-05')).res.json().result.protocolVersion).toBe('2025-11-25');
  });

  it('powiadomienie i odpowiedź klienta: 202 bez treści, ping: pusty wynik', async () => {
    const { session } = await initialize();
    const note = await legacy(session, rpc(null, 'notifications/initialized'));
    expect([note.statusCode, note.body]).toEqual([202, '']);
    const reply = await legacy(session, { jsonrpc: '2.0', id: 9, result: {} });
    expect(reply.statusCode).toBe(202);
    expect((await legacy(session, rpc(2, 'ping'))).json()).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  it('sesja innego połączenia: 404, nieznana sesja: 404, brak sesji: 400', async () => {
    const other = seed.service.create(seed.integrationId, { name: 'Jan Kowalski', method: 'token', codeValidity: '24h', validity: '90d' }, 'admin', clock);
    const { session } = await initialize({}, '2025-11-25', app, other.secret);
    expect((await legacy(session, rpc(2, 'tools/list'))).statusCode).toBe(404);
    expect((await legacy('0'.repeat(32), rpc(2, 'tools/list'))).statusCode).toBe(404);
    const missing = await post(rpc(2, 'tools/list'));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe(-32600);
  });

  it('nagłówek MCP-Protocol-Version spoza obsługiwanych: 400', async () => {
    const { session } = await initialize();
    expect((await legacy(session, rpc(2, 'tools/list'), '2024-01-01')).statusCode).toBe(400);
  });

  it('GET /mcp 405, DELETE usuwa sesję', async () => {
    const get = await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${seed.secret}` } });
    expect(get.statusCode).toBe(405);
    const { session } = await initialize();
    const del = await app.inject({ method: 'DELETE', url: '/mcp', headers: { authorization: `Bearer ${seed.secret}`, 'mcp-session-id': session } });
    expect(del.statusCode).toBe(204);
    expect((await legacy(session, rpc(2, 'tools/list'))).statusCode).toBe(404);
    const without = await app.inject({ method: 'DELETE', url: '/mcp', headers: { authorization: `Bearer ${seed.secret}` } });
    expect(without.statusCode).toBe(405);
  });

  it('/mcp bez tokenu: GET i POST z Content-Type application/octet-stream dają 401 z WWW-Authenticate', async () => {
    const get = await app.inject({ method: 'GET', url: '/mcp' });
    expect(get.statusCode).toBe(401);
    expect(get.headers['www-authenticate']).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    const binary = await app.inject({ method: 'POST', url: '/mcp', payload: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream' } });
    expect(binary.statusCode).toBe(401);
    expect(binary.headers['www-authenticate']).toMatch(/^Bearer resource_metadata=/);
    const broken = await post('{nie json', {}, null);
    expect(broken.statusCode).toBe(401);
    const withToken = await app.inject({
      method: 'POST', url: '/mcp', payload: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${seed.secret}` },
    });
    expect(withToken.statusCode).toBe(415);
  });

  it('nieznana metoda -32601, treść spoza JSON-RPC 400', async () => {
    const { session } = await initialize();
    expect((await legacy(session, rpc(2, 'sampling/createMessage'))).json().error.code).toBe(-32601);
    expect((await legacy(session, rpc(3, 'resources/list'))).json().result).toEqual({ resources: viewResources() });
    expect((await legacy(session, rpc(4, 'prompts/list'))).json().result).toEqual({ prompts: [] });
    const batch = await post([rpc(1, 'ping'), rpc(2, 'ping')]);
    expect([batch.statusCode, batch.json().error.code]).toEqual([400, -32600]);
    const broken = await post('{nie json');
    expect([broken.statusCode, broken.json().error.code]).toEqual([400, -32700]);
  });
});

describe('nowa era 2026-07-28', () => {
  it('server/discover z _meta 2026-07-28: supportedVersions, instrukcje, resultType complete, bez Mcp-Session-Id', async () => {
    const res = await modern('server/discover');
    expect(res.statusCode).toBe(200);
    expect(res.headers['mcp-session-id']).toBeUndefined();
    expect(res.json().result).toEqual({
      resultType: 'complete', supportedVersions: SUPPORTED_PROTOCOL_VERSIONS, capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: SERVER_INSTRUCTIONS, ttlMs: 0, cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'multiinfo-gate', title: 'Multiinfo Gate', version: expect.any(String) } },
    });
    expect(info).toHaveBeenCalledWith('mcp.polaczenie', expect.objectContaining({ era: 'modern', protocolVersion: '2026-07-28' }));
  });

  it('nowa era: tools/list z ttlMs 0 i cacheScope private, widoczność według clientCapabilities z _meta żądania', async () => {
    const plain = (await modern('tools/list')).json().result;
    expect(plain).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
    expect(plain.tools.map((t: { name: string }) => t.name)).toEqual(['connection_status']);
    expect(plain.tools[0]._meta).toBeUndefined();
    const withApps = (await modern('tools/list', {}, { caps: APPS })).json().result;
    expect(withApps.tools[0]._meta).toEqual({ ui: { resourceUri: 'ui://multiinfo-gate/co-moge' } });
    const call = (await modern('tools/call', { name: 'connection_status', arguments: {} })).json().result;
    expect(call).toMatchObject({ resultType: 'complete', content: [{ type: 'text' }] });
    // Punkt kontrolny A: znacznik pokazuje, czy agent widzi _meta wyniku; zadanie 13 go usuwa.
    expect(call._meta).toEqual({ 'multiinfo-gate/proba': 'Znacznik _meta: MIG-META-PROBA' });
    expect((await modern('resources/list')).json().result).toEqual({ resultType: 'complete', resources: viewResources(), ttlMs: 3_600_000, cacheScope: 'private' });
    expect((await modern('prompts/list')).json().result).toEqual({ resultType: 'complete', prompts: [], ttlMs: 0, cacheScope: 'private' });
  });

  it('nowa era: niezgodny MCP-Protocol-Version albo Mcp-Method daje 400 z -32020', async () => {
    const version = await modern('tools/list', {}, { headers: { 'mcp-protocol-version': '2025-11-25' } });
    expect(version.statusCode).toBe(400);
    expect(version.json().error).toMatchObject({ code: -32020, data: { mismatch: ['MCP-Protocol-Version'] } });
    const method = await modern('tools/list', {}, { headers: { 'mcp-method': 'tools/call' } });
    expect([method.statusCode, method.json().error.code, method.json().error.data.mismatch]).toEqual([400, -32020, ['Mcp-Method']]);
    const name = await modern('tools/call', { name: 'connection_status', arguments: {} }, { name: 'prepare_sms' });
    expect([name.statusCode, name.json().error.data.mismatch]).toEqual([400, ['Mcp-Name']]);
  });

  it('nowa era: wersja spoza listy daje 400 z -32022 i data.supported', async () => {
    const res = await modern('server/discover', {}, { version: '2027-01-01' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: -32022, data: { supported: SUPPORTED_PROTOCOL_VERSIONS } });
  });

  it('nowa era: ping -32601, żądanie bez klucza wersji w _meta obsługiwane jak era poprzednia', async () => {
    expect((await modern('ping')).json().error.code).toBe(-32601);
    expect((await modern('initialize', { protocolVersion: '2025-11-25', capabilities: {} })).json().error.code).toBe(-32601);
    const discover = await post(rpc(1, 'server/discover'));
    expect(discover.statusCode).toBe(400);
    const { res } = await initialize();
    expect(res.statusCode).toBe(200);
  });

  it('nowa era: nagłówek Mcp-Session-Id pomijany', async () => {
    const res = await modern('tools/list', {}, { headers: { 'mcp-session-id': 'nieznana' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('uwierzytelnienie i pochodzenie', () => {
  it('bez tokenu 401 z resource_metadata, z kluczem API 401 z komunikatem o tokenie połączenia', async () => {
    const none = await post(rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }), {}, null);
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    const apiKey = await post(rpc(1, 'initialize', {}), {}, 'mig_live_abcdefghijklmnopqrstuvwxyz012345');
    expect(apiKey.statusCode).toBe(401);
    expect(apiKey.json().error_description).toBe('Adres /mcp nie przyjmuje klucza API. Użyj tokenu połączenia z panelu bramki.');
    expect(apiKey.headers['www-authenticate']).toContain('error="invalid_token"');
    seed.service.revoke(seed.connectionId, clock);
    const revoked = await post(rpc(1, 'initialize', {}));
    expect(revoked.statusCode).toBe(401);
    expect(revoked.headers['www-authenticate']).toBe(`Bearer error="invalid_token", resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect(revoked.json().error).toBe('invalid_token');
  });

  it('bez adresu bramki 401 z samym Bearer, token połączenia działa', async () => {
    new SettingsRepo(db).setApiUrl(null, clock);
    const bare = server({ apiUrl: null });
    expect((await post(rpc(1, 'initialize', {}), {}, null, bare)).headers['www-authenticate']).toBe('Bearer');
    expect((await initialize({}, '2025-11-25', bare)).res.statusCode).toBe(200);
  });

  it('POST /v1/messages z tokenem połączenia: 401, token działa wyłącznie pod /mcp', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${seed.secret}`, 'content-type': 'application/json' },
      payload: { to: '48601000011', text: 'Serwis jutro o 9:00' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toEqual({
      code: 'agent_token', message: 'Token połączenia agenta AI działa wyłącznie pod adresem /mcp. Do API użyj klucza API.',
    });
  });

  it('Origin http://evil.example 403, https://claude.ai przechodzi, brak Origin przechodzi', async () => {
    for (const origin of ['http://evil.example', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://drukarka.local', 'null']) {
      const res = await post(rpc(1, 'initialize', {}), { origin });
      expect([origin, res.statusCode]).toEqual([origin, 403]);
    }
    for (const origin of ['https://claude.ai', 'https://chatgpt.com', BASE]) {
      expect((await post(rpc(1, 'initialize', {}), { origin })).statusCode).toBe(200);
    }
    expect((await initialize()).res.statusCode).toBe(200);
  });
});

describe('narzędzia według zakresów i stanu integracji', () => {
  it('tools/list bez zakresu send nie zawiera prepare_sms (narzędzie testowe w rejestrze)', async () => {
    const { session } = await initialize();
    expect((await legacy(session, rpc(2, 'tools/list'))).json().result.tools.map((t: { name: string }) => t.name)).toEqual(['connection_status']);
    db.prepare('UPDATE integrations SET config = json_set(config, \'$.scopes\', json(\'["send","read_sent"]\')) WHERE id = ?').run(seed.integrationId);
    expect((await legacy(session, rpc(3, 'tools/list'))).json().result.tools.map((t: { name: string }) => t.name))
      .toEqual(['connection_status', 'prepare_sms', 'send_prepared']);
  });

  it('narzędzie appOnly: visibility app przy sesji z widokami, bez _meta.ui przy sesji bez widoków', async () => {
    db.prepare('UPDATE integrations SET config = json_set(config, \'$.scopes\', json(\'["send"]\')) WHERE id = ?').run(seed.integrationId);
    const apps = (await initialize(APPS)).session;
    const send = (await legacy(apps, rpc(2, 'tools/list'))).json().result.tools.find((t: { name: string }) => t.name === 'send_prepared');
    expect(send._meta).toEqual({ ui: { visibility: ['app'] } });
    const plain = (await initialize()).session;
    const visible = (await legacy(plain, rpc(2, 'tools/list'))).json().result.tools.find((t: { name: string }) => t.name === 'send_prepared');
    expect(visible._meta).toBeUndefined();
    expect(visible.annotations.destructiveHint).toBe(true);
  });

  it('wyłączona integracja: tools/list zawiera tylko connection_status z powodem, tools/call innego narzędzia isError', async () => {
    db.prepare('UPDATE integrations SET config = json_set(config, \'$.scopes\', json(\'["send"]\')), enabled = 0 WHERE id = ?').run(seed.integrationId);
    const { session } = await initialize();
    expect((await legacy(session, rpc(2, 'tools/list'))).json().result.tools.map((t: { name: string }) => t.name)).toEqual(['connection_status']);
    const call = (await legacy(session, rpc(3, 'tools/call', { name: 'prepare_sms', arguments: { text: 'x' } }))).json().result;
    expect(call.isError).toBe(true);
    expect(call.content[0].text).toContain('integracja jest wyłączona');
    const status = (await legacy(session, rpc(4, 'tools/call', { name: 'connection_status', arguments: {} }))).json().result;
    expect(status.content[0].text).toContain('Połączenie jest chwilowo niedostępne: integracja jest wyłączona.');
    db.prepare('UPDATE integrations SET enabled = 1 WHERE id = ?').run(seed.integrationId);
    expect((await legacy(session, rpc(5, 'tools/call', { name: 'prepare_sms', arguments: { text: 'x' } }))).json().result.isError).toBeUndefined();
  });

  it('limit żądań klucza: kolejne tools/call ponad ratePerMin daje isError z czasem ponowienia', async () => {
    db.prepare('UPDATE api_keys SET rate_per_min = 2 WHERE id = ?').run(seed.keyId);
    const { session } = await initialize();
    const call = (id: number) => legacy(session, rpc(id, 'tools/call', { name: 'connection_status', arguments: {} }));
    expect((await call(2)).json().result.isError).toBeUndefined();
    expect((await call(3)).json().result.isError).toBeUndefined();
    const limited = (await call(4)).json().result;
    expect(limited).toEqual({ content: [{ type: 'text', text: 'Przekroczono limit 2 żądań na minutę klucza. Spróbuj ponownie za minutę.' }], isError: true });
  });

  it('nieznana metoda -32601, błędne argumenty: błąd narzędzia z opisem pola, nieznane narzędzie -32602', async () => {
    db.prepare('UPDATE integrations SET config = json_set(config, \'$.scopes\', json(\'["send"]\')) WHERE id = ?').run(seed.integrationId);
    const { session } = await initialize();
    expect((await legacy(session, rpc(2, 'completion/complete'))).json().error.code).toBe(-32601);
    const bad = (await legacy(session, rpc(3, 'tools/call', { name: 'prepare_sms', arguments: { text: '' } }))).json().result;
    expect(bad).toEqual({ content: [{ type: 'text', text: 'Nieprawidłowe argumenty narzędzia. text: Pole nie może być puste.' }], isError: true });
    expect((await legacy(session, rpc(4, 'tools/call', { name: 'nieznane', arguments: {} }))).json().error.code).toBe(-32602);
    expect((await legacy(session, rpc(5, 'tools/call', {}))).json().error.code).toBe(-32602);
  });
});

describe('zasoby widoków i narzędzie próbne', () => {
  it('resources/list zawiera ui://multiinfo-gate/co-moge z typem APP_MIME', async () => {
    const { session } = await initialize(APPS);
    const list = (await legacy(session, rpc(2, 'resources/list'))).json().result.resources;
    expect(list).toContainEqual(expect.objectContaining({ uri: 'ui://multiinfo-gate/co-moge', mimeType: 'text/html;profile=mcp-app', title: 'Co mogę?' }));
  });

  it('resources/read zwraca dokument widoku z _meta.ui w elemencie contents, nieznany adres -32002', async () => {
    const expected = {
      contents: [{
        uri: 'ui://multiinfo-gate/co-moge', mimeType: 'text/html;profile=mcp-app', text: viewHtml('co-moge'),
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
      }],
    };
    const { session } = await initialize(APPS);
    expect((await legacy(session, rpc(2, 'resources/read', { uri: 'ui://multiinfo-gate/co-moge' }))).json().result).toEqual(expected);
    const modernRead = (await modern('resources/read', { uri: 'ui://multiinfo-gate/co-moge' }, { caps: APPS })).json().result;
    expect(modernRead).toEqual({ resultType: 'complete', ...expected, ttlMs: 3_600_000, cacheScope: 'private' });
    expect((await legacy(session, rpc(3, 'resources/read', { uri: 'ui://multiinfo-gate/wysylka' }))).json().error.code).toBe(-32002);
    expect((await legacy(session, rpc(4, 'resources/read', { uri: 'ui://multiinfo-gate/../co-moge' }))).json().error.code).toBe(-32002);
  });

  it('view_probe: tylko dla widoku, zwraca chwilę wywołania i początek identyfikatora sesji, w nowej erze bez sesji', async () => {
    app = server({ tools: [connectionStatusTool, viewProbeTool] });
    const { session } = await initialize(APPS);
    const listed = (await legacy(session, rpc(2, 'tools/list'))).json().result.tools.find((t: { name: string }) => t.name === 'view_probe');
    expect(listed).toMatchObject({ title: 'Próba wywołania z widoku', annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ['app'] } } });
    const legacyCall = (await legacy(session, rpc(3, 'tools/call', { name: 'view_probe', arguments: {} }))).json().result;
    expect(legacyCall.structuredContent).toEqual({ at: clock.toISOString(), session: session.slice(0, 8), protocolVersion: '2025-11-25' });
    expect(legacyCall.content[0].text).toContain(session.slice(0, 8));
    expect(legacyCall.content[0].text).not.toContain(session);
    const modernCall = (await modern('tools/call', { name: 'view_probe', arguments: {} }, { caps: APPS })).json().result;
    expect(modernCall.structuredContent).toEqual({ at: clock.toISOString(), session: null, protocolVersion: '2026-07-28' });
  });

  it('view_probe bez widoków jest widoczne dla agenta bez destructiveHint, bo tylko odczytuje', async () => {
    app = server({ tools: [connectionStatusTool, viewProbeTool] });
    const plain = (await modern('tools/list')).json().result.tools.find((t: { name: string }) => t.name === 'view_probe');
    expect(plain.annotations.destructiveHint).toBeUndefined();
    expect(plain._meta).toBeUndefined();
  });
});
