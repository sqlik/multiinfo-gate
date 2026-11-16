import { describe, expect, it } from 'vitest';
import { formatCount, rangeError } from '../../src/text/numbers.ts';

describe('liczby w komunikatach panelu', () => {
  it('formatCount: odstęp tysięcy jak w dokumentacji, czterocyfrowe bez odstępu', () => {
    expect(formatCount(50_000)).toBe('50 000');
    expect(formatCount(5000)).toBe('5000');
    expect(formatCount(9)).toBe('9');
  });

  it('rangeError: zakres w tym samym zapisie co dokumentacja', () => {
    expect(rangeError('Limit odbiorców', 1, 50_000)).toBe('Limit odbiorców: podaj liczbę od 1 do 50 000.');
  });
});
