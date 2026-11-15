import type { LinksServerState } from '../links/server-state.ts';
import fastifyFormbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EnrichGet } from '../integrations/enrich.ts';
import type { SourceMatcher } from '../integrations/sources.ts';
import type { TemplateEngine } from '../integrations/templates.ts';
import { silentLogger, type Logger } from '../log.ts';
import type { Resolver } from '../net/private-address.ts';
import type { AdminNotifier } from '../notifications/rules.ts';
import type { IntegrationEventsRepo } from '../store/integration-events.ts';
import type { IntegrationGuardsRepo } from '../store/integration-guards.ts';
import type { IntegrationsRepo } from '../store/integrations.ts';
import type { AccountsRepo } from '../store/accounts.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { JobsRepo } from '../store/jobs.ts';
import type { MessageEventsRepo } from '../store/message-events.ts';
import type { MessagesRepo } from '../store/messages.ts';
import type { PackagesRepo } from '../store/packages.ts';
import type { InboundMessagesRepo } from '../store/inbound-messages.ts';
import type { AgentDraftsRepo } from '../store/agent-drafts.ts';
import type { DownloadLinksRepo } from '../store/download-links.ts';
import { registerOAuthRoutes, type OAuthDeps } from '../oauth/routes.ts';
import { AGENT_TOOLS, registerMcpRoutes } from '../mcp/server.ts';
import type { McpSessions } from '../mcp/sessions.ts';
import type { ToolDef } from '../mcp/tools.ts';
import { RPC, rpcError } from '../mcp/protocol.ts';
import type { CampaignsRepo } from '../store/campaigns.ts';
import type { LinkDomainsRepo } from '../store/link-domains.ts';
import type { ShortLinksRepo } from '../store/short-links.ts';
import type { ClientPool } from '../worker/clients.ts';
import { AuthError } from './auth.ts';
import { registerCampaignRoutes } from './campaigns.ts';
import { registerCancelRoute } from './cancel.ts';
import { ApiError } from './errors.ts';
import { registerHealthRoute, type InboundHealth } from './health.ts';
import { registerHookRoutes } from './hooks.ts';
import { registerKeyInfoRoute } from './key-info.ts';
import { registerMessageRoutes } from './messages.ts';
import { registerInboundRoutes } from './inbound.ts';
import { registerPaIntegrationRoutes } from './pa-integrations.ts';
import { registerPackageRoutes } from './packages.ts';
import type { RateLimiter } from './rate-limit.ts';

/** Agenci AI: serwer autoryzacji OAuth, a od zadania 6 serwer MCP. */
export interface AgentServerDeps extends OAuthDeps {
  drafts: AgentDraftsRepo;
  downloads: DownloadLinksRepo;
  /** Sesje MCP ery poprzedniej. */
  sessions: McpSessions;
  /** Rejestr narzędzi MCP; domyślnie AGENT_TOOLS, testy podstawiają narzędzia próbne. */
  tools?: readonly ToolDef[];
}

export interface ApiDeps {
  accounts: AccountsRepo;
  apiKeys: ApiKeysRepo;
  messages: MessagesRepo;
  events: MessageEventsRepo;
  packages: PackagesRepo;
  jobs: JobsRepo;
  /** Anulowanie woła Multiinfo synchronicznie - to jedyna trasa API, która tego potrzebuje. */
  clients: ClientPool;
  inbound: InboundMessagesRepo;
  rateLimiter: RateLimiter;
  /** Skracacz: domeny, kampanie i kody wysyłek z krótkimi linkami. */
  linkDomains: LinkDomainsRepo;
  campaigns: CampaignsRepo;
  shortLinks: ShortLinksRepo;
  /** Stan serwera przekierowań; gdy nie działa, wysyłki zostawiają linki w pełnej postaci. */
  linksServer?: Pick<LinksServerState, 'available'>;
  /** Integracje: `/hooks/{id}` i to, czego potok potrzebuje. */
  integrations: IntegrationsRepo;
  integrationEvents: IntegrationEventsRepo;
  guards: IntegrationGuardsRepo;
  engine: TemplateEngine;
  sources: SourceMatcher;
  /** Limit żądań na adres źródłowy dla `/hooks/`; bez niego brak limitu (testy). */
  hookLimiter?: RateLimiter;
  /** Wysyłka zapytania uzupełniającego oraz rozwiązywanie jego nazwy; testy podstawiają atrapy. */
  enrichGet?: EnrichGet;
  resolve?: Resolver;
  /** MIG_WEBHOOK_ALLOW_PRIVATE: zgoda na zapytanie uzupełniające do sieci wewnętrznej. */
  allowPrivateWebhooks?: boolean;
  notifier?: AdminNotifier;
  /** Odwrotne proxy, którym wolno podać adres klienta (MIG_TRUSTED_PROXIES). */
  trustedProxies?: string[];
  healthMode?: 'public' | 'admin';
  /** Stan odbiornika do /healthz; bez niego pole nie występuje. */
  inboundHealth?: () => InboundHealth;
  /** Agenci AI; bez tego pola bramka nie wystawia tras OAuth. */
  agents?: AgentServerDeps;
  now?: () => Date;
  log?: Logger;
}

/** Adres w logu błędów: bez zapytania i bez tokenu linku do pobrania, który działa bez logowania. */
export function loggedUrl(url: string): string {
  const path = url.split('?')[0]!;
  return path.startsWith('/pobierz/') ? '/pobierz/…' : path;
}

/** Limit body żądania API; trasy rozsyłki mają własny, wyższy (`PACKAGE_BODY_LIMIT`). */
const API_BODY_LIMIT = 512 * 1024;

/** Rozmiar w komunikacie dla autora aplikacji: „512 KB”, „4 MB”. */
const sizeLabel = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;

export function buildApiServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: false, bodyLimit: API_BODY_LIMIT,
    ...(deps.trustedProxies?.length ? { trustProxy: deps.trustedProxies } : {}),
  });
  // Formularze dla `/hooks/`: aplikacje bez JSON-a (starsze automaty, NAS-y) wysyłają urlencoded.
  app.register(fastifyFormbody);

  app.setErrorHandler((error, _request, reply) => {
    if (_request.url.startsWith('/hooks/')) {
      // Ładunek obcej aplikacji: odpowiedź w kształcie `/hooks/`, bez struktury błędów API.
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 413) return reply.code(413).send({ accepted: false, reason: 'too_large' });
      if (status === 400 || status === 415) return reply.code(400).send({ accepted: false, reason: 'invalid_body' });
    }
    if (_request.url.split('?')[0] === '/mcp') {
      // Serwer MCP odpowiada błędem JSON-RPC także wtedy, gdy Fastify odrzuci treść przed trasą.
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400) return reply.code(400).send(rpcError(null, RPC.parse, 'Treść żądania nie jest poprawnym dokumentem JSON.'));
      if (status === 413) return reply.code(413).send(rpcError(null, RPC.invalidRequest, `Treść żądania przekracza ${sizeLabel(API_BODY_LIMIT)}.`));
      if (status === 415) return reply.code(415).send(rpcError(null, RPC.invalidRequest, 'Treść żądania musi mieć format JSON (Content-Type: application/json).'));
    }
    if (_request.url.startsWith('/oauth/')) {
      // Punkty OAuth odpowiadają błędem w kształcie RFC 6749, a nie strukturą błędów API.
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400 || status === 413 || status === 415) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'Treść żądania jest nieprawidłowa.' });
      }
    }
    if (error instanceof ApiError) {
      return reply.code(error.httpStatus).send(error.toBody());
    }
    if (error instanceof AuthError) {
      return reply.code(error.httpStatus).send({ error: { code: error.code, message: error.message } });
    }
    // Błędy odczytu body zgłasza Fastify przed trasą: to błędy wołającego, nie bramki.
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 413) {
      const limit = _request.routeOptions.bodyLimit ?? API_BODY_LIMIT;
      return reply.code(413).send({ error: { code: 'body_too_large', message: `Body żądania przekracza dopuszczalny rozmiar ${sizeLabel(limit)}.` } });
    }
    if (status === 415) {
      return reply.code(415).send({ error: { code: 'unsupported_media_type', message: 'Body żądania musi mieć format JSON (Content-Type: application/json).' } });
    }
    if (status === 400) {
      return reply.code(400).send({ error: { code: 'invalid_body', message: 'Body żądania jest puste albo nie jest poprawnym dokumentem JSON.' } });
    }
    (deps.log ?? silentLogger).error('api.wyjatek', { method: _request.method, url: loggedUrl(_request.url), error });
    return reply.code(500).send({ error: { code: 'internal', message: 'Błąd wewnętrzny bramki.' } });
  });

  registerMessageRoutes(app, deps);
  registerKeyInfoRoute(app, deps);
  registerCancelRoute(app, deps);
  registerPackageRoutes(app, deps);
  registerCampaignRoutes(app, deps);
  registerPaIntegrationRoutes(app, deps);
  registerInboundRoutes(app, deps);
  registerHookRoutes(app, deps);
  if (deps.agents) {
    registerOAuthRoutes(app, deps.agents);
    registerMcpRoutes(app, { ...deps, ...deps.agents }, deps.agents.tools ?? AGENT_TOOLS);
  }
  registerHealthRoute(
    app,
    {
      accounts: deps.accounts, queueDepth: () => deps.jobs.depth(), ...(deps.now ? { now: deps.now } : {}),
      ...(deps.inboundHealth ? { inbound: deps.inboundHealth } : {}),
    },
    deps.healthMode ?? 'public',
  );
  return app;
}
