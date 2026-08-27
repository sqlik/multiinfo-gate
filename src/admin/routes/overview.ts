import type { FastifyInstance } from 'fastify';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { overviewPage } from '../views/overview.ts';

/** Okno, z którego liczone są kafelki przeglądu. */
const WINDOW_MS = 24 * 3600_000;

/** Ile ostatnich niepowodzeń pokazujemy na przeglądzie. */
const FAILURES_SHOWN = 8;

export function registerOverviewRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());

  app.get('/przeglad', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const at = now();

    return render.page(request, {
      title: 'Przegląd',
      active: 'przeglad',
      body: overviewPage({
        counts: deps.messages.countSince(new Date(at.getTime() - WINDOW_MS)),
        queueDepth: deps.jobs.depth(),
        accounts: deps.accounts.list().map((row) => ({ row, serviceIds: deps.accounts.serviceIds(row.id) })),
        failures: deps.messages.recentFailures(FAILURES_SHOWN),
        keyNames: new Map(deps.apiKeys.list().map((k) => [k.id, k.name])),
        webhooks: deps.deliveries.counts(),
      }, at),
    });
  });
}
