import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { silentLogger } from '../log.ts';
import { gatewayBase } from '../oauth/metadata.ts';
import { GATE_VERSION } from '../version.ts';
import { APP_MIME, clientSupportsApps } from './apps.ts';
import { SERVER_INSTRUCTIONS } from './instructions.ts';
import {
  HEADER_MISMATCH, isObject, LEGACY_PROTOCOL_VERSIONS, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, META_SERVER_INFO, MODERN_PROTOCOL_VERSIONS,
  negotiateVersion, requestEra, requestMeta, RESOURCE_NOT_FOUND, RPC, RpcError, rpcError, rpcResult, SUPPORTED_PROTOCOL_VERSIONS, UNSUPPORTED_VERSION,
  type RpcId,
} from './protocol.ts';
import type { AgentScope } from '../integrations/config.ts';
import { listedPrompt, missingArgument, visiblePrompts } from './prompts.ts';
import { docResources, DOCS_DIR, readDoc } from './resources.ts';
import { callTool, visibleTools, type AgentToolDeps, type ToolContext, type ToolDef } from './tools.ts';
import { TOOLS } from './tools/index.ts';
import { viewByUri, viewHtml, viewMeta, viewResources } from './views/index.ts';

/** Narzędzia bramki według zakresów integracji Agent AI. */
export const AGENT_TOOLS: readonly ToolDef[] = TOOLS;

const SERVER_INFO = { name: 'multiinfo-gate', title: 'Multiinfo Gate', version: GATE_VERSION };
const CAPABILITIES = { tools: {}, resources: {}, prompts: {} };
/** Pole treści, które nowa era powtarza w nagłówku Mcp-Name. */
const NAMED: Record<string, 'name' | 'uri'> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };
const RESOURCE_TTL_MS = 3_600_000;
/**
 * Limit treści POST /mcp: porcja do 5000 wierszy pliku z odbiorcami przekracza ogólny limit API. Bramka sprawdza
 * token w haku onRequest, zanim odczyta treść, dlatego wyższy limit dotyczy wyłącznie połączeń z panelu.
 */
export const MCP_BODY_LIMIT = 4 * 1024 * 1024;

export const API_KEY_REFUSED = 'Adres /mcp nie przyjmuje klucza API. Użyj tokenu połączenia z panelu bramki.';
const MISSING_TOKEN = 'Adres /mcp wymaga tokenu połączenia z panelu bramki albo połączenia aplikacji kodem jednorazowym.';
const INVALID_TOKEN = 'Token jest nieprawidłowy, odwołany albo nieaktualny. Połącz aplikację z bramką ponownie.';

const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Ochrona przed DNS rebinding: żądanie bez nagłówka Origin przychodzi od aplikacji serwerowej i przechodzi.
 * Przeglądarka może wysłać żądanie z początku adresu bramki albo z nazwy domeny przez HTTPS. Adresy IP,
 * `localhost` i nazwy `.local` wskazują sieć lokalną, dlatego bramka je odrzuca.
 */
export function originAllowed(origin: string, base: string | null): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (base !== null && url.origin === new URL(base).origin) return true;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || isIP(host) !== 0 || !host.includes('.')) return false;
  return host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local');
}

/**
 * Serwer MCP pod `/mcp` w transporcie Streamable HTTP z odpowiedziami JSON. Obie ery protokołu: bezstanowa
 * 2026-07-28 rozpoznana po wersji w `_meta` oraz poprzednia z `initialize` i sesjami.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: AgentToolDeps, tools: readonly ToolDef[]): void {
  const now = () => (deps.now ? deps.now() : new Date());
  const base = () => gatewayBase(deps.settings.apiUrl());
  const log = deps.log ?? silentLogger;
  const docsDir = deps.docsDir ?? DOCS_DIR;

  const challenge = (error?: string): string => {
    const b = base();
    const parts = [...(error ? [`error="${error}"`] : []), ...(b ? [`resource_metadata="${b}/.well-known/oauth-protected-resource/mcp"`] : [])];
    return parts.length > 0 ? `Bearer ${parts.join(', ')}` : 'Bearer';
  };

  /** Pochodzenie i token; zwraca połączenie albo wysyła odmowę. */
  function admit(request: FastifyRequest, reply: FastifyReply): number | null {
    const origin = header(request, 'origin');
    if (origin !== undefined && !originAllowed(origin, base())) {
      reply.code(403).send(rpcError(null, RPC.invalidRequest, 'Bramka nie przyjmuje żądań z pochodzenia podanego w nagłówku Origin.'));
      return null;
    }
    const auth = deps.connections.authenticate(request.headers.authorization, now());
    if (auth.ok) return auth.connectionId;
    if (auth.code === 'missing') reply.code(401).header('www-authenticate', challenge()).send({ error: 'unauthorized', error_description: MISSING_TOKEN });
    else reply.code(401).header('www-authenticate', challenge('invalid_token'))
      .send({ error: 'invalid_token', error_description: auth.code === 'api_key' ? API_KEY_REFUSED : INVALID_TOKEN });
    return null;
  }

  function toolContext(connectionId: number, sessionId: string | null, apps: boolean, protocolVersion: string, at: Date): ToolContext {
    const resolved = deps.connections.resolve(connectionId, at);
    return {
      connectionId, sessionId, conn: resolved.ok ? resolved.ctx : null, unavailable: resolved.ok ? null : resolved.reason, apps, protocolVersion, deps, base: base(), now: at,
    };
  }

  /** Zakresy połączenia; `null`, gdy integracja, klucz albo konto są chwilowo niedostępne. */
  function scopesOf(connectionId: number, at: Date): ReadonlySet<AgentScope> | null {
    const resolved = deps.connections.resolve(connectionId, at);
    return resolved.ok ? resolved.ctx.scopes : null;
  }

  /** Bez działającej integracji agent widzi tylko „Co mogę?”, które podaje powód. */
  function listTools(connectionId: number, apps: boolean, at: Date): Array<Record<string, unknown>> {
    const scopes = scopesOf(connectionId, at);
    return scopes !== null ? visibleTools(tools, scopes, apps) : visibleTools(tools.filter((t) => t.scopes === 'any'), null, apps);
  }

  const listPrompts = (connectionId: number, at: Date) => visiblePrompts(scopesOf(connectionId, at)).map(listedPrompt);

  /** Scenariusz z zakresów połączenia jako wiadomość użytkownika; scenariusz bez zakresu jest dla połączenia nieznany. */
  function getPrompt(connectionId: number, params: unknown, at: Date): Record<string, unknown> {
    const p = isObject(params) ? params : {};
    const def = visiblePrompts(scopesOf(connectionId, at)).find((d) => d.name === p.name);
    if (!def) throw noPrompt(params);
    const args = isObject(p.arguments) ? p.arguments : {};
    const missing = missingArgument(def, args);
    if (missing !== null) throw new RpcError(RPC.invalidParams, `Scenariusz ${def.name} wymaga argumentu ${missing}.`);
    return { description: def.description, messages: [{ role: 'user', content: { type: 'text', text: def.message(args as Record<string, string>) } }] };
  }

  const listResources = () => [...docResources(docsDir), ...viewResources()];

  async function call(connectionId: number, sessionId: string | null, apps: boolean, protocolVersion: string, params: unknown, at: Date):
    Promise<Record<string, unknown>> {
    const p = isObject(params) ? params : {};
    if (typeof p.name !== 'string') throw new RpcError(RPC.invalidParams, 'Wywołanie narzędzia wymaga pola name z nazwą narzędzia.');
    return callTool(tools, toolContext(connectionId, sessionId, apps, protocolVersion, at), p.name, p.arguments ?? {});
  }

  /** Artykuł dokumentacji albo dokument widoku z `_meta.ui` w elemencie `contents`, bo aplikacja czyta je stamtąd w pierwszej kolejności. */
  function readResource(params: unknown): Record<string, unknown> {
    const doc = readDoc(isObject(params) ? params.uri : undefined, docsDir);
    if (doc !== null) return { contents: [doc] };
    const id = viewByUri(isObject(params) ? params.uri : undefined);
    if (id === null) throw noResource(params);
    return { contents: [{ uri: (params as { uri: string }).uri, mimeType: APP_MIME, text: viewHtml(id), _meta: viewMeta() }] };
  }

  /** Wartość z żądania w komunikacie: obiekt z kluczem `toString` rozsadziłby `String()`. */
  const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value) ?? '');
  const noResource = (params: unknown) =>
    new RpcError(RESOURCE_NOT_FOUND, `Zasób ${isObject(params) ? shown(params.uri) : ''} nie istnieje.`);
  const noPrompt = (params: unknown) =>
    new RpcError(RPC.invalidParams, `Scenariusz ${isObject(params) ? shown(params.name) : ''} nie istnieje.`);
  const noMethod = (method: string) => new RpcError(RPC.methodNotFound, `Metoda ${method} nie jest obsługiwana.`);

  async function modern(request: FastifyRequest, connectionId: number, method: string, params: unknown, at: Date): Promise<Record<string, unknown>> {
    const meta = requestMeta(params);
    const version = meta[META_PROTOCOL_VERSION];
    if (typeof version !== 'string' || !MODERN_PROTOCOL_VERSIONS.includes(version)) {
      throw new RpcError(UNSUPPORTED_VERSION, `Bramka nie obsługuje wersji protokołu ${shown(version)}.`,
        { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: version ?? null }, 400);
    }
    const mismatch: string[] = [];
    if (header(request, 'mcp-protocol-version') !== version) mismatch.push('MCP-Protocol-Version');
    if (header(request, 'mcp-method') !== method) mismatch.push('Mcp-Method');
    const named = NAMED[method];
    if (named !== undefined && header(request, 'mcp-name') !== (isObject(params) ? params[named] : undefined)) mismatch.push('Mcp-Name');
    if (mismatch.length > 0) throw new RpcError(HEADER_MISMATCH, `Nagłówki żądania nie zgadzają się z treścią: ${mismatch.join(', ')}.`, { mismatch }, 400);

    const apps = clientSupportsApps(meta[META_CLIENT_CAPABILITIES]);
    const complete = (result: Record<string, unknown>) => ({ resultType: 'complete', ...result });
    switch (method) {
      case 'server/discover':
        log.info('mcp.polaczenie', { era: 'modern', protocolVersion: version, connectionId, apps, userAgent: header(request, 'user-agent') ?? null });
        return complete({
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS], capabilities: CAPABILITIES, instructions: SERVER_INSTRUCTIONS, ttlMs: 0, cacheScope: 'private',
          _meta: { [META_SERVER_INFO]: SERVER_INFO },
        });
      case 'tools/list': return complete({ tools: listTools(connectionId, apps, at), ttlMs: 0, cacheScope: 'private' });
      case 'tools/call': return complete(await call(connectionId, null, apps, version, params, at));
      case 'resources/list': return complete({ resources: listResources(), ttlMs: RESOURCE_TTL_MS, cacheScope: 'private' });
      case 'resources/read': return complete({ ...readResource(params), ttlMs: RESOURCE_TTL_MS, cacheScope: 'private' });
      case 'prompts/list': return complete({ prompts: listPrompts(connectionId, at), ttlMs: 0, cacheScope: 'private' });
      case 'prompts/get': return complete(getPrompt(connectionId, params, at));
      default: throw noMethod(method);
    }
  }

  async function legacy(request: FastifyRequest, reply: FastifyReply, connectionId: number, method: string, params: unknown, at: Date):
    Promise<Record<string, unknown>> {
    const declared = header(request, 'mcp-protocol-version');
    if (declared !== undefined && !LEGACY_PROTOCOL_VERSIONS.includes(declared)) {
      throw new RpcError(RPC.invalidRequest, `Bramka nie obsługuje wersji protokołu ${declared} z nagłówka MCP-Protocol-Version.`, undefined, 400);
    }
    if (method === 'initialize') {
      const p = isObject(params) ? params : {};
      const version = negotiateVersion(p.protocolVersion);
      const session = deps.sessions.create(connectionId, clientSupportsApps(p.capabilities), version);
      reply.header('mcp-session-id', session.id);
      log.info('mcp.polaczenie', {
        era: 'legacy', protocolVersion: version, connectionId, apps: session.apps,
        client: isObject(p.clientInfo) && typeof p.clientInfo.name === 'string' ? p.clientInfo.name : null, userAgent: header(request, 'user-agent') ?? null,
      });
      return { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS };
    }
    const sessionId = header(request, 'mcp-session-id');
    if (sessionId === undefined) throw new RpcError(RPC.invalidRequest, 'Brak nagłówka Mcp-Session-Id. Rozpocznij połączenie metodą initialize.', undefined, 400);
    const session = deps.sessions.get(sessionId, connectionId);
    if (!session) throw new RpcError(RPC.invalidRequest, 'Sesja wygasła albo nie istnieje. Rozpocznij nową sesję metodą initialize.', undefined, 404);
    switch (method) {
      case 'ping': return {};
      case 'tools/list': return { tools: listTools(connectionId, session.apps, at) };
      case 'tools/call': return call(connectionId, session.id, session.apps, session.protocolVersion, params, at);
      case 'resources/list': return { resources: listResources() };
      case 'resources/read': return readResource(params);
      case 'prompts/list': return { prompts: listPrompts(connectionId, at) };
      case 'prompts/get': return getPrompt(connectionId, params, at);
      default: throw noMethod(method);
    }
  }

  /**
   * Uwierzytelnienie przed odczytem treści i przed sprawdzeniem metody: aplikacja bez tokenu zawsze otrzymuje 401
   * z adresem metadanych, także dla GET i treści innego typu niż JSON, i dzięki temu rozpoczyna logowanie.
   */
  const admitted = new WeakMap<FastifyRequest, number>();
  const gate = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const connectionId = admit(request, reply);
    // Odpowiedź wysłana w haku kończy obsługę żądania, jeżeli hak zwraca obiekt odpowiedzi.
    if (connectionId === null) return reply;
    admitted.set(request, connectionId);
    return undefined;
  };

  app.post('/mcp', { onRequest: gate, bodyLimit: MCP_BODY_LIMIT }, async (request, reply) => {
    const connectionId = admitted.get(request)!;
    const body = request.body;
    if (Array.isArray(body)) {
      return reply.code(400).send(rpcError(null, RPC.invalidRequest, 'Bramka nie przyjmuje paczek komunikatów JSON-RPC. Wyślij jeden komunikat w żądaniu.'));
    }
    if (!isObject(body) || body.jsonrpc !== '2.0') return reply.code(400).send(rpcError(null, RPC.invalidRequest, 'Treść żądania nie jest komunikatem JSON-RPC 2.0.'));
    // Odpowiedź klienta na żądanie serwera i powiadomienie nie wymagają odpowiedzi.
    if (typeof body.method !== 'string') return 'result' in body || 'error' in body ? reply.code(202).send() : reply.code(400).send(rpcError(null, RPC.invalidRequest, 'Komunikat nie zawiera metody.'));
    if (!('id' in body)) return reply.code(202).send();
    const id: RpcId = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
    const at = now();
    try {
      const result = requestEra(body.params) === 'modern'
        ? await modern(request, connectionId, body.method, body.params, at)
        : await legacy(request, reply, connectionId, body.method, body.params, at);
      return reply.send(rpcResult(id, result));
    } catch (error) {
      if (error instanceof RpcError) return reply.code(error.httpStatus).send(rpcError(id, error.code, error.message, error.data));
      throw error;
    }
  });

  // Bramka nie wysyła komunikatów z własnej inicjatywy, więc nie otwiera strumienia SSE.
  app.get('/mcp', { onRequest: gate }, async (_request, reply) =>
    reply.code(405).header('allow', 'POST, DELETE').send(rpcError(null, RPC.invalidRequest, 'Adres /mcp przyjmuje wyłącznie żądania POST.')));

  app.delete('/mcp', { onRequest: gate }, async (request, reply) => {
    const connectionId = admitted.get(request)!;
    const sessionId = header(request, 'mcp-session-id');
    if (sessionId === undefined) return reply.code(405).header('allow', 'POST').send();
    if (!deps.sessions.get(sessionId, connectionId)) return reply.code(404).send();
    deps.sessions.remove(sessionId);
    return reply.code(204).send();
  });
}
