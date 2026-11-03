import { timingSafeEqual } from 'node:crypto';
import type { ApiKeysRepo, ApiKeyRow } from '../store/api-keys.ts';
import { lastValidDay } from '../time/warsaw.ts';
import { API_KEY_PREFIX, hashApiKey, prefixOf } from './keys.ts';

export interface AuthContext {
  apiKeyId: number;
  accountId: number;
  allowedServiceIds: string[];
  allowedOrigs: string[];
  defaultServiceId: string | null;
  defaultOrig: string | null;
  maxParts: number;
  ratePerMin: number;
}

export class AuthError extends Error {
  constructor(readonly httpStatus: 401 | 403, readonly code: string, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Komunikat braku klucza; ten sam tekst stoi w przykładzie opisu API. */
export const MISSING_API_KEY = 'Brak klucza API w nagłówku Authorization. Podaj „Bearer <klucz>” albo sam klucz.';

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authenticate(
  header: string | undefined,
  repo: ApiKeysRepo,
  now: () => Date = () => new Date(),
): AuthContext {
  // Konektory Power Automate wysyłają w nagłówku wartość wpisaną przy połączeniu, bez schematu.
  // Sam klucz rozpoznajemy po przedrostku, żeby inne schematy (Basic, tokeny) nie wyglądały na klucz.
  const match = header?.trim().match(/^(Bearer\s+)?(\S+)$/);
  if (!match || (match[1] === undefined && !match[2]!.startsWith(API_KEY_PREFIX))) {
    throw new AuthError(401, 'missing_api_key', MISSING_API_KEY);
  }

  const key = match[2]!;
  const prefix = prefixOf(key);
  if (!prefix) throw new AuthError(401, 'invalid_api_key', 'Klucz API ma nieprawidłowy format.');

  const hash = hashApiKey(key);
  const row: ApiKeyRow | undefined = repo.findByPrefix(prefix).find((r) => sameHash(r.keyHash, hash));
  if (!row) throw new AuthError(401, 'invalid_api_key', 'Klucz API jest nieznany.');
  if (row.revokedAt) throw new AuthError(401, 'revoked_api_key', 'Klucz API został odwołany.');
  // Wygaśnięcie sprawdzamy na wejściu: wiadomości już w kolejce idą do końca,
  // a odbiorca odpowiedzi ma dostać inny kod niż przy odwołaniu - to inna rozmowa z administratorem.
  if (row.expiresAt !== null && Date.parse(row.expiresAt) <= now().getTime()) {
    throw new AuthError(
      401,
      'expired_api_key',
      `Klucz API wygasł ${lastValidDay(row.expiresAt)}. Poproś administratora bramki o przedłużenie.`,
    );
  }

  repo.touch(row.id);
  return {
    apiKeyId: row.id,
    accountId: row.accountId,
    allowedServiceIds: row.allowedServiceIds,
    allowedOrigs: row.allowedOrigs,
    defaultServiceId: row.defaultServiceId,
    defaultOrig: row.defaultOrig,
    maxParts: row.maxParts,
    ratePerMin: row.ratePerMin,
  };
}
