import type { Database } from 'better-sqlite3';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { SourceMatcher } from '../../src/integrations/sources.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';

/** Zależności integracji do `buildApiServer` w testach, które integracji nie dotyczą. */
export function integrationDeps(db: Database, masterKey: Buffer, resolve: (hostname: string) => Promise<string[]> = async () => []) {
  return {
    integrations: new IntegrationsRepo(db, masterKey),
    integrationEvents: new IntegrationEventsRepo(db, masterKey),
    guards: new IntegrationGuardsRepo(db),
    engine: new TemplateEngine(),
    sources: new SourceMatcher(resolve),
    hookLimiter: new RateLimiter(),
  };
}
