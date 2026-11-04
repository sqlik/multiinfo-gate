import type { FastifyInstance } from 'fastify';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { overviewPage } from '../views/overview.ts';
import { WINDOW_MS } from '../window.ts';
import { pendingRelease } from '../../releases/check.ts';
import { nodeUpdateNeeded, plainVersion } from '../../runtime/node-version.ts';
import { keyUsable } from '../../api/submit.ts';

/** Ile ostatnich niepowodzeń pokazujemy na przeglądzie. */
const FAILURES_SHOWN = 8;

export function registerOverviewRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());

  app.get('/przeglad', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const at = now();
    const since = new Date(at.getTime() - WINDOW_MS);
    const nodeVersion = deps.nodeVersion ?? process.version;
    const nodeMinimum = nodeUpdateNeeded(nodeVersion);
    // Włączony kanał SMS z kluczem, którym nie można już wysyłać: odwołanie blokuje panel, więc zostaje wygaśnięcie.
    const sms = deps.notifications.smsSettings();
    const smsKey = sms?.enabled && sms.apiKeyId !== null ? deps.apiKeys.get(sms.apiKeyId) : undefined;

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
        integrationsTroubled: deps.integrations.countTroubled(since) + (deps.mailIn?.troubledCount() ?? 0),
        release: pendingRelease(deps.settings),
        node: nodeMinimum === null ? null : { installed: plainVersion(nodeVersion), minimum: nodeMinimum },
        m365NeedsLogin: (deps.m365Accounts?.list() ?? []).filter((a) => a.state === 'needs_login').map((a) => ({ id: a.id, name: a.name })),
        smsKeyExpired: smsKey !== undefined && !keyUsable(smsKey, at).ok,
      }, at),
    });
  });
}
