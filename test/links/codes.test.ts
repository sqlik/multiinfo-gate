import { describe, expect, it } from 'vitest';
import { CODE_LENGTH, PLACEHOLDER_CODE, isCode, newCode } from '../../src/links/codes.ts';

describe('newCode', () => {
  it('losuje kod o stałej długości z alfabetu liter i cyfr', () => {
    for (let i = 0; i < 200; i++) {
      const code = newCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(/^[A-Za-z0-9]{7}$/);
    }
  });

  it('pobiera znaki z przekazanego źródła losowości', () => {
    expect(newCode(() => 0)).toBe('AAAAAAA');
    expect(newCode((max) => max - 1)).toBe('9999999');
  });

  it('losuje z alfabetu o 62 znakach', () => {
    const seen: number[] = [];
    newCode((max) => {
      seen.push(max);
      return 0;
    });
    expect(seen).toEqual(Array(7).fill(62));
  });
});

describe('isCode', () => {
  it('przyjmuje kod zastępczy i kod z liter oraz cyfr', () => {
    expect(PLACEHOLDER_CODE).toBe('0000000');
    expect(isCode(PLACEHOLDER_CODE)).toBe(true);
    expect(isCode('aB3xK9q')).toBe(true);
  });

  it('odrzuca wartość o innej długości albo z innymi znakami', () => {
    expect(isCode('abc')).toBe(false);
    expect(isCode('aB3xK9qZ')).toBe(false);
    expect(isCode('aB3-K9q')).toBe(false);
    expect(isCode('aB3xK9ą')).toBe(false);
    expect(isCode('')).toBe(false);
  });
});
