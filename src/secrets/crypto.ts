import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;

export class SecretDecryptionError extends Error {
  constructor(reason: string) {
    super(`Nie udało się odszyfrować sekretu: ${reason}`);
    this.name = 'SecretDecryptionError';
  }
}

/** Zwraca ciąg postaci `v1.<iv>.<tag>.<szyfrogram>`, wszystko w base64url. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.');
}

export function decryptSecret(blob: string, key: Buffer): string {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretDecryptionError('nieznany format zapisu');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    const out = Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]);
    return out.toString('utf8');
  } catch {
    // Nie ujawniamy powodu: zły klucz i naruszona treść wyglądają tak samo.
    throw new SecretDecryptionError('zły klucz główny albo naruszona wartość');
  }
}
