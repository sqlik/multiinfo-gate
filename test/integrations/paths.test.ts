import { describe, expect, it } from 'vitest';
import { InvalidPathError, isValidPath, maskPath, parsePath, readPath } from '../../src/integrations/paths.ts';

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

describe('maskPath', () => {
  it('zamienia wartość spod ścieżki, nie ruszając reszty', () => {
    const out = maskPath({ api_token: 'tajne', msg: 'x' }, 'api_token') as Record<string, unknown>;
    expect(out).toEqual({ api_token: '(sekret)', msg: 'x' });
  });
  it('sięga w głąb oraz w tablice, zostawiając oryginał nietknięty', () => {
    const wejscie = { auth: { token: 'tajne' }, alerts: [{ key: 'tajne' }] };
    expect(maskPath(wejscie, 'auth.token')).toEqual({ auth: { token: '(sekret)' }, alerts: [{ key: 'tajne' }] });
    expect(maskPath(wejscie, 'alerts[0].key')).toEqual({ auth: { token: 'tajne' }, alerts: [{ key: '(sekret)' }] });
    expect(wejscie.auth.token).toBe('tajne');
  });
  it('brak pola, zła ścieżka oraz prototyp zostawiają ładunek bez zmian', () => {
    expect(maskPath({ msg: 'x' }, 'api_token')).toEqual({ msg: 'x' });
    expect(maskPath({ msg: 'x' }, 'a[]')).toEqual({ msg: 'x' });
    expect(maskPath({ msg: 'x' }, '__proto__')).toEqual({ msg: 'x' });
    expect(maskPath('nie obiekt', 'a')).toBe('nie obiekt');
  });
});
