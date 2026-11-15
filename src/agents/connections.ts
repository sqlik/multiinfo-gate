import type { AuthContext } from '../api/auth.ts';
import { API_KEY_PREFIX } from '../api/keys.ts';
import { authFromKey } from '../api/submit.ts';
import type { AgentConfig, AgentScope } from '../integrations/config.ts';
import { resolveKeyAccount } from '../integrations/pipeline.ts';
import type { AccountRow, AccountsRepo } from '../store/accounts.ts';
import type { AgentConnectionRow, AgentConnectionsRepo, ConnectionMethod } from '../store/agent-connections.ts';
import type { ApiKeyRow, ApiKeysRepo } from '../store/api-keys.ts';
import { isAgent, type IntegrationRow, type IntegrationsRepo } from '../store/integrations.ts';
import type { OAuthRepo } from '../store/oauth.ts';
import { ACCESS_TOKEN_PREFIX, CONNECTION_TOKEN_PREFIX, generateCode, generateSecret, hashSecret } from './codes.ts';
import { normalizeScopes } from './scopes.ts';

const MIN = 60_000;
const DAY = 86_400_000;

/** Ważność kodu jednorazowego w milisekundach; domyślnie 24 godziny. */
export const CODE_VALIDITY = { '15m': 15 * MIN, '1h': 60 * MIN, '24h': DAY, '3d': 3 * DAY, '7d': 7 * DAY } as const;
/** Ważność połączenia w dniach; domyślnie 90 dni. Połączenie nigdy nie trwa dłużej niż klucz API integracji. */
export const CONNECTION_VALIDITY = { '30d': 30, '90d': 90, '365d': 365, none: null } as const;

export type ConnectionState = 'waiting' | 'active' | 'code_expired' | 'expired' | 'revoked';
export type AgentIntegration = IntegrationRow & { kind: 'agent'; config: AgentConfig };

export interface ConnectionContext {
  connection: AgentConnectionRow;
  integration: AgentIntegration;
  key: ApiKeyRow;
  account: AccountRow;
  auth: AuthContext;
  scopes: ReadonlySet<AgentScope>;
}

export type Authenticated = { ok: true; connectionId: number } | { ok: false; code: 'missing' | 'invalid' | 'api_key' };
export type Resolved = { ok: true; ctx: ConnectionContext } | { ok: false; reason: string };

/** Koniec ważności: wcześniejsza z dat połączenia i klucza, liczona przy każdym żądaniu. */
export function effectiveExpiry(c: Pick<AgentConnectionRow, 'expiresAt'>, keyExpiresAt: string | null): string | null {
  if (c.expiresAt === null) return keyExpiresAt;
  if (keyExpiresAt === null) return c.expiresAt;
  return Date.parse(c.expiresAt) <= Date.parse(keyExpiresAt) ? c.expiresAt : keyExpiresAt;
}

const passed = (iso: string | null, now: Date): boolean => iso !== null && Date.parse(iso) <= now.getTime();

/**
 * Stan połączenia do panelu. Połączenie z logowaniem jest aktywne od pierwszego użycia kodu i zostaje aktywne
 * także wtedy, gdy administrator wygenerował nowy kod: dotychczasowe tokeny działają do jego użycia.
 */
export function connectionState(c: AgentConnectionRow, keyExpiresAt: string | null, now: Date): ConnectionState {
  if (c.revokedAt !== null) return 'revoked';
  if (passed(effectiveExpiry(c, keyExpiresAt), now)) return 'expired';
  if (c.method === 'token' || c.codeUsedAt !== null || c.clientId !== null) return 'active';
  return passed(c.codeExpiresAt, now) ? 'code_expired' : 'waiting';
}

/** Wartość nagłówka Authorization: „Bearer <token>” albo sam token. */
function bearer(header: string | undefined): string | null {
  const match = header?.trim().match(/^(?:Bearer\s+)?(\S+)$/i);
  return match ? match[1]! : null;
}

export class ConnectionService {
  constructor(private readonly deps: {
    connections: AgentConnectionsRepo; oauth: OAuthRepo; integrations: IntegrationsRepo; apiKeys: ApiKeysRepo; accounts: AccountsRepo;
  }) {}

  /** Nowe połączenie. `secret` to kod w zapisie z myślnikami albo token; panel pokazuje go raz. */
  create(
    integrationId: number,
    input: { name: string; method: ConnectionMethod; codeValidity: keyof typeof CODE_VALIDITY; validity: keyof typeof CONNECTION_VALIDITY },
    actor: string,
    now: Date,
  ): { id: number; secret: string; secretExpiresAt: string | null } {
    const integration = this.deps.integrations.get(integrationId);
    if (!integration || !isAgent(integration)) throw new Error('Integracja nie istnieje albo nie jest integracją Agent AI.');
    const days = CONNECTION_VALIDITY[input.validity];
    const expiresAt = days === null ? null : new Date(now.getTime() + days * DAY).toISOString();
    const id = this.deps.connections.insert({ integrationId, name: input.name, method: input.method, expiresAt, createdBy: actor, createdAt: now });
    if (input.method === 'token') return { id, secret: this.newToken(id).token, secretExpiresAt: null };
    const { code, expiresAt: secretExpiresAt } = this.newCode(id, input.codeValidity, now);
    return { id, secret: code, secretExpiresAt };
  }

  /** Nowy kod także dla aktywnego połączenia (spec 4.3). Użycie kodu przepina połączenie i unieważnia wcześniejsze tokeny. */
  newCode(id: number, codeValidity: keyof typeof CODE_VALIDITY, now: Date): { code: string; expiresAt: string } {
    const connection = this.usable(id);
    if (connection.method !== 'oauth') throw new Error('Kod jednorazowy dotyczy wyłącznie połączenia z logowaniem.');
    const code = generateCode();
    const expiresAt = new Date(now.getTime() + CODE_VALIDITY[codeValidity]).toISOString();
    this.deps.connections.setCode(id, code.hash, expiresAt);
    return { code: code.display, expiresAt };
  }

  /** Nowy token unieważnia poprzedni. */
  newToken(id: number): { token: string } {
    const connection = this.usable(id);
    if (connection.method !== 'token') throw new Error('Token dotyczy wyłącznie połączenia z kluczem w nagłówku.');
    const secret = generateSecret(CONNECTION_TOKEN_PREFIX);
    this.deps.connections.setToken(id, secret.hash);
    return { token: secret.value };
  }

  revoke(id: number, now: Date): void {
    this.deps.connections.revoke(id, 'admin', now);
  }

  /** Usunąć można wyłącznie połączenie, które nigdy nie działało: czekające na kod albo z kodem po terminie. */
  remove(id: number): void {
    const connection = this.deps.connections.get(id);
    if (!connection) throw new Error('Połączenie nie istnieje.');
    const integration = this.deps.integrations.get(connection.integrationId);
    const key = integration ? this.deps.apiKeys.get(integration.apiKeyId) : undefined;
    const state = connectionState(connection, key?.expiresAt ?? null, new Date());
    if (state !== 'waiting' && state !== 'code_expired') throw new Error('Połączenie, które było używane, można tylko odwołać.');
    this.deps.connections.remove(id);
  }

  /** Nagłówek Authorization: token połączenia albo token dostępu w terminie; klucz API rozpoznany po mig_live_. */
  authenticate(header: string | undefined, now: Date): Authenticated {
    const value = bearer(header);
    if (value === null) return { ok: false, code: 'missing' };
    if (value.startsWith(API_KEY_PREFIX)) return { ok: false, code: 'api_key' };
    let connection: AgentConnectionRow | undefined;
    if (value.startsWith(CONNECTION_TOKEN_PREFIX)) {
      connection = this.deps.connections.findByTokenHash(hashSecret(value));
      if (connection?.method !== 'token') connection = undefined;
    } else if (value.startsWith(ACCESS_TOKEN_PREFIX)) {
      const token = this.deps.oauth.getToken(hashSecret(value));
      if (token?.kind === 'access' && !passed(token.expiresAt, now)) connection = this.deps.connections.get(token.connectionId);
    }
    // Odwołane albo wygasłe połączenie wymaga nowego połączenia, więc token jest nieważny. Powody po stronie
    // integracji, klucza i konta podaje resolve, bo ich usunięcie przywraca połączenie bez nowego kodu.
    if (!connection || connection.revokedAt !== null || passed(connection.expiresAt, now)) return { ok: false, code: 'invalid' };
    return { ok: true, connectionId: connection.id };
  }

  /** Warunki z 4.1: połączenie nieodwołane i w terminie, integracja istnieje i jest włączona, klucz użyteczny (keyUsable), konto bez wstrzymania. */
  resolve(connectionId: number, now: Date): Resolved {
    const connection = this.deps.connections.get(connectionId);
    if (!connection) return { ok: false, reason: 'połączenie nie istnieje' };
    if (connection.revokedAt !== null) return { ok: false, reason: 'połączenie zostało odwołane' };
    if (passed(connection.expiresAt, now)) return { ok: false, reason: 'ważność połączenia minęła' };
    const integration = this.deps.integrations.get(connection.integrationId);
    if (!integration || !isAgent(integration)) return { ok: false, reason: 'integracja nie istnieje' };
    if (integration.enabled !== 1) return { ok: false, reason: 'integracja jest wyłączona' };
    const resolved = resolveKeyAccount(this.deps, integration, now);
    if (!resolved.ok) return { ok: false, reason: resolved.detail };
    return {
      ok: true,
      ctx: {
        connection, integration: integration as AgentIntegration, key: resolved.key, account: resolved.account, auth: authFromKey(resolved.key),
        scopes: new Set(normalizeScopes(integration.config.scopes).scopes),
      },
    };
  }

  private usable(id: number): AgentConnectionRow {
    const connection = this.deps.connections.get(id);
    if (!connection) throw new Error('Połączenie nie istnieje.');
    if (connection.revokedAt !== null) throw new Error('Odwołanego połączenia nie można przywrócić. Załóż nowe połączenie.');
    return connection;
  }
}
