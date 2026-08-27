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
});
