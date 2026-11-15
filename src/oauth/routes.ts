import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ConnectionService } from '../agents/connections.ts';
import type { Logger } from '../log.ts';
import type { Resolver } from '../net/private-address.ts';
import type { AdminNotifier } from '../notifications/rules.ts';
import type { AgentConnectionsRepo } from '../store/agent-connections.ts';
import type { AuditRepo } from '../store/audit.ts';
import type { OAuthRepo } from '../store/oauth.ts';
import type { SettingsRepo } from '../store/settings.ts';
import { registerClient, type MetadataFetch } from './clients.ts';
import { authorizationServerMetadata, gatewayBase, protectedResourceMetadata } from './metadata.ts';

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

  app.post('/oauth/register', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (base() === null) return reply.code(503).send(NO_GATEWAY_ADDRESS);
    const result = await registerClient(deps, request.body, request.ip, now());
    return reply.code(result.status).send(result.body);
  });
}
