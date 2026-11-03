import { randomBytes } from 'node:crypto';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from './api-deps.ts';

/**
 * Trasy prawdziwego serwera, w postaci `metoda /adres`. Fastify rysuje je drzewem ze wspólnymi
 * przedrostkami, więc pełny adres powstaje ze sklejenia gałęzi od korzenia do liścia.
 */
export function serverRoutes(tree: string): string[] {
  const paths: string[] = [];
  const ancestors: string[] = [];
  for (const line of tree.split('\n')) {
    const marker = line.search(/[├└]── /);
    if (marker === -1) continue;
    const level = Math.floor(marker / 4);
    const content = line.slice(marker + 4);
    const [, segment = '', methods] = /^(.*?)(?: \(([^()]*)\))?$/.exec(content) ?? [];
    ancestors.length = level;
    ancestors.push(segment);
    if (!methods) continue;
    // Fastify dokłada HEAD do każdego GET-a; opisy API mówią o metodach, które wywołuje aplikacja.
    const address = ancestors.join('').replace(/:([A-Za-z]+)/g, '{$1}');
    for (const method of methods.split(', ')) {
      if (method !== 'HEAD') paths.push(`${method.toLowerCase()} ${address}`);
    }
  }
  return paths;
}

/** Trasy serwera API zbudowanego na pustej bazie. */
export async function apiServerRoutes(): Promise<string[]> {
  const masterKey = randomBytes(32);
  const db = openDatabase(':memory:');
  const app = buildApiServer({
    accounts: new AccountsRepo(db, masterKey),
    apiKeys: new ApiKeysRepo(db, masterKey),
    messages: new MessagesRepo(db),
    events: new MessageEventsRepo(db),
    jobs: new JobsRepo(db),
    packages: new PackagesRepo(db),
    inbound: new InboundMessagesRepo(db),
    clients: {} as never,
    rateLimiter: new RateLimiter(),
    healthMode: 'public',
    ...integrationDeps(db, masterKey),
  });
  await app.ready();
  const routes = serverRoutes(app.printRoutes({ commonPrefix: false }));
  await app.close();
  return routes;
}
