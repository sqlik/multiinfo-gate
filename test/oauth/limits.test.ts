import { describe, expect, it } from 'vitest';
import { WindowLimiter } from '../../src/oauth/limits.ts';

describe('WindowLimiter', () => {
  it('blokuje klucz po limicie w oknie, inne klucze bez zmian, po oknie od nowa', () => {
    let now = 0;
    const limiter = new WindowLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.blocked('203.0.113.10')).toBe(false);
      limiter.hit('203.0.113.10');
    }
    expect(limiter.blocked('203.0.113.10')).toBe(true);
    expect(limiter.blocked('203.0.113.11')).toBe(false);
    now = 59_999;
    expect(limiter.blocked('203.0.113.10')).toBe(true);
    now = 60_000;
    expect(limiter.blocked('203.0.113.10')).toBe(false);
  });
});
