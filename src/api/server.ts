import fastifyFormbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SourceMatcher } from '../integrations/sources.ts';
import type { TemplateEngine } from '../integrations/templates.ts';
import { silentLogger, type Logger } from '../log.ts';
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
import type { ClientPool } from '../worker/clients.ts';
import { AuthError } from './auth.ts';
import { registerCancelRoute } from './cancel.ts';
import { ApiError } from './errors.ts';
import { registerHealthRoute, type InboundHealth } from './health.ts';
import { registerHookRoutes } from './hooks.ts';
import { registerMessageRoutes } from './messages.ts';
import { registerInboundRoutes } from './inbound.ts';
import { registerPackageRoutes } from './packages.ts';
import type { RateLimiter } from './rate-limit.ts';

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
  /** Integracje: `/hooks/{id}` i to, czego potok potrzebuje. */
  integrations: IntegrationsRepo;
  integrationEvents: IntegrationEventsRepo;
  guards: IntegrationGuardsRepo;
  engine: TemplateEngine;
  sources: SourceMatcher;
  /** Limit żądań na adres źródłowy dla `/hooks/`; bez niego brak limitu (testy). */
  hookLimiter?: RateLimiter;
  notifier?: AdminNotifier;
  /** Odwrotne proxy, którym wolno podać adres klienta (MIG_TRUSTED_PROXIES). */
  trustedProxies?: string[];
  healthMode?: 'public' | 'admin';
  /** Stan odbiornika do /healthz; bez niego pole nie występuje. */
  inboundHealth?: () => InboundHealth;
  now?: () => Date;
  log?: Logger;
}

export function buildApiServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: false, bodyLimit: 512 * 1024,
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
    if (error instanceof ApiError) {
      return reply.code(error.httpStatus).send(error.toBody());
    }
    if (error instanceof AuthError) {
      return reply.code(error.httpStatus).send({ error: { code: error.code, message: error.message } });
    }
    (deps.log ?? silentLogger).error('api.wyjatek', { method: _request.method, url: _request.url.split('?')[0], error });
    return reply.code(500).send({ error: { code: 'internal', message: 'Błąd wewnętrzny bramki.' } });
  });

  registerMessageRoutes(app, deps);
  registerCancelRoute(app, deps);
  registerPackageRoutes(app, deps);
  registerInboundRoutes(app, deps);
  registerHookRoutes(app, deps);
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
