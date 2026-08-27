import { describe, expect, it } from 'vitest';
import { GSM_EXTENDED, gsmSlotsFor, isGsmChar } from '../../src/text/gsm-alphabet.ts';

describe('alfabet GSM 03.38', () => {
  it('rozpoznaje znaki podstawowe jako jedno miejsce', () => {
    for (const ch of ['A', 'z', '0', ' ', '@', '?', 'É', 'ä']) {
      expect(gsmSlotsFor(ch), ch).toBe(1);
    }
  });

  it('liczy wszystkie dziewięć znaków rozszerzonych podwójnie', () => {
    const expected = ['^', '{', '}', '\\', '[', '~', ']', '|', '€'];
    expect([...GSM_EXTENDED].sort()).toEqual([...expected].sort());
    for (const ch of expected) {
      expect(gsmSlotsFor(ch), ch).toBe(2);
    }
  });

  it('odrzuca polskie znaki diakrytyczne', () => {
    for (const ch of ['ą', 'ć', 'ę', 'ł', 'ń', 'ó', 'ś', 'ź', 'ż']) {
      expect(isGsmChar(ch), ch).toBe(false);
      expect(gsmSlotsFor(ch), ch).toBe(0);
    }
  });

  it('nie myli ó z ö ani ż z ż bez kropki', () => {
    expect(isGsmChar('ö')).toBe(true);
    expect(isGsmChar('ó')).toBe(false);
  });
});
