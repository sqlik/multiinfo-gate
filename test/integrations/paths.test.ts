import { describe, expect, it } from 'vitest';
import { InvalidPathError, isValidPath, parsePath, readPath } from '../../src/integrations/paths.ts';

const payload = { contact: { phone: '+48 601 000 001', tags: ['vip', 'pl'] }, alerts: [{ labels: { alertname: 'CPU' } }], 'x-y': 1 };

describe('parsePath', () => {
  it('rozbija kropki i indeksy', () => {
    expect(parsePath('alerts[0].labels.alertname')).toEqual(['alerts', 0, 'labels', 'alertname']);
    expect(parsePath('contact.tags[1]')).toEqual(['contact', 'tags', 1]);
    expect(parsePath('x-y')).toEqual(['x-y']);
  });
  it('odrzuca pustą ścieżkę, podwójną kropkę i indeks bez liczby', () => {
    for (const bad of ['', 'a..b', 'a[]', 'a[x]', '.a', 'a.']) expect(() => parsePath(bad)).toThrow(InvalidPathError);
    expect(isValidPath('a[]')).toBe(false);
  });
});

describe('readPath', () => {
  it('czyta wartości zagnieżdżone i tablice', () => {
    expect(readPath(payload, 'contact.phone')).toBe('+48 601 000 001');
    expect(readPath(payload, 'alerts[0].labels.alertname')).toBe('CPU');
    expect(readPath(payload, 'contact.tags')).toEqual(['vip', 'pl']);
  });
  it('brak pola daje undefined, nie wyjątek', () => {
    expect(readPath(payload, 'contact.email')).toBeUndefined();
    expect(readPath(payload, 'alerts[5].labels')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });
  it('nie sięga do prototypu', () => {
    expect(readPath({}, 'constructor')).toBeUndefined();
    expect(readPath({}, '__proto__')).toBeUndefined();
  });
});
