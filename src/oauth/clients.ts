import { randomBytes } from 'node:crypto';
import { hostTarget, systemResolver } from '../net/private-address.ts';
import type { OAuthClientRow } from '../store/oauth.ts';
import { WindowLimiter } from './limits.ts';
import type { OAuthDeps } from './routes.ts';

/** Pobranie dokumentu metadanych klienta: bez przekierowań, 5 s, 64 KB. */
export type MetadataFetch = (url: string) => Promise<{ status: number; body: string }>;

const FETCH_TIMEOUT_MS = 5000;
const FETCH_LIMIT = 64 * 1024;
const METADATA_CACHE_MS = 86_400_000;
const HOUR = 3_600_000;
const DEFAULT_CLIENT_NAME = 'Aplikacja bez nazwy';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const GRANT_TYPES = ['authorization_code', 'refresh_token'];

/** Bez przekierowań: przekierowanie mogłoby zaprowadzić pobranie w sieć wewnętrzną po sprawdzeniu adresu. */
export const fetchMetadata: MetadataFetch = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
  const declared = Number(res.headers.get('content-length'));
  if (res.body === null || (Number.isFinite(declared) && declared > FETCH_LIMIT)) {
    await res.body?.cancel();
    return { status: res.status, body: '' };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      // Dokument ponad limit jest odrzucany w całości, bo ucięty JSON i tak nie przejdzie sprawdzenia.
      if (size > FETCH_LIMIT) return { status: res.status, body: '' };
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { status: res.status, body: Buffer.concat(chunks).toString('utf8') };
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Adres powrotu: `https://` albo pętla zwrotna `http://` dla aplikacji na komputerze, bez fragmentu i danych logowania. */
export function validRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (uri.includes('#') || url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** Dokładna zgodność; pętla zwrotna `http://` bez porównania portu (RFC 8252). */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let asked: URL;
  try {
    asked = new URL(requested);
  } catch {
    return false;
  }
  if (asked.protocol !== 'http:' || !LOOPBACK_HOSTS.has(asked.hostname)) return false;
  return registered.some((uri) => {
    try {
      const known = new URL(uri);
      return known.protocol === 'http:' && known.hostname === asked.hostname && known.pathname === asked.pathname && known.search === asked.search;
    } catch {
      return false;
    }
  });
}

/** Lista adresów powrotu albo opis błędu. */
function redirectUris(value: unknown): string[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10 || !value.every((u) => typeof u === 'string')) {
    return 'Podaj od 1 do 10 adresów powrotu w polu redirect_uris.';
  }
  const bad = value.find((u) => !validRedirectUri(u));
  if (bad !== undefined) {
    return `Adres powrotu ${bad} nie jest dozwolony. Bramka przyjmuje adresy https:// oraz http://127.0.0.1, http://localhost i http://[::1].`;
  }
  return value;
}

const clientName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';
  return name === '' ? DEFAULT_CLIENT_NAME : name;
};

const registrationLimits = new WeakMap<object, { source: WindowLimiter; all: WindowLimiter }>();

function limitsFor(deps: OAuthDeps): { source: WindowLimiter; all: WindowLimiter } {
  let limits = registrationLimits.get(deps.oauth);
  if (!limits) {
    const clock = () => (deps.now ? deps.now() : new Date()).getTime();
    limits = { source: new WindowLimiter(10, HOUR, clock), all: new WindowLimiter(100, HOUR, clock) };
    registrationLimits.set(deps.oauth, limits);
  }
  return limits;
}

/**
 * Dynamiczna rejestracja klienta (RFC 7591), otwarta, z limitem 10 rejestracji na adres i 100 łącznie na godzinę.
 * Klient zawsze publiczny: bez sekretu, także gdy aplikacja prosi o inną metodę uwierzytelnienia.
 */
export async function registerClient(deps: OAuthDeps, body: unknown, sourceIp: string, now: Date):
  Promise<{ status: 201 | 400 | 429; body: Record<string, unknown> }> {
  const limits = limitsFor(deps);
  if (limits.source.blocked(sourceIp) || limits.all.blocked('*')) {
    return { status: 429, body: { error: 'too_many_requests', error_description: 'Zbyt wiele rejestracji aplikacji. Spróbuj ponownie za godzinę.' } };
  }
  limits.source.hit(sourceIp);
  limits.all.hit('*');
  if (!isObject(body)) return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'Treść rejestracji musi być obiektem JSON.' } };
  const uris = redirectUris(body.redirect_uris);
  if (typeof uris === 'string') return { status: 400, body: { error: 'invalid_redirect_uri', error_description: uris } };
  const name = clientName(body.client_name);
  const applicationType = body.application_type === 'web' || body.application_type === 'native' ? body.application_type : undefined;
  const clientId = `cli_${randomBytes(16).toString('base64url')}`;
  deps.oauth.upsertClient({ clientId, kind: 'dynamic', name, redirectUris: uris, sourceIp, createdAt: now.toISOString(), fetchedAt: null });
  return {
    status: 201,
    body: {
      client_id: clientId, client_id_issued_at: Math.floor(now.getTime() / 1000), client_name: name, redirect_uris: uris,
      grant_types: GRANT_TYPES, response_types: ['code'], token_endpoint_auth_method: 'none',
      ...(applicationType ? { application_type: applicationType } : {}),
    },
  };
}

/** Dokument metadanych klienta pod adresem `client_id`: pobrany raz na dobę, nigdy z sieci wewnętrznej. */
async function metadataClient(deps: OAuthDeps, clientId: string, now: Date): Promise<OAuthClientRow | { error: string }> {
  const cached = deps.oauth.getClient(clientId);
  if (cached?.kind === 'metadata' && cached.fetchedAt !== null && now.getTime() - Date.parse(cached.fetchedAt) < METADATA_CACHE_MS) return cached;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return { error: 'Identyfikator aplikacji nie jest poprawnym adresem.' };
  }
  if (url.pathname === '/' || url.hash !== '' || url.username !== '') {
    return { error: 'Adres dokumentu metadanych aplikacji musi być adresem https:// ze ścieżką.' };
  }
  // Zawsze bez sieci wewnętrznej, także gdy serwer ma MIG_WEBHOOK_ALLOW_PRIVATE: adres podaje obca aplikacja.
  const target = await hostTarget(url.hostname, deps.resolve ?? systemResolver);
  if (target.kind === 'private') return { error: 'Adres dokumentu metadanych aplikacji wskazuje sieć wewnętrzną. Bramka nie pobiera takich adresów.' };
  if (target.kind === 'unresolved') return { error: `Nie można ustalić adresu serwera aplikacji: ${target.reason}.` };
  let res: { status: number; body: string };
  try {
    res = await (deps.fetchMetadata ?? fetchMetadata)(clientId);
  } catch {
    return { error: 'Nie udało się pobrać dokumentu metadanych aplikacji.' };
  }
  if (res.status !== 200) return { error: `Serwer aplikacji odpowiedział kodem ${res.status} na pobranie dokumentu metadanych.` };
  let doc: unknown;
  try {
    doc = JSON.parse(res.body);
  } catch {
    return { error: 'Dokument metadanych aplikacji nie jest poprawnym dokumentem JSON.' };
  }
  if (!isObject(doc) || doc.client_id !== clientId) {
    return { error: 'Pole client_id w dokumencie metadanych aplikacji nie zgadza się z adresem dokumentu.' };
  }
  const uris = redirectUris(doc.redirect_uris);
  if (typeof uris === 'string') return { error: uris };
  if (typeof doc.client_name !== 'string' || doc.client_name.trim() === '') return { error: 'Dokument metadanych aplikacji nie zawiera nazwy aplikacji (client_name).' };
  deps.oauth.upsertClient({
    clientId, kind: 'metadata', name: clientName(doc.client_name), redirectUris: uris, sourceIp: null, createdAt: now.toISOString(), fetchedAt: now.toISOString(),
  });
  return deps.oauth.getClient(clientId)!;
}

/** Klient z rejestracji dynamicznej albo z dokumentu metadanych (`client_id` w postaci adresu `https://`). */
export async function resolveClient(deps: OAuthDeps, clientId: string, now: Date): Promise<OAuthClientRow | { error: string }> {
  if (clientId.startsWith('https://')) return metadataClient(deps, clientId, now);
  const row = deps.oauth.getClient(clientId);
  if (row?.kind === 'dynamic') return row;
  return { error: 'Aplikacja nie jest zarejestrowana w bramce. Usuń łącznik w aplikacji i dodaj go ponownie.' };
}
