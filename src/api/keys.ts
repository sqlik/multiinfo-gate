import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../text/hash.ts';

const PREFIX = 'mig_live_';
const PREFIX_LENGTH = 8;

/** Skrót klucza; w bazie nigdy nie leży wartość jawna. */
export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const secret = randomBytes(32).toString('base64url');
  const key = `${PREFIX}${secret}`;
  return { key, hash: hashApiKey(key), prefix: secret.slice(0, PREFIX_LENGTH) };
}

/** Wyciąga z klucza część rozpoznawczą, po której szukamy wiersza w bazie. */
export function prefixOf(key: string): string | null {
  if (!key.startsWith(PREFIX)) return null;
  const secret = key.slice(PREFIX.length);
  return secret.length >= PREFIX_LENGTH ? secret.slice(0, PREFIX_LENGTH) : null;
}
