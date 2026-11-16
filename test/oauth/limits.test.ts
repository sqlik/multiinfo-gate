import { describe, expect, it } from 'vitest';
import { WindowLimiter, sourceKey } from '../../src/oauth/limits.ts';

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

describe('sourceKey', () => {
  it('adres IPv4 bez zmian, IPv4 w zapisie IPv6 jako IPv4, IPv6 jako sieć /64', () => {
    expect(sourceKey('203.0.113.10')).toBe('203.0.113.10');
    expect(sourceKey('::ffff:203.0.113.10')).toBe('203.0.113.10');
    expect(sourceKey('2001:db8:1:2::1')).toBe(sourceKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(sourceKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(sourceKey('2001:db8:1:3::1')).not.toBe(sourceKey('2001:db8:1:2::1'));
    expect(sourceKey('nie adres')).toBe('nie adres');
  });
});
