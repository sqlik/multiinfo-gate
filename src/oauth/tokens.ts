import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, generateSecret, hashSecret } from '../agents/codes.ts';
import { decryptSecret, encryptSecret } from '../secrets/crypto.ts';
import type { AuthCodeRow } from '../store/oauth.ts';
import type { OAuthDeps } from './routes.ts';

export const AUTH_CODE_TTL_MS = 60_000, ACCESS_TOKEN_TTL_MS = 3_600_000, REFRESH_GRACE_MS = 60_000;

export interface TokenPair { access_token: string; refresh_token: string; expires_in: 3600; token_type: 'Bearer' }
export interface TokenResult { status: 200 | 400; body: Record<string, unknown> }

/** Weryfikator PKCE według RFC 7636: 43-128 znaków z alfabetu adresów bez kodowania. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** PKCE S256: skrót SHA-256 weryfikatora w base64url równy wyzwaniu z żądania autoryzacji. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** Kod autoryzacji ważny 60 sekund; w bazie wyłącznie skrót. */
export function issueAuthCode(deps: Pick<OAuthDeps, 'oauth'>, c: Omit<AuthCodeRow, 'expiresAt'>, now: Date): string {
  const code = randomBytes(32).toString('base64url');
  deps.oauth.insertCode(hashSecret(code), { ...c, expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS).toISOString() });
  return code;
}

/** Token dostępu na godzinę i token odświeżania do końca ważności połączenia. */
export function issuePair(deps: Pick<OAuthDeps, 'oauth'>, connectionId: number, refreshExpiresAt: string | null, now: Date): TokenPair {
  const access = generateSecret(ACCESS_TOKEN_PREFIX);
  const refresh = generateSecret(REFRESH_TOKEN_PREFIX);
  const createdAt = now.toISOString();
  deps.oauth.insertToken(access.hash, { connectionId, kind: 'access', expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(), createdAt });
  deps.oauth.insertToken(refresh.hash, { connectionId, kind: 'refresh', expiresAt: refreshExpiresAt, createdAt });
  return { access_token: access.value, refresh_token: refresh.value, expires_in: 3600, token_type: 'Bearer' };
}

const fail = (error: string, description: string): TokenResult => ({ status: 400, body: { error, error_description: description } });
const INVALID_GRANT = fail('invalid_grant', 'Kod autoryzacji albo token odświeżania jest nieprawidłowy, wykorzystany albo nieaktualny.');
const INVALID_TARGET = fail('invalid_target', 'Bramka wydaje tokeny wyłącznie dla zasobu /mcp tej bramki.');

const field = (body: Record<string, unknown>, name: string): string | undefined => {
  const value = body[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const passed = (iso: string | null, now: Date): boolean => iso !== null && Date.parse(iso) <= now.getTime();

/**
 * Połączenie, któremu wolno wydać tokeny: nieodwołane i w terminie liczonym razem z kluczem integracji przy każdym
 * żądaniu. Przedłużenie klucza przez administratora przywraca więc odświeżanie bez nowego kodu.
 */
function liveConnection(deps: OAuthDeps, connectionId: number, now: Date) {
  const details = deps.connections.details(connectionId);
  if (!details || details.connection.revokedAt !== null || passed(details.expiresAt, now)) return undefined;
  return details;
}

function exchangeCode(deps: OAuthDeps, body: Record<string, unknown>, resource: string, ip: string, now: Date): TokenResult {
  const code = field(body, 'code');
  const verifier = field(body, 'code_verifier');
  const clientId = field(body, 'client_id');
  if (code === undefined || verifier === undefined || clientId === undefined) {
    return fail('invalid_request', 'Wymiana kodu wymaga pól code, code_verifier i client_id.');
  }
  // Kod jest jednorazowy: zostaje zużyty także wtedy, gdy dalsze sprawdzenie się nie powiedzie.
  const row = deps.oauth.takeCode(hashSecret(code), now);
  if (!row) return INVALID_GRANT;
  if ('reused' in row) {
    // Ponowne użycie kodu oznacza, że kod mógł wyciec: tokeny wydane na jego podstawie przestają działać (RFC 6749 4.1.2).
    const details = deps.connections.details(row.reused);
    deps.oauth.deleteForConnection(row.reused);
    if (details) {
      deps.audit.record({
        actor: 'aplikacja', action: 'agent.odwolanie', target: `${details.integrationName ?? 'integracja usunięta'} / ${details.connection.name}`,
        meta: { powod: 'ponowne użycie kodu autoryzacji, tokeny aplikacji usunięte', aplikacja: details.connection.clientName ?? '-' }, ip,
      });
    }
    return INVALID_GRANT;
  }
  const redirectUri = field(body, 'redirect_uri');
  if (row.clientId !== clientId || (redirectUri !== undefined && redirectUri !== row.redirectUri) || !pkceMatches(verifier, row.codeChallenge)) {
    return INVALID_GRANT;
  }
  const asked = field(body, 'resource');
  if (asked !== undefined && asked !== row.resource) return INVALID_TARGET;
  if (row.resource !== resource) return INVALID_TARGET;
  const live = liveConnection(deps, row.connectionId, now);
  if (!live || live.connection.clientId !== clientId) return INVALID_GRANT;
  return { status: 200, body: { ...issuePair(deps, row.connectionId, live.expiresAt, now) } };
}

function refreshPair(deps: OAuthDeps, body: Record<string, unknown>, resource: string, ip: string, now: Date): TokenResult {
  const value = field(body, 'refresh_token');
  if (value === undefined) return fail('invalid_request', 'Odświeżenie wymaga pola refresh_token.');
  const asked = field(body, 'resource');
  if (asked !== undefined && asked !== resource) return INVALID_TARGET;
  const hash = hashSecret(value);
  const token = deps.oauth.getToken(hash);
  if (!token || token.kind !== 'refresh') return INVALID_GRANT;
  const details = deps.connections.details(token.connectionId);
  if (!details) return INVALID_GRANT;
  const clientId = field(body, 'client_id');
  if (clientId !== undefined && clientId !== details.connection.clientId) return INVALID_GRANT;

  if (token.rotatedAt !== null) {
    // Aplikacje bywają odświeżane równolegle: w ciągu 60 sekund od rotacji zużyty token zwraca tę samą nową parę.
    if (token.gracePairEnc !== null && now.getTime() - Date.parse(token.rotatedAt) <= REFRESH_GRACE_MS) {
      return { status: 200, body: JSON.parse(decryptSecret(token.gracePairEnc, deps.masterKey)) as Record<string, unknown> };
    }
    // Późniejsze ponowne użycie oznacza, że token mógł wyciec: połączenie zostaje odwołane.
    if (details.connection.revokedAt === null) {
      deps.connectionsRepo.revoke(details.connection.id, 'reuse', now);
      deps.audit.record({
        actor: 'aplikacja', action: 'agent.odwolanie', target: `${details.integrationName ?? 'integracja usunięta'} / ${details.connection.name}`,
        meta: { powod: 'ponowne użycie zużytego tokenu odświeżania', aplikacja: details.connection.clientName ?? '-' }, ip,
      });
    }
    return INVALID_GRANT;
  }
  const live = liveConnection(deps, token.connectionId, now);
  if (!live) return INVALID_GRANT;
  const pair = issuePair(deps, token.connectionId, live.expiresAt, now);
  deps.oauth.rotate(hash, encryptSecret(JSON.stringify(pair), deps.masterKey), now);
  return { status: 200, body: { ...pair } };
}

/** Punkt `/oauth/token`: wymiana kodu autoryzacji z PKCE albo rotacja tokenu odświeżania. */
export function exchangeToken(deps: OAuthDeps, body: unknown, base: string, ip: string, now: Date): TokenResult {
  const form = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const grant = field(form, 'grant_type');
  const resource = `${base}/mcp`;
  if (grant === 'authorization_code') return exchangeCode(deps, form, resource, ip, now);
  if (grant === 'refresh_token') return refreshPair(deps, form, resource, ip, now);
  if (grant === undefined) return fail('invalid_request', 'Żądanie nie zawiera pola grant_type.');
  return fail('unsupported_grant_type', 'Bramka obsługuje wyłącznie authorization_code i refresh_token.');
}

/**
 * Punkt `/oauth/revoke` (RFC 7009). Token dostępu usuwa wyłącznie siebie, a token odświeżania wszystkie tokeny
 * połączenia. Połączenie zostaje nieodwołane, więc pracownik łączy aplikację ponownie nowym kodem.
 */
export function revokeToken(deps: Pick<OAuthDeps, 'oauth'>, body: unknown): void {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (typeof value !== 'string' || value === '') return;
  const hash = hashSecret(value);
  const token = deps.oauth.getToken(hash);
  if (!token) return;
  if (token.kind === 'access') deps.oauth.deleteToken(hash);
  else deps.oauth.deleteForConnection(token.connectionId);
}
