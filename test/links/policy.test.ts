import { describe, expect, it } from 'vitest';
import { decideShortening, normalizeDomain, normalizeHost, targetAllowed } from '../../src/links/policy.ts';

describe('decideShortening', () => {
  it.each([
    ['off', undefined, false, null],
    ['off', true, false, 'disabled_by_key'],
    ['off', false, false, null],
    ['sender', undefined, true, null],
    ['sender', true, true, null],
    ['sender', false, false, null],
    ['always', undefined, true, null],
    ['always', true, true, null],
    ['always', false, true, 'forced_by_key'],
  ] as const)('tryb %s, pole %s: skracanie %s, zgłoszenie %s', (mode, requested, shorten, notice) => {
    expect(decideShortening(mode, requested)).toEqual({ shorten, notice });
  });
});

describe('targetAllowed', () => {
  it('obejmuje domenę z listy i jej subdomeny', () => {
    expect(targetAllowed('firma.pl', ['firma.pl'])).toBe(true);
    expect(targetAllowed('oferta.firma.pl', ['firma.pl'])).toBe(true);
    expect(targetAllowed('a.b.firma.pl', ['serwis.pl', 'firma.pl'])).toBe(true);
  });

  it('nie obejmuje domeny o tym samym zakończeniu nazwy', () => {
    expect(targetAllowed('zlafirma.pl', ['firma.pl'])).toBe(false);
  });

  it('nie obejmuje domeny nadrzędnej ani pustej listy', () => {
    expect(targetAllowed('firma.pl', ['oferta.firma.pl'])).toBe(false);
    expect(targetAllowed('firma.pl', [])).toBe(false);
  });
});

describe('normalizeDomain', () => {
  it('zamienia na małe litery i pomija kropkę na końcu', () => {
    expect(normalizeDomain('L.Firma.PL.')).toBe('l.firma.pl');
    expect(normalizeDomain('  firma-link.pl ')).toBe('firma-link.pl');
  });

  it('zapisuje domenę z polskimi znakami w postaci punycode', () => {
    expect(normalizeDomain('łódź.pl')).toBe('xn--d-uga0v4h.pl');
  });

  it.each([
    'https://l.firma.pl',
    'l.firma.pl/oferta',
    'l.firma.pl:8443',
    'l.firma .pl',
    'localhost',
    '',
    '.firma.pl',
    'l..firma.pl',
    'firma_.pl',
    'jan@firma.pl',
    '192.168.1.10',
    '-l.firma.pl',
  ])('odrzuca %j', (raw) => {
    expect(normalizeDomain(raw)).toBeNull();
  });
});

describe('normalizeHost', () => {
  it('zamienia na małe litery, pomija port i kropkę na końcu', () => {
    expect(normalizeHost('L.FIRMA.PL:443')).toBe('l.firma.pl');
    expect(normalizeHost('l.firma.pl.')).toBe('l.firma.pl');
    expect(normalizeHost('l.firma.pl.:8082')).toBe('l.firma.pl');
    expect(normalizeHost('l.firma.pl')).toBe('l.firma.pl');
  });

  it('zwraca null dla braku nagłówka albo pustej wartości', () => {
    expect(normalizeHost(undefined)).toBeNull();
    expect(normalizeHost('')).toBeNull();
    expect(normalizeHost(':443')).toBeNull();
  });
});
