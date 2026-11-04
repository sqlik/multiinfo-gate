/**
 * Klient OAuth Microsoftu dla konta technicznego Microsoft 365: aplikacja publiczna z PKCE,
 * bez sekretu klienta (spec 5.1). Moduł nie trzyma stanu; tokeny przechowuje dostawca tokenów.
 * Bramka łączy się wyłącznie z login.microsoftonline.com, a identyfikator katalogu przechodzi
 * walidację, zanim trafi do ścieżki adresu.
 */
import { createHash, randomBytes } from 'node:crypto';

export const M365_SCOPES =
  'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile';
export const M365_IMAP = { host: 'outlook.office365.com', port: 993, security: 'tls', verifyCert: true } as const;
export const M365_SMTP = { host: 'smtp.office365.com', port: 587, security: 'starttls' } as const;

const LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const LOGIN_HOST = 'login.microsoftonline.com';
const TOKEN_TIMEOUT_MS = 15_000;
const MAX_MESSAGE = 500;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`, 'i');

/** Identyfikator katalogu: GUID albo nazwa domeny z co najmniej jedną kropką. */
export function validTenant(t: string): boolean {
  return GUID.test(t) || (t.length <= 253 && DOMAIN.test(t));
}

export function validClientId(c: string): boolean {
  return GUID.test(c);
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(a: { tenant: string; clientId: string; redirectUri: string; state: string; challenge: string }): string {
  if (!validTenant(a.tenant)) throw new Error('Identyfikator katalogu jest nieprawidłowy');
  const u = new URL(`${LOGIN_ORIGIN}/${a.tenant}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({
    client_id: a.clientId, response_type: 'code', redirect_uri: a.redirectUri, response_mode: 'query', scope: M365_SCOPES,
    state: a.state, code_challenge: a.challenge, code_challenge_method: 'S256', prompt: 'select_account',
  }).toString();
  return u.toString();
}

export type TokenFetch = (url: string, form: URLSearchParams) => Promise<{ status: number; body: unknown }>;

/** POST formularza do punktu tokenów; odpowiedź, która nie jest JSON-em, zwraca `body: null`. */
export const fetchToken: TokenFetch = async (url, form) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== LOGIN_HOST) throw new Error(`Niedozwolony adres punktu tokenów: ${u.origin}`);
  const res = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    redirect: 'error',
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

export interface IdClaims { tid?: string; email?: string; preferred_username?: string }
export interface TokenSet { accessToken: string; refreshToken: string; expiresAt: Date; claims: IdClaims | null }

export class M365AuthError extends Error {
  constructor(public readonly kind: 'needs_login' | 'error', public readonly code: string | null, message: string) {
    super(message);
    this.name = 'M365AuthError';
  }
}

/** Odrzucenia, po których pomaga wyłącznie ponowne logowanie administratora. */
const NEEDS_LOGIN = new Set(['invalid_grant', 'interaction_required', 'consent_required', 'invalid_client', 'unauthorized_client']);

export function redeemCode(
  f: TokenFetch,
  a: { tenant: string; clientId: string; redirectUri: string; code: string; verifier: string },
  now: Date,
): Promise<TokenSet> {
  return requestTokens(f, a.tenant, {
    client_id: a.clientId, grant_type: 'authorization_code', code: a.code, redirect_uri: a.redirectUri,
    code_verifier: a.verifier, scope: M365_SCOPES,
  }, now);
}

export function refreshTokens(f: TokenFetch, a: { tenant: string; clientId: string; refreshToken: string }, now: Date): Promise<TokenSet> {
  return requestTokens(f, a.tenant, {
    client_id: a.clientId, grant_type: 'refresh_token', refresh_token: a.refreshToken, scope: M365_SCOPES,
  }, now);
}

async function requestTokens(f: TokenFetch, tenant: string, params: Record<string, string>, now: Date): Promise<TokenSet> {
  if (!validTenant(tenant)) throw new M365AuthError('error', null, 'Identyfikator katalogu jest nieprawidłowy');
  let res: { status: number; body: unknown };
  try {
    res = await f(`${LOGIN_ORIGIN}/${tenant}/oauth2/v2.0/token`, new URLSearchParams(params));
  } catch (err) {
    throw new M365AuthError('error', null, networkMessage(err));
  }
  const body = isRecord(res.body) ? res.body : {};
  if (res.status !== 200) throw rejection(res.status, body);
  return tokenSet(body, now);
}

function tokenSet(body: Record<string, unknown>, now: Date): TokenSet {
  const accessToken = nonEmpty(body.access_token);
  if (accessToken === null) throw new M365AuthError('error', null, 'Odpowiedź Microsoftu nie zawiera tokenu dostępu');
  const refreshToken = nonEmpty(body.refresh_token);
  if (refreshToken === null) throw new M365AuthError('error', null, 'Odpowiedź Microsoftu nie zawiera tokenu odświeżania');
  const expiresIn = typeof body.expires_in === 'string' ? Number(body.expires_in) : body.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new M365AuthError('error', null, 'Odpowiedź Microsoftu nie zawiera czasu ważności tokenu');
  }
  return {
    accessToken, refreshToken, expiresAt: new Date(now.getTime() + expiresIn * 1000),
    claims: typeof body.id_token === 'string' ? claimsOf(body.id_token) : null,
  };
}

function rejection(status: number, body: Record<string, unknown>): M365AuthError {
  const error = typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : null;
  const description = typeof body.error_description === 'string' ? cleanDescription(body.error_description) : '';
  const listed = Array.isArray(body.error_codes) && Number.isInteger(body.error_codes[0]) ? String(body.error_codes[0]) : null;
  const code = aadstsCode(description) ?? listed;
  const kind = (status === 400 || status === 401) && error !== null && NEEDS_LOGIN.has(error) ? 'needs_login' : 'error';
  const message = description !== ''
    ? description
    : error !== null ? `Microsoft odrzucił żądanie tokenu: ${error}` : `Microsoft odpowiedział kodem HTTP ${status}`;
  return new M365AuthError(kind, code, message);
}

/** Opis Microsoftu bez identyfikatorów śledzenia, w jednym wierszu, przycięty. */
export function cleanDescription(d: string): string {
  const cut = d.search(/\s*(?:Trace ID|Correlation ID|Timestamp):/);
  const text = (cut === -1 ? d : d.slice(0, cut)).replace(/\s+/g, ' ').trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

/** Komunikat awarii sieci bez treści wyjątku, która mogłaby powtórzyć dane żądania. */
function networkMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return `Microsoft nie odpowiedział w ciągu ${TOKEN_TIMEOUT_MS / 1000} s`;
  const cause = err instanceof Error && isRecord(err.cause) ? err.cause.code : undefined;
  return typeof cause === 'string' && /^[A-Z_]{2,40}$/.test(cause)
    ? `Brak połączenia z ${LOGIN_HOST}: ${cause}`
    : `Brak połączenia z ${LOGIN_HOST}`;
}

/** Roszczenia z części środkowej id_token. Podpisu bramka nie sprawdza: token przychodzi wprost z punktu tokenów przez TLS. */
function claimsOf(idToken: string): IdClaims | null {
  const part = idToken.split('.')[1];
  if (part === undefined || part === '') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const claims: IdClaims = {};
  if (typeof payload.tid === 'string') claims.tid = payload.tid;
  if (typeof payload.email === 'string') claims.email = payload.email;
  if (typeof payload.preferred_username === 'string') claims.preferred_username = payload.preferred_username;
  return claims;
}

export function aadstsCode(description: string): string | null {
  return /AADSTS(\d+)/.exec(description)?.[1] ?? null;
}

const RELOGIN = 'należy kliknąć „Zaloguj ponownie” w szczegółach konta';

const HINTS: Record<string, string> = {
  '50173': `Microsoft unieważnił logowanie po zmianie hasła konta albo odwołaniu sesji, dlatego ${RELOGIN}`,
  '50133': `Microsoft unieważnił logowanie po zmianie hasła konta albo odwołaniu sesji, dlatego ${RELOGIN}`,
  '700082': `Logowanie wygasło po 90 dniach bez użycia, dlatego ${RELOGIN}`,
  '50076': 'Zasady katalogu wymagają uwierzytelniania wieloskładnikowego, dlatego należy kliknąć „Zaloguj ponownie” i potwierdzić logowanie drugim składnikiem',
  '50079': 'Zasady katalogu wymagają uwierzytelniania wieloskładnikowego, dlatego należy kliknąć „Zaloguj ponownie” i potwierdzić logowanie drugim składnikiem',
  '53003': 'Zasady dostępu warunkowego w Entra ID blokują logowanie, dlatego należy poprosić administratora Microsoft 365 o wyłączenie konta technicznego z tych zasad',
  '65001': 'Zgoda na uprawnienia aplikacji została cofnięta, dlatego należy w Entra ID ponownie udzielić zgody administratora, a następnie kliknąć „Zaloguj ponownie”',
  '7000112': 'Aplikacja została wyłączona w Entra ID, dlatego należy ją ponownie włączyć we właściwościach w sekcji Aplikacje dla przedsiębiorstw',
  '700016': 'Katalog nie zawiera aplikacji o podanym identyfikatorze, dlatego należy sprawdzić identyfikator aplikacji i identyfikator katalogu w ustawieniach konta',
  '50011': 'Rejestracja aplikacji nie zawiera adresu przekierowania bramki, dlatego należy dopisać w Entra ID adres podany w formularzu konta',
};

const GENERAL_HINT = `Microsoft odrzucił logowanie, dlatego ${RELOGIN}, a gdy błąd się powtórzy, sprawdzić rejestrację aplikacji w Entra ID`;

/** Podpowiedź dla administratora według kodu AADSTS; nieznany kod otrzymuje podpowiedź ogólną. */
export function hintFor(code: string | null): string {
  return (code !== null ? HINTS[code] : undefined) ?? GENERAL_HINT;
}

/** Adres skrzynki konta: `email`, a w razie braku `preferred_username`, małymi literami. */
export function addressFromClaims(c: IdClaims | null): string | null {
  for (const v of [c?.email, c?.preferred_username]) {
    const a = v?.trim().toLowerCase();
    if (a !== undefined && a.includes('@')) return a;
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
