import type { FastifyInstance } from 'fastify';
import type { AccountsRepo } from '../store/accounts.ts';

/** Poniżej tylu dni do wygaśnięcia certyfikatu bramka zgłasza stan pogorszony. */
const CERT_WARNING_DAYS = 7;

export interface HealthDeps {
  accounts: AccountsRepo;
  queueDepth: () => number;
  now?: () => Date;
}

const daysLeft = (notAfter: string, now: Date) =>
  Math.floor((Date.parse(notAfter) - now.getTime()) / 86_400_000);

/**
 * Wariant publiczny zwraca sam status. Wariant panelu podaje szczegóły -
 * nazwy kont i daty ważności nie mogą wyciekać na port wystawiony na świat.
 */
export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps, mode: 'public' | 'admin'): void {
  app.get('/healthz', async () => {
    const now = (deps.now ?? (() => new Date()))();
    const accounts = deps.accounts.list();
    const paused = accounts.filter((a) => a.pausedReason !== null);
    const expiring = accounts.filter((a) => daysLeft(a.certNotAfter, now) <= CERT_WARNING_DAYS);
    const status = paused.length > 0 || expiring.length > 0 ? 'degraded' : 'ok';

    if (mode === 'public') return { status };

    return {
      status,
      queueDepth: deps.queueDepth(),
      accounts: accounts.map((a) => ({
        name: a.name,
        paused: a.pausedReason,
        certificateDaysLeft: daysLeft(a.certNotAfter, now),
      })),
    };
  });
}
