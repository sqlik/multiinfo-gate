import { describe, expect, it, vi } from 'vitest';
import { parseSourceEntry, SourceMatcher } from '../../src/integrations/sources.ts';

describe('parseSourceEntry', () => {
  it('rozpoznaje IP, CIDR i nazwę', () => {
    expect(parseSourceEntry('10.0.0.1')).toEqual({ kind: 'ip' });
    expect(parseSourceEntry('10.0.0.0/8')).toEqual({ kind: 'cidr' });
    expect(parseSourceEntry('2a02:1::1')).toEqual({ kind: 'ip' });
    expect(parseSourceEntry('2a02:1::/32')).toEqual({ kind: 'cidr' });
    expect(parseSourceEntry('dom.dyndns.example')).toEqual({ kind: 'host' });
    expect(parseSourceEntry('10.0.0.0/33')).toBeNull();
    expect(parseSourceEntry('zła nazwa')).toBeNull();
    expect(parseSourceEntry('')).toBeNull();
  });
});

describe('SourceMatcher.allowed', () => {
  it('pusta lista przepuszcza wszystko', async () => {
    const m = new SourceMatcher(async () => []);
    expect(await m.allowed([], '203.0.113.5')).toBe(true);
  });
  it('dopasowuje IP, CIDR IPv4 i IPv6, adres odwzorowany', async () => {
    const m = new SourceMatcher(async () => []);
    expect(await m.allowed(['203.0.113.5'], '203.0.113.5')).toBe(true);
    expect(await m.allowed(['203.0.113.0/24'], '203.0.113.77')).toBe(true);
    expect(await m.allowed(['203.0.113.0/24'], '203.0.114.1')).toBe(false);
    expect(await m.allowed(['2a02:1::/32'], '2a02:1:0:0::9')).toBe(true);
    expect(await m.allowed(['203.0.113.0/24'], '::ffff:203.0.113.9')).toBe(true);
  });
  it('nazwę rozwiązuje i buforuje 60 s', async () => {
    let t = 0;
    const resolve = vi.fn(async () => ['198.51.100.7']);
    const m = new SourceMatcher(resolve, () => t);
    expect(await m.allowed(['nas.dyndns.example'], '198.51.100.7')).toBe(true);
    expect(await m.allowed(['nas.dyndns.example'], '198.51.100.7')).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    t = 61_000;
    await m.allowed(['nas.dyndns.example'], '198.51.100.7');
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it('nazwa bez adresu albo z błędem nie pasuje', async () => {
    const m = new SourceMatcher(async () => { throw new Error('ENOTFOUND'); });
    expect(await m.allowed(['brak.example'], '198.51.100.7')).toBe(false);
  });
});
