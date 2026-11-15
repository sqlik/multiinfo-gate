import type { Database } from 'better-sqlite3';
import { ConnectionService } from '../../src/agents/connections.ts';
import { defaultAgentConfig, type AgentConfig, type AgentScope } from '../../src/integrations/config.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { AgentConnectionsRepo, type ConnectionMethod } from '../../src/store/agent-connections.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { OAuthRepo } from '../../src/store/oauth.ts';
import { accountInput } from '../store/helpers.ts';

/** Chwila, w której pomocnik zakłada integrację i połączenie. */
export const AGENT_SEED_AT = new Date('2026-11-15T08:00:00Z');

/**
 * Konto, klucz API, integracja „Agent AI - dyspozytornia” i połączenie „Ewa Nowak”. Domyślnie połączenie
 * z tokenem w nagłówku, więc `secret` od razu działa pod `/mcp`; dla `method: 'oauth'` `secret` jest kodem.
 */
export function seedAgent(db: Database, masterKey: Buffer, opts: {
  scopes?: AgentScope[]; method?: ConnectionMethod; keyExpiresAt?: string | null; throttle?: Partial<AgentConfig['throttle']>;
} = {}): { keyId: number; accountId: number; integrationId: number; connectionId: number; secret: string; service: ConnectionService } {
  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  const integrations = new IntegrationsRepo(db, masterKey);
  const accountId = accounts.insert(accountInput({ name: 'Serwis Północ' }));
  const keyId = apiKeys.insert({
    accountId, name: 'dyspozytornia', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], expiresAt: opts.keyExpiresAt ?? null,
  });
  const base = defaultAgentConfig();
  const integrationId = integrations.insert({
    name: 'Agent AI - dyspozytornia', kind: 'agent', apiKeyId: keyId, serviceId: null, orig: null, preset: 'agent', enabled: 1,
    config: { ...base, scopes: opts.scopes ?? base.scopes, throttle: { ...base.throttle, ...opts.throttle } },
    secrets: {}, storePayloads: 0, createdAt: AGENT_SEED_AT,
  });
  const service = new ConnectionService({ connections: new AgentConnectionsRepo(db), oauth: new OAuthRepo(db), integrations, apiKeys, accounts });
  const created = service.create(integrationId, { name: 'Ewa Nowak', method: opts.method ?? 'token', codeValidity: '24h', validity: '90d' }, 'admin', AGENT_SEED_AT);
  return { keyId, accountId, integrationId, connectionId: created.id, secret: created.secret, service };
}
