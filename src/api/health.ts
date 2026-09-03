import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { InboundHealth } from '../inbound/receiver.ts';
import type { AccountsRepo } from '../store/accounts.ts';
import type { ReleaseInfo } from '../store/settings.ts';
import { GATE_VERSION } from '../version.ts';

export type { InboundHealth };

export interface IntegrationsHealth { enabled: number; troubled24h: number }

/** Poniżej tylu dni do wygaśnięcia certyfikatu bramka zgłasza stan pogorszony. */
const CERT_WARNING_DAYS = 7;

export interface HealthDeps {
  accounts: AccountsRepo;
  queueDepth: () => number;
  /** Stan odbiornika wiadomości przychodzących; bez niego pole nie występuje. */
  inbound?: () => InboundHealth;
  /** Integracje: włączone i z błędem w ostatniej dobie; bez funkcji pole nie występuje. */
  integrations?: () => IntegrationsHealth;
  /** Nowsze wydanie do pokazania (wariant panelu); bez funkcji pole nie występuje. */
  release?: () => ReleaseInfo | null;
  now?: () => Date;
  /** Wariant panelu: czy to żądanie może dostać szczegóły; bez predykatu dostaje zawsze. */
  detailsAllowed?: (request: FastifyRequest) => boolean;
}

const daysLeft = (notAfter: string, now: Date) =>
  Math.floor((Date.parse(notAfter) - now.getTime()) / 86_400_000);

/**
 * Wariant publiczny zwraca sam status. Wariant panelu podaje szczegóły - nazwy kont i daty
 * ważności nie mogą wyciekać na port wystawiony na świat ani do sieci, z której nie da się
 * zalogować (predykat `detailsAllowed`).
 */
export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps, mode: 'public' | 'admin'): void {
  app.get('/healthz', async (request) => {
    const now = (deps.now ?? (() => new Date()))();
    const accounts = deps.accounts.list();
    const paused = accounts.filter((a) => a.pausedReason !== null);
    const expiring = accounts.filter((a) => daysLeft(a.certNotAfter, now) <= CERT_WARNING_DAYS);
    const inbound = deps.inbound?.();
    // Usługa zatrzymana błędem Multiinfo (-23/-24) też pogarsza stan: ktoś musi to naprawić w panelu.
    const status = paused.length > 0 || expiring.length > 0 || (inbound?.errors.length ?? 0) > 0 ? 'degraded' : 'ok';

    if (mode === 'public' || (deps.detailsAllowed && !deps.detailsAllowed(request))) return { status };
    const release = deps.release?.() ?? null;

    return {
      status,
      version: GATE_VERSION,
      queueDepth: deps.queueDepth(),
      accounts: accounts.map((a) => ({
        name: a.name,
        paused: a.pausedReason,
        certificateDaysLeft: daysLeft(a.certNotAfter, now),
      })),
      ...(inbound ? { inbound } : {}),
      ...(deps.integrations ? { integrations: deps.integrations() } : {}),
      ...(release ? { release: { version: release.version, url: release.url } } : {}),
    };
  });
}
