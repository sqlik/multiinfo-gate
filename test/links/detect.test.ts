import { describe, expect, it } from 'vitest';
import { findLinks, hostOf } from '../../src/links/detect.ts';

const urls = (text: string) => findLinks(text).map((l) => l.url);

describe('findLinks', () => {
  it('pomija kropkę na końcu zdania', () => {
    const text = 'Oferta: https://firma.pl/o?id=5.';
    const [link] = findLinks(text);
    expect(link).toEqual({ start: 8, end: 31, url: 'https://firma.pl/o?id=5' });
    expect(text.slice(link!.start, link!.end)).toBe(link!.url);
  });

  it('pomija nawias zamykający bez pary', () => {
    expect(urls('Szczegóły (https://firma.pl/x) w załączniku')).toEqual(['https://firma.pl/x']);
  });

  it('pomija wykrzyknik', () => {
    expect(urls('Zapraszamy https://firma.pl/x!')).toEqual(['https://firma.pl/x']);
  });

  it('rozpoznaje schemat bez względu na wielkość liter', () => {
    expect(urls('Link HTTPS://FIRMA.PL/a')).toEqual(['HTTPS://FIRMA.PL/a']);
    expect(urls('Link Http://firma.pl/b')).toEqual(['Http://firma.pl/b']);
  });

  it('zachowuje ścieżkę z polskimi znakami w całości', () => {
    expect(urls('Termin: https://firma.pl/przegląd, prosimy o kontakt')).toEqual(['https://firma.pl/przegląd']);
  });

  it('nie rozpoznaje adresu bez schematu', () => {
    expect(findLinks('Odwiedź www.firma.pl albo firma.pl/oferta')).toEqual([]);
  });

  it('znajduje dwa linki w jednej treści', () => {
    const text = 'Oferta https://firma.pl/a i cennik http://firma.pl/b';
    expect(findLinks(text)).toEqual([
      { start: 7, end: 25, url: 'https://firma.pl/a' },
      { start: 35, end: 52, url: 'http://firma.pl/b' },
    ]);
  });

  it('rozpoznaje link na końcu treści bez interpunkcji', () => {
    const text = 'Przegląd klimatyzacji: https://l.firma.pl/aB3xK9q';
    expect(findLinks(text)).toEqual([{ start: 23, end: 49, url: 'https://l.firma.pl/aB3xK9q' }]);
  });

  it('zachowuje zrównoważony nawias wewnątrz adresu', () => {
    expect(urls('Opis https://firma.pl/a_(b) oraz (https://firma.pl/a_(b))')).toEqual([
      'https://firma.pl/a_(b)',
      'https://firma.pl/a_(b)',
    ]);
  });

  it('pomija kilka znaków interpunkcyjnych i cudzysłowy na końcu', () => {
    expect(urls('„https://firma.pl/x”, zobacz też https://firma.pl/y?!… oraz «https://firma.pl/z»')).toEqual([
      'https://firma.pl/x',
      'https://firma.pl/y',
      'https://firma.pl/z',
    ]);
  });

  it('kończy link na białym znaku, także twardej spacji i nowym wierszu', () => {
    expect(urls('https://firma.pl/a dalej\nhttps://firma.pl/b\tkoniec')).toEqual([
      'https://firma.pl/a',
      'https://firma.pl/b',
    ]);
  });

  it('pomija sam schemat bez adresu', () => {
    expect(findLinks('Wpisz https:// oraz http://. w przeglądarce')).toEqual([]);
  });

  it('kończy link przed nawiasem ostrym, także w odnośniku z części tekstowej maila z Outlooka', () => {
    expect(urls('Formularz <https://firma.pl/zgloszenie/48213>')).toEqual(['https://firma.pl/zgloszenie/48213']);
    expect(urls('Szczegóły zgłoszenia<https://firma.pl/zgloszenie/48213>')).toEqual(['https://firma.pl/zgloszenie/48213']);
    expect(urls('https://firma.pl/a<https://firma.pl/a>')).toEqual(['https://firma.pl/a', 'https://firma.pl/a']);
  });

  it('kończy link przed cudzysłowem prostym w środku tekstu', () => {
    expect(urls('<a href="https://firma.pl/oferta">oferta</a>')).toEqual(['https://firma.pl/oferta']);
  });

  it('pomija nawias kwadratowy i klamrowy bez pary, a zachowuje zrównoważony', () => {
    expect(urls('Cennik [https://firma.pl/cennik] oraz {https://firma.pl/regulamin}')).toEqual([
      'https://firma.pl/cennik',
      'https://firma.pl/regulamin',
    ]);
    expect(urls('Lista https://firma.pl/a[1] i https://firma.pl/b{2}')).toEqual(['https://firma.pl/a[1]', 'https://firma.pl/b{2}']);
  });

  it('podaje przesunięcia w jednostkach UTF-16', () => {
    const text = 'Zażółć 😀 https://firma.pl/x';
    const [link] = findLinks(text);
    expect(text.slice(link!.start, link!.end)).toBe('https://firma.pl/x');
  });
});

describe('hostOf', () => {
  it('zwraca host małymi literami bez portu', () => {
    expect(hostOf('HTTPS://Oferta.FIRMA.PL:8443/a?b=1')).toBe('oferta.firma.pl');
  });

  it('zwraca host w postaci punycode', () => {
    expect(hostOf('https://łódź.pl/x')).toBe('xn--d-uga0v4h.pl');
  });

  it('pomija kropkę na końcu hosta', () => {
    expect(hostOf('https://firma.pl./x')).toBe('firma.pl');
  });

  it('zwraca host za znakiem @, a nie nazwę użytkownika', () => {
    expect(hostOf('https://firma.pl@zla-domena.pl/x')).toBe('zla-domena.pl');
  });

  it('zwraca null dla adresu, którego nie można odczytać', () => {
    expect(hostOf('https://')).toBeNull();
    expect(hostOf('https://fir ma.pl')).toBeNull();
  });
});
