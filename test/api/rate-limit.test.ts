import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/api/rate-limit.ts';

describe('RateLimiter', () => {
  it('przepuszcza żądania do wysokości limitu', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 60; i += 1) expect(rl.check(1, 60), `żądanie ${i}`).toBe(true);
    expect(rl.check(1, 60)).toBe(false);
  });

  it('uzupełnia kubełek z upływem czasu', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 60; i += 1) rl.check(1, 60);
    expect(rl.check(1, 60)).toBe(false);
    t += 1000; // jedna sekunda to jeden żeton przy limicie 60 na minutę
    expect(rl.check(1, 60)).toBe(true);
  });

  it('prowadzi osobny kubełek dla każdego klucza', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 60; i += 1) rl.check(1, 60);
    expect(rl.check(1, 60)).toBe(false);
    expect(rl.check(2, 60)).toBe(true);
  });

  it('mapa kubełków ma górną granicę także w ciągu jednej minuty: najstarsze kubełki ustępują nowym', () => {
    const rl = new RateLimiter(() => 0);
    const key = (i: number) => `2001:db8:${(i >>> 16).toString(16)}:${(i & 0xffff).toString(16)}::/64`;
    for (let i = 0; i < 300_000; i += 1) rl.check(key(i), 60);
    expect(rl.size).toBeLessThanOrEqual(100_000);
    expect(rl.size).toBeGreaterThan(80_000);
    // Najnowszy kubełek zostaje: jego żeton jest zużyty.
    for (let i = 0; i < 59; i += 1) rl.check(key(299_999), 60);
    expect(rl.check(key(299_999), 60)).toBe(false);
  });

  it('exhausted sprawdza kubełek bez zużycia żetonu', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    expect(rl.exhausted('a', 2)).toBe(false);
    rl.check('a', 2);
    rl.check('a', 2);
    expect(rl.exhausted('a', 2)).toBe(true);
    expect(rl.exhausted('a', 2)).toBe(true);
    t += 30_000;
    expect(rl.exhausted('a', 2)).toBe(false);
    expect(rl.size).toBe(1);
  });

  it('przy wielu kluczach usuwa kubełki nieużywane od minuty, bo po minucie i tak są pełne', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 10_000; i += 1) rl.check(`203.0.113.${i}`, 60);
    expect(rl.size).toBe(10_000);
    t += 30_000;
    rl.check('aktywny', 60);
    expect(rl.size).toBe(10_001);
    t += 30_000;
    for (let i = 0; i < 60; i += 1) rl.check('aktywny', 60);
    expect(rl.size).toBe(1);
    expect(rl.check('aktywny', 60)).toBe(false);
  });
});
