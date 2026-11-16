import type { Database } from 'better-sqlite3';
import { ConnectionService } from '../../src/agents/connections.ts';
import { defaultAgentConfig, type AgentConfig, type AgentScope } from '../../src/integrations/config.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { AgentConnectionsRepo, type ConnectionMethod } from '../../src/store/agent-connections.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { OAuthRepo } from '../../src/store/oauth.ts';
import { SettingsRepo } from '../../src/store/settings.ts';
import { AuditRepo } from '../../src/store/audit.ts';
import type { OAuthDeps } from '../../src/oauth/routes.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import type { AgentServerDeps, ApiDeps } from '../../src/api/server.ts';
import type { Logger } from '../../src/log.ts';
import { McpSessions } from '../../src/mcp/sessions.ts';
import type { AgentToolDeps, ToolDef } from '../../src/mcp/tools.ts';
import { AgentDraftsRepo } from '../../src/store/agent-drafts.ts';
import { AgentFilesRepo } from '../../src/store/agent-files.ts';
import { FileSendsRepo } from '../../src/store/file-sends.ts';
import { DownloadLinksRepo } from '../../src/store/download-links.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from './api-deps.ts';
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

/** Zależności tras OAuth na bazie z `seedAgent`; adres bramki ustawiony, chyba że `apiUrl: null`. */
export function oauthDeps(db: Database, masterKey: Buffer, over: Partial<OAuthDeps> & { apiUrl?: string | null } = {}): OAuthDeps {
  const { apiUrl = 'https://bramka.serwis.example', ...rest } = over;
  const settings = new SettingsRepo(db);
  if (apiUrl !== null) settings.setApiUrl(apiUrl, AGENT_SEED_AT);
  const connectionsRepo = new AgentConnectionsRepo(db);
  const oauth = new OAuthRepo(db);
  const connections = new ConnectionService({
    connections: connectionsRepo, oauth, integrations: new IntegrationsRepo(db, masterKey), apiKeys: new ApiKeysRepo(db, masterKey), accounts: new AccountsRepo(db, masterKey),
  });
  return {
    settings, oauth, connectionsRepo, connections, audit: new AuditRepo(db), masterKey,
    resolve: async () => ['198.51.100.20'], fetchMetadata: async () => ({ status: 404, body: '' }), now: () => AGENT_SEED_AT, ...rest,
  };
}

/** Zależności agentów w serwerze API: OAuth, szkice wysyłki i plików, wysyłki z pliku, linki do pobrania i sesje MCP. */
export function agentServerDeps(db: Database, masterKey: Buffer, over: Partial<AgentServerDeps> & { apiUrl?: string | null } = {}): AgentServerDeps {
  return {
    drafts: new AgentDraftsRepo(db), files: new AgentFilesRepo(db), fileSends: new FileSendsRepo(db), downloads: new DownloadLinksRepo(db), sessions: new McpSessions(),
    ...oauthDeps(db, masterKey, over),
  } as AgentServerDeps;
}

/** Pełne zależności serwera API z agentami na wspólnej bazie i wspólnym zegarze. */
export function agentApiDeps(db: Database, masterKey: Buffer, over: {
  now?: () => Date; apiUrl?: string | null; tools?: readonly ToolDef[]; log?: Logger;
} = {}): ApiDeps & { agents: AgentServerDeps } {
  const now = over.now ?? (() => AGENT_SEED_AT);
  const agents = agentServerDeps(db, masterKey, {
    now, ...(over.apiUrl !== undefined ? { apiUrl: over.apiUrl } : {}), ...(over.tools ? { tools: over.tools } : {}), ...(over.log ? { log: over.log } : {}),
  });
  return {
    accounts: new AccountsRepo(db, masterKey), apiKeys: new ApiKeysRepo(db, masterKey), messages: new MessagesRepo(db), events: new MessageEventsRepo(db),
    packages: new PackagesRepo(db), jobs: new JobsRepo(db), clients: {} as never, inbound: new InboundMessagesRepo(db),
    rateLimiter: new RateLimiter(() => now().getTime()), ...integrationDeps(db, masterKey), agents, now, ...(over.log ? { log: over.log } : {}),
  };
}

/** To, co serwer API przekazuje narzędziom MCP. */
export function agentToolDeps(db: Database, masterKey: Buffer, over: Parameters<typeof agentApiDeps>[2] = {}): AgentToolDeps {
  const deps = agentApiDeps(db, masterKey, over);
  return { ...deps, ...deps.agents };
}
