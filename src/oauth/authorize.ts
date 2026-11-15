import { randomBytes } from 'node:crypto';
import { hashCode, normalizeCode } from '../agents/codes.ts';
import { SCOPE_LABELS } from '../agents/scopes.ts';
import { redirectMatches, resolveClient } from './clients.ts';
import { WindowLimiter, sourceKey } from './limits.ts';
import { authorizePage, connectedPage, oauthErrorPage } from './page.ts';
import type { OAuthDeps } from './routes.ts';
import { issueAuthCode } from './tokens.ts';

/** Żądanie połączenia czeka na kod 15 minut; w pamięci najwyżej 1000 żądań, najstarsze ustępują nowym. */
const PENDING_TTL_MS = 15 * 60_000;
const PENDING_MAX = 1000;
/** Nieudane kody: 10 na źródło i 100 łącznie w 15 minutach. 60 bitów kodu przy takim tempie wyklucza zgadywanie. */
const FAILURE_WINDOW_MS = 15 * 60_000;

export const INVALID_CODE = 'Kod jest nieprawidłowy albo nieaktualny. Poproś administratora bramki o nowy kod.';
const EXPIRED_REQUEST = 'Żądanie połączenia wygasło. Wróć do aplikacji i rozpocznij łączenie ponownie.';
const BAD_REDIRECT = 'Adres powrotu nie zgadza się z adresem zarejestrowanym przez aplikację. Usuń łącznik w aplikacji i dodaj go ponownie.';
const NO_CLIENT = 'Żądanie nie zawiera identyfikatora aplikacji. Rozpocznij łączenie ponownie w aplikacji.';
const TOO_MANY = 'Bramka wstrzymała sprawdzanie kodów po zbyt wielu nieudanych próbach. Spróbuj ponownie za 15 minut.';

export type AuthorizeResult = { kind: 'page'; status: number; html: string } | { kind: 'redirect'; location: string };

interface Pending {
  clientId: string; clientName: string; redirectUri: string; codeChallenge: string; state: string | undefined; resource: string; createdAt: number;
}

const text = (query: Record<string, unknown>, name: string): string | undefined => {
  const value = query[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** Adres powrotu z parametrami odpowiedzi; `iss` według RFC 9207, także przy błędzie. */
function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
  return url.toString();
}

const errorPage = (status: number, message: string, title?: string): AuthorizeResult => ({ kind: 'page', status, html: oauthErrorPage(message, title) });

/**
 * Strona połączenia: żądanie autoryzacji z PKCE S256 i formularz z kodem jednorazowym. Stan żądań i liczniki
 * nieudanych prób są w pamięci procesu, dlatego ponowne uruchomienie bramki wymaga rozpoczęcia łączenia od nowa.
 */
export function authorizeFlow(deps: OAuthDeps) {
  const clock = () => (deps.now ? deps.now() : new Date()).getTime();
  const pending = new Map<string, Pending>();
  const failures = { source: new WindowLimiter(10, FAILURE_WINDOW_MS, clock), all: new WindowLimiter(100, FAILURE_WINDOW_MS, clock) };

  const remember = (p: Pending): string => {
    for (const [id, entry] of pending) if (p.createdAt - entry.createdAt >= PENDING_TTL_MS) pending.delete(id);
    while (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value!);
    const id = randomBytes(18).toString('base64url');
    pending.set(id, p);
    return id;
  };

  const lookup = (id: unknown, now: Date): Pending | undefined => {
    const entry = typeof id === 'string' ? pending.get(id) : undefined;
    if (entry && now.getTime() - entry.createdAt >= PENDING_TTL_MS) {
      pending.delete(id as string);
      return undefined;
    }
    return entry;
  };

  /** GET: błąd aplikacji albo adresu powrotu daje stronę bez przekierowania (RFC 6749 4.1.2.1), pozostałe wracają do aplikacji. */
  async function start(query: Record<string, unknown>, base: string, now: Date): Promise<AuthorizeResult> {
    const clientId = text(query, 'client_id');
    if (clientId === undefined) return errorPage(400, NO_CLIENT);
    const client = await resolveClient(deps, clientId, now);
    if ('error' in client) return errorPage(400, client.error);
    const redirectUri = text(query, 'redirect_uri');
    if (redirectUri === undefined || !redirectMatches(client.redirectUris, redirectUri)) return errorPage(400, BAD_REDIRECT);

    const state = text(query, 'state');
    const back = (error: string, description: string): AuthorizeResult =>
      ({ kind: 'redirect', location: withParams(redirectUri, { error, error_description: description, state, iss: base }) });
    if (text(query, 'response_type') !== 'code') return back('unsupported_response_type', 'Bramka obsługuje wyłącznie response_type=code.');
    const codeChallenge = text(query, 'code_challenge');
    if (codeChallenge === undefined || text(query, 'code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      return back('invalid_request', 'Bramka wymaga PKCE z metodą S256.');
    }
    const resource = `${base}/mcp`;
    const asked = text(query, 'resource');
    if (asked !== undefined && asked !== resource) return back('invalid_target', 'Bramka wydaje dostęp wyłącznie do zasobu /mcp tej bramki.');

    const requestId = remember({ clientId, clientName: client.name, redirectUri, codeChallenge, state, resource, createdAt: now.getTime() });
    return { kind: 'page', status: 200, html: authorizePage({ appName: client.name, redirectHost: new URL(redirectUri).host, requestId }) };
  }

  /** POST: kod jednorazowy. Każda przyczyna odmowy daje ten sam komunikat i liczy się do limitu nieudanych prób. */
  function complete(body: Record<string, unknown>, base: string, ip: string, now: Date): AuthorizeResult {
    const source = sourceKey(ip);
    if (failures.source.blocked(source) || failures.all.blocked('*')) return errorPage(429, TOO_MANY, 'Zbyt wiele nieudanych prób');
    const requestId = body.request_id;
    const request = lookup(requestId, now);
    if (!request) return errorPage(400, EXPIRED_REQUEST);

    const refuse = (): AuthorizeResult => {
      failures.source.hit(source);
      failures.all.hit('*');
      return {
        kind: 'page', status: 400,
        html: authorizePage({ appName: request.clientName, redirectHost: new URL(request.redirectUri).host, requestId: requestId as string, error: INVALID_CODE }),
      };
    };
    const normalized = typeof body.code === 'string' ? normalizeCode(body.code) : null;
    if (normalized === null) return refuse();
    const connection = deps.connectionsRepo.findByCodeHash(hashCode(normalized));
    if (!connection || connection.method !== 'oauth' || connection.codeUsedAt !== null || connection.codeExpiresAt === null
      || Date.parse(connection.codeExpiresAt) <= now.getTime()) {
      return refuse();
    }
    const resolved = deps.connections.resolve(connection.id, now);
    if (!resolved.ok) return refuse();

    pending.delete(requestId as string);
    // Nowy klient połączenia: wcześniejsze tokeny i niewymienione kody autoryzacji przestają działać.
    deps.oauth.deleteForConnection(connection.id);
    deps.connectionsRepo.useCode(connection.id, { clientId: request.clientId, clientName: request.clientName }, now);
    deps.oauth.markConnected(request.clientId, now);
    const code = issueAuthCode(deps, {
      connectionId: connection.id, clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, resource: request.resource,
    }, now);

    const scopes = [...resolved.ctx.scopes].map((s) => SCOPE_LABELS[s]);
    const integration = resolved.ctx.integration.name;
    deps.audit.record({
      actor: 'aplikacja', action: 'agent.polaczenie', target: `${integration} / ${connection.name}`,
      meta: { aplikacja: request.clientName, klient: request.clientId, zakresy: scopes }, ip,
    });
    deps.notifier?.notify('agent_connected', `agent:${connection.id}`,
      `${integration}: połączenie ${connection.name} w aplikacji ${request.clientName} z adresu ${ip}. Zakresy: ${scopes.join(', ')}.`, now);
    const redirectUrl = withParams(request.redirectUri, { code, state: request.state, iss: base });
    return { kind: 'page', status: 200, html: connectedPage({ connectionName: connection.name, scopes, redirectUrl }) };
  }

  return { start, complete };
}
