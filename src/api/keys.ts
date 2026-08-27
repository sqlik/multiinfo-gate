import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'mig_live_';
const PREFIX_LENGTH = 8;

/** Skrót klucza; w bazie nigdy nie leży wartość jawna. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
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
