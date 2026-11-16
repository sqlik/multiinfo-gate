import { randomBytes } from 'node:crypto';
import { hashCode, normalizeCode } from '../agents/codes.ts';
import { SCOPE_LABELS } from '../agents/scopes.ts';
import { redirectMatches, resolveClient, validRedirectUri } from './clients.ts';
import { WindowLimiter, sourceKey } from './limits.ts';
import { authorizePage, connectedPage, oauthErrorPage } from './page.ts';
import type { OAuthDeps } from './routes.ts';
import { issueAuthCode } from './tokens.ts';

/**
 * Żądanie połączenia czeka na kod 15 minut; w pamięci najwyżej 10 000 żądań, najstarsze ustępują nowym. Jedno źródło
 * otwiera najwyżej 30 żądań w 15 minutach, dlatego wyparcie żądania pracownika wymaga setek adresów.
 */
const PENDING_TTL_MS = 15 * 60_000;
const PENDING_MAX = 10_000;
const STARTS_PER_SOURCE = 30;
/**
 * Nieudane kody: 10 na źródło i 5000 łącznie w 15 minutach. Przy 60 bitach kodu nawet 5000 prób w każdym oknie
 * wyklucza zgadywanie, a blokada wszystkich wymaga 500 adresów. Przekroczenie limitu łącznego zgłasza powiadomienie.
 */
const FAILURE_WINDOW_MS = 15 * 60_000;
const FAILURES_ALL = 5000;

export const INVALID_CODE = 'Kod jest nieprawidłowy albo nieaktualny. Poproś administratora bramki o nowy kod.';
const EXPIRED_REQUEST = 'Żądanie połączenia wygasło. Wróć do aplikacji i rozpocznij łączenie ponownie.';
const BAD_REDIRECT = 'Adres powrotu nie zgadza się z adresem zarejestrowanym przez aplikację. Usuń łącznik w aplikacji i dodaj go ponownie.';
const NO_CLIENT = 'Żądanie nie zawiera identyfikatora aplikacji. Rozpocznij łączenie ponownie w aplikacji.';
const TOO_MANY = 'Bramka wstrzymała sprawdzanie kodów po zbyt wielu nieudanych próbach. Spróbuj ponownie za 15 minut.';
const TOO_MANY_STARTS = 'Z tego adresu rozpoczęto zbyt wiele połączeń. Spróbuj ponownie za 15 minut.';
const CLIENT_GONE = 'Aplikacja nie jest już zarejestrowana w bramce. Wróć do aplikacji i rozpocznij łączenie ponownie.';

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
  const failures = { source: new WindowLimiter(10, FAILURE_WINDOW_MS, clock), all: new WindowLimiter(FAILURES_ALL, FAILURE_WINDOW_MS, clock) };
  const starts = new WindowLimiter(STARTS_PER_SOURCE, PENDING_TTL_MS, clock);
  let alertedAt: number | null = null;

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

  /**
   * GET: każdy błąd żądania daje stronę bez przekierowania. Klienci rejestrują się bez weryfikacji, dlatego
   * przekierowanie z błędem na adres powrotu zamieniłoby bramkę w przekierowanie na dowolną stronę (RFC 9700 4.11.2).
   */
  async function start(query: Record<string, unknown>, base: string, ip: string, now: Date): Promise<AuthorizeResult> {
    const source = sourceKey(ip);
    if (starts.blocked(source)) return errorPage(429, TOO_MANY_STARTS, 'Zbyt wiele połączeń');
    starts.hit(source);
    const clientId = text(query, 'client_id');
    if (clientId === undefined) return errorPage(400, NO_CLIENT);
    // Adres powrotu sprawdzony przed pobraniem dokumentu metadanych: niepełne żądanie niczego nie pobiera.
    const redirectUri = text(query, 'redirect_uri');
    if (redirectUri === undefined || !validRedirectUri(redirectUri)) return errorPage(400, BAD_REDIRECT);
    const client = await resolveClient(deps, clientId, ip, now);
    if ('error' in client) return errorPage(client.status ?? 400, client.error);
    if (!redirectMatches(client.redirectUris, redirectUri)) return errorPage(400, BAD_REDIRECT);

    const state = text(query, 'state');
    if (text(query, 'response_type') !== 'code') return errorPage(400, 'Bramka obsługuje wyłącznie response_type=code. Usuń łącznik w aplikacji i dodaj go ponownie.');
    const codeChallenge = text(query, 'code_challenge');
    if (codeChallenge === undefined || text(query, 'code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      return errorPage(400, 'Bramka wymaga PKCE z metodą S256. Aplikacja nie spełnia tego wymagania.');
    }
    const resource = `${base}/mcp`;
    const asked = text(query, 'resource');
    if (asked !== undefined && asked !== resource) return errorPage(400, 'Bramka wydaje dostęp wyłącznie do zasobu /mcp tej bramki. Sprawdź adres serwera w aplikacji.');

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
      if (failures.all.blocked('*') && (alertedAt === null || clock() - alertedAt >= FAILURE_WINDOW_MS)) {
        alertedAt = clock();
        deps.notifier?.notify('agent_connected', 'agent:kody',
          `Bramka wstrzymała na 15 minut sprawdzanie kodów jednorazowych agentów AI po ${FAILURES_ALL} nieudanych próbach. Do tego czasu nowe połączenia aplikacji nie są możliwe.`, now);
      }
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

    // Użycie kodu jako jedna całość: klient usunięty w międzyczasie przez sprzątanie zostawia kod i dotychczasowe tokeny bez zmian.
    const code = deps.oauth.transaction(() => {
      if (!deps.oauth.getClient(request.clientId)) return null;
      // Nowy klient połączenia: wcześniejsze tokeny i niewymienione kody autoryzacji przestają działać.
      deps.oauth.deleteForConnection(connection.id);
      deps.connectionsRepo.useCode(connection.id, { clientId: request.clientId, clientName: request.clientName }, now);
      deps.oauth.markConnected(request.clientId, now);
      return issueAuthCode(deps, {
        connectionId: connection.id, clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, resource: request.resource,
      }, now);
    });
    pending.delete(requestId as string);
    if (code === null) return errorPage(400, CLIENT_GONE);

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
