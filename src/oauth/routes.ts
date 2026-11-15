import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ConnectionService } from '../agents/connections.ts';
import { RateLimiter } from '../api/rate-limit.ts';
import type { Logger } from '../log.ts';
import type { Resolver } from '../net/private-address.ts';
import type { AdminNotifier } from '../notifications/rules.ts';
import type { AgentConnectionsRepo } from '../store/agent-connections.ts';
import type { AuditRepo } from '../store/audit.ts';
import type { OAuthRepo } from '../store/oauth.ts';
import type { SettingsRepo } from '../store/settings.ts';
import { authorizeFlow, type AuthorizeResult } from './authorize.ts';
import { registerClient, type MetadataFetch } from './clients.ts';
import { sourceKey } from './limits.ts';
import { authorizationServerMetadata, gatewayBase, protectedResourceMetadata } from './metadata.ts';
import { oauthErrorPage, PAGE_CSP } from './page.ts';
import { exchangeToken, revokeToken } from './tokens.ts';

export interface OAuthDeps {
  settings: Pick<SettingsRepo, 'apiUrl'>;
  oauth: OAuthRepo;
  connectionsRepo: AgentConnectionsRepo;
  connections: ConnectionService;
  audit: AuditRepo;
  notifier?: AdminNotifier;
  masterKey: Buffer;
  resolve?: Resolver;
  fetchMetadata?: MetadataFetch;
  now?: () => Date;
  log?: Logger;
}

/** Odpowiedź punktów OAuth, gdy administrator nie ustawił adresu bramki. */
export const NO_GATEWAY_ADDRESS = {
  error: 'temporarily_unavailable',
  error_description: 'Adres bramki nie jest ustawiony. Administrator wpisuje go w panelu bramki w ustawieniu „Adres bramki dla aplikacji”.',
};

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthDeps): void {
  const base = () => gatewayBase(deps.settings.apiUrl());
  const now = () => (deps.now ? deps.now() : new Date());

  // Metadane są publiczne. Aplikacje uruchomione w przeglądarce (na przykład MCP Inspector) pobierają je
  // bezpośrednio, a nagłówek MCP-Protocol-Version wymusza zapytanie wstępne CORS.
  const cors = (reply: FastifyReply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, OPTIONS')
    .header('access-control-allow-headers', '*');
  const metadata = (build: (base: string) => Record<string, unknown>) => async (_request: unknown, reply: FastifyReply) => {
    cors(reply);
    const b = base();
    if (b === null) return reply.code(503).send(NO_GATEWAY_ADDRESS);
    return reply.send(build(b));
  };
  for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
    app.get(url, metadata(url.includes('protected-resource') ? protectedResourceMetadata : authorizationServerMetadata));
    app.options(url, async (_request, reply) => cors(reply).code(204).send());
  }

  // Rejestracja, token i odwołanie bez ciasteczek i sesji: aplikacje w przeglądarce (MCP Inspector) wołają je bezpośrednio.
  const corsPost = (reply: FastifyReply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'POST, OPTIONS')
    .header('access-control-allow-headers', '*');
  for (const url of ['/oauth/register', '/oauth/token', '/oauth/revoke']) {
    app.options(url, async (_request, reply) => corsPost(reply).code(204).send());
  }

  app.post('/oauth/register', async (request, reply) => {
    corsPost(reply).header('cache-control', 'no-store');
    if (base() === null) return reply.code(503).send(NO_GATEWAY_ADDRESS);
    const result = await registerClient(deps, request.body, request.ip, now());
    return reply.code(result.status).send(result.body);
  });

  const flow = authorizeFlow(deps);
  const page = (reply: FastifyReply, result: AuthorizeResult) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff');
    if (result.kind === 'redirect') return reply.code(302).header('location', result.location).send();
    return reply.code(result.status).header('content-security-policy', PAGE_CSP).header('x-frame-options', 'DENY')
      .type('text/html; charset=utf-8').send(result.html);
  };
  const object = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {});
  const noAddress = (): AuthorizeResult => ({ kind: 'page', status: 503, html: oauthErrorPage(NO_GATEWAY_ADDRESS.error_description) });

  app.get('/oauth/authorize', async (request, reply) => {
    const b = base();
    return page(reply, b === null ? noAddress() : await flow.start(object(request.query), b, now()));
  });
  app.post('/oauth/authorize', async (request, reply) => {
    const b = base();
    return page(reply, b === null ? noAddress() : flow.complete(object(request.body), b, request.ip, now()));
  });

  // Limit wymiany tokenów: 60 żądań na minutę ze źródła (adres IPv4 albo sieć IPv6 /64).
  const tokenLimiter = new RateLimiter(() => now().getTime());
  app.post('/oauth/token', async (request, reply) => {
    corsPost(reply).header('cache-control', 'no-store').header('pragma', 'no-cache');
    const b = base();
    if (b === null) return reply.code(503).send(NO_GATEWAY_ADDRESS);
    if (!tokenLimiter.check(sourceKey(request.ip), 60)) {
      return reply.code(429).send({ error: 'too_many_requests', error_description: 'Zbyt wiele żądań tokenu. Spróbuj ponownie za minutę.' });
    }
    const result = exchangeToken(deps, request.body, b, request.ip, now());
    return reply.code(result.status).send(result.body);
  });

  app.post('/oauth/revoke', async (request, reply) => {
    corsPost(reply).header('cache-control', 'no-store');
    if (base() === null) return reply.code(503).send(NO_GATEWAY_ADDRESS);
    revokeToken(deps, request.body);
    return reply.code(200).send();
  });
}
