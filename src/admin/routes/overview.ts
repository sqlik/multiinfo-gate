import type { FastifyInstance } from 'fastify';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { overviewPage } from '../views/overview.ts';
import { WINDOW_MS } from '../window.ts';

/** Ile ostatnich niepowodzeń pokazujemy na przeglądzie. */
const FAILURES_SHOWN = 8;

export function registerOverviewRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());

  app.get('/przeglad', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const at = now();
    const since = new Date(at.getTime() - WINDOW_MS);

    return render.page(request, {
      title: 'Przegląd',
      active: 'przeglad',
      body: overviewPage({
        counts: deps.messages.countSince(since),
        queueDepth: deps.jobs.depth(),
        accounts: deps.accounts.list().map((row) => ({ row, serviceIds: deps.accounts.serviceIds(row.id) })),
        failures: deps.messages.recentFailures(FAILURES_SHOWN),
        keyNames: new Map(deps.apiKeys.list().map((k) => [k.id, k.name])),
        webhooks: deps.deliveries.counts(since),
        inboundToday: deps.inbound.countSince(since),
        integrationsTroubled: deps.integrations.countTroubled(since),
      }, at),
    });
  });
}
