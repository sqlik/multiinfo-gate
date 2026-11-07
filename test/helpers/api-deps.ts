import type { Database } from 'better-sqlite3';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { SourceMatcher } from '../../src/integrations/sources.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { CampaignsRepo } from '../../src/store/campaigns.ts';
import { LinkDomainsRepo } from '../../src/store/link-domains.ts';
import { ShortLinksRepo } from '../../src/store/short-links.ts';

/** Zależności integracji i skracacza do `buildApiServer` w testach, które ich nie dotyczą. */
export function integrationDeps(db: Database, masterKey: Buffer, resolve: (hostname: string) => Promise<string[]> = async () => []) {
  return {
    integrations: new IntegrationsRepo(db, masterKey),
    integrationEvents: new IntegrationEventsRepo(db, masterKey),
    guards: new IntegrationGuardsRepo(db),
    engine: new TemplateEngine(),
    sources: new SourceMatcher(resolve),
    hookLimiter: new RateLimiter(),
    ...linkDeps(db),
  };
}

/** Repozytoria skracacza wymagane przez wspólną drogę wysyłki. */
export function linkDeps(db: Database) {
  return { linkDomains: new LinkDomainsRepo(db), campaigns: new CampaignsRepo(db), shortLinks: new ShortLinksRepo(db) };
}
