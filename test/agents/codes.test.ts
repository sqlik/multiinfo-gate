import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_PREFIX, CODE_ALPHABET, CONNECTION_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, generateCode, generateSecret, hashCode, hashSecret, logPrefix, normalizeCode,
} from '../../src/agents/codes.ts';
import { sha256Hex } from '../../src/text/hash.ts';

describe('kody jednorazowe', () => {
  it('alfabet Crockford ma 32 znaki bez I, L, O i U', () => {
    expect(CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(CODE_ALPHABET).toHaveLength(32);
  });

  it('generateCode daje 12 znaków alfabetu w trzech grupach', () => expect(generateCode().display).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/));

  it('skrót kodu liczy się z postaci znormalizowanej, a kolejne kody są różne', () => {
    const code = generateCode();
    expect(code.hash).toBe(hashCode(normalizeCode(code.display)!));
    expect(code.hash).toBe(sha256Hex(`kod:${code.display.replace(/-/g, '')}`));
    expect(new Set(Array.from({ length: 50 }, () => generateCode().display)).size).toBe(50);
  });

  it('normalizeCode przyjmuje małe litery, spacje i O zamiast 0', () => expect(normalizeCode(' k7q2 m9xd-4tbo ')).toBe('K7Q2M9XD4TB0'));

  it('normalizeCode zamienia I i L na 1', () => expect(normalizeCode('i7q2-m9xd-4tbl')).toBe('17Q2M9XD4TB1'));

  it('normalizeCode odrzuca 11 znaków i znak spoza alfabetu', () => {
    expect(normalizeCode('K7Q2-M9XD-4TB')).toBeNull();
    expect(normalizeCode('K7Q2-M9XD-4TBEE')).toBeNull();
    expect(normalizeCode('K7Q2-M9XD-4TBU')).toBeNull();
    expect(normalizeCode('K7Q2-M9XD-4TB!')).toBeNull();
    expect(normalizeCode('')).toBeNull();
  });
});

describe('tokeny', () => {
  it('generateSecret daje przedrostek i 32 bajty base64url, a skrót jest SHA-256 całej wartości', () => {
    for (const prefix of [CONNECTION_TOKEN_PREFIX, ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX]) {
      const secret = generateSecret(prefix);
      expect(secret.value).toMatch(new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`));
      expect(secret.hash).toBe(hashSecret(secret.value));
      expect(secret.hash).toBe(sha256Hex(secret.value));
    }
    expect([CONNECTION_TOKEN_PREFIX, ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX]).toEqual(['mig_mcp_', 'mig_at_', 'mig_rt_']);
  });

  it('logPrefix zostawia 12 pierwszych znaków', () => expect(logPrefix('mig_mcp_abcdefghijklmnop')).toBe('mig_mcp_abcd…'));
});
