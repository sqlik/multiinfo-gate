import { randomBytes, randomInt } from 'node:crypto';
import { sha256Hex } from '../text/hash.ts';

/** Alfabet Crockford: 32 znaki bez I, L, O i U, czytelne przy przepisywaniu kodu z ekranu albo z telefonu. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export const hashCode = (normalized: string): string => sha256Hex(`kod:${normalized}`);

/** Kod jednorazowy: 12 znaków, czyli 60 bitów losowości, w zapisie `XXXX-XXXX-XXXX`. */
export function generateCode(): { display: string; hash: string } {
  const raw = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return { display: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`, hash: hashCode(raw) };
}

/** Wielkie litery, bez spacji i myślników, O jako 0, I i L jako 1. Inny zapis niż 12 znaków alfabetu daje null. */
export function normalizeCode(input: string): string | null {
  const normalized = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_PATTERN.test(normalized) ? normalized : null;
}

export const CONNECTION_TOKEN_PREFIX = 'mig_mcp_', ACCESS_TOKEN_PREFIX = 'mig_at_', REFRESH_TOKEN_PREFIX = 'mig_rt_';

/** Token z przedrostkiem i 32 bajtami losowymi; bramka zapisuje wyłącznie skrót. */
export function generateSecret(prefix: string): { value: string; hash: string } {
  const value = `${prefix}${randomBytes(32).toString('base64url')}`;
  return { value, hash: hashSecret(value) };
}

export const hashSecret = (value: string): string => sha256Hex(value);

/** Do logów i dziennika trafia najwyżej 12 pierwszych znaków tokenu. */
export const logPrefix = (value: string): string => `${value.slice(0, 12)}…`;
