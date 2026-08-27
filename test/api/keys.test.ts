import { describe, expect, it } from 'vitest';
import { AuthError, authenticate } from '../../src/api/auth.ts';
import { generateApiKey, hashApiKey } from '../../src/api/keys.ts';

/** Atrapa repozytorium: jeden klucz czynny i jeden odwołany. */
function repoWith(rows: Array<Record<string, unknown>>) {
  return {
    findByPrefix: (prefix: string) => rows.filter((r) => r.keyPrefix === prefix),
    touch: () => {},
  } as never;
}

describe('generateApiKey', () => {
  it('tworzy klucz z rozpoznawalnym przedrostkiem', () => {
    const { key, prefix } = generateApiKey();
    expect(key.startsWith('mig_live_')).toBe(true);
    expect(key).toHaveLength('mig_live_'.length + 43);
    expect(prefix).toHaveLength(8);
    expect(key.slice('mig_live_'.length, 'mig_live_'.length + 8)).toBe(prefix);
  });

  it('nie powtarza kluczy', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
  });

  it('zwraca skrót zgodny z hashApiKey', () => {
    const { key, hash } = generateApiKey();
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('authenticate', () => {
  const { key, hash, prefix } = generateApiKey();
  const row = {
    id: 1, accountId: 7, keyHash: hash, keyPrefix: prefix, revokedAt: null, expiresAt: null,
    allowedServiceIds: ['24138'], allowedOrigs: ['Firma Info', 'Firma Wind'],
    defaultServiceId: '24138', defaultOrig: 'Firma Info',
    maxParts: 5, ratePerMin: 60,
  };

  it('przepuszcza poprawny klucz', () => {
    const ctx = authenticate(`Bearer ${key}`, repoWith([row]));
    expect(ctx.apiKeyId).toBe(1);
    expect(ctx.accountId).toBe(7);
    expect(ctx.maxParts).toBe(5);
    expect(ctx.allowedOrigs).toEqual(['Firma Info', 'Firma Wind']);
  });

  it('odrzuca brak nagłówka', () => {
    expect(() => authenticate(undefined, repoWith([row]))).toThrow(AuthError);
  });

  it('odrzuca nagłówek bez schematu Bearer', () => {
    expect(() => authenticate(key, repoWith([row]))).toThrow(AuthError);
  });

  it('odrzuca klucz nieznany', () => {
    const other = generateApiKey();
    expect(() => authenticate(`Bearer ${other.key}`, repoWith([row]))).toThrow(AuthError);
  });

  it('odrzuca klucz odwołany', () => {
    const revoked = { ...row, revokedAt: '2026-08-01 10:00:00' };
    expect(() => authenticate(`Bearer ${key}`, repoWith([revoked]))).toThrow(AuthError);
  });

  it('odrzuca klucz po dacie ważności kodem expired_api_key', () => {
    const expired = { ...row, expiresAt: '2026-09-30T22:00:00.000Z' };
    const after = () => new Date('2026-09-30T22:00:00.000Z');
    expect(() => authenticate(`Bearer ${key}`, repoWith([expired]), after))
      .toThrow(expect.objectContaining({ code: 'expired_api_key', httpStatus: 401 }));
    try {
      authenticate(`Bearer ${key}`, repoWith([expired]), after);
      expect.unreachable('powinien zgłosić AuthError');
    } catch (e) {
      expect((e as Error).message).toBe('Klucz API wygasł 2026-09-30. Poproś administratora bramki o przedłużenie.');
    }
  });

  it('przepuszcza klucz przed datą ważności', () => {
    const valid = { ...row, expiresAt: '2026-09-30T22:00:00.000Z' };
    const before = () => new Date('2026-09-30T21:59:59.999Z');
    expect(authenticate(`Bearer ${key}`, repoWith([valid]), before).apiKeyId).toBe(1);
  });

  it('zwraca status 401 dla problemów z kluczem', () => {
    try {
      authenticate(undefined, repoWith([row]));
      expect.unreachable('powinien zgłosić AuthError');
    } catch (e) {
      expect((e as AuthError).httpStatus).toBe(401);
    }
  });
});
