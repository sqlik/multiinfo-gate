import Fastify, { type FastifyInstance } from 'fastify';
import { silentLogger, type Logger } from '../log.ts';
import type { AccountsRepo } from '../store/accounts.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { JobsRepo } from '../store/jobs.ts';
import type { MessageEventsRepo } from '../store/message-events.ts';
import type { MessagesRepo } from '../store/messages.ts';
import type { PackagesRepo } from '../store/packages.ts';
import type { ClientPool } from '../worker/clients.ts';
import { AuthError } from './auth.ts';
import { registerCancelRoute } from './cancel.ts';
import { ApiError } from './errors.ts';
import { registerHealthRoute } from './health.ts';
import { registerMessageRoutes } from './messages.ts';
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
  rateLimiter: RateLimiter;
  healthMode?: 'public' | 'admin';
  now?: () => Date;
  log?: Logger;
}

export function buildApiServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024 });

  app.setErrorHandler((error, _request, reply) => {
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
  registerHealthRoute(
    app,
    { accounts: deps.accounts, queueDepth: () => deps.jobs.depth(), ...(deps.now ? { now: deps.now } : {}) },
    deps.healthMode ?? 'public',
  );
  return app;
}
