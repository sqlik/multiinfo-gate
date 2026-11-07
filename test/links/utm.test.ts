import { describe, expect, it } from 'vitest';
import { retentionPattern, targetPattern, withUtm } from '../../src/links/utm.ts';

const UTM = 'utm_source=sms&utm_medium=sms&utm_campaign=przeglad-klimatyzacji-wiosna';

describe('withUtm', () => {
  it('dopisuje trzy parametry do adresu bez zapytania', () => {
    expect(withUtm('https://firma.pl/oferta', 'przeglad-klimatyzacji-wiosna')).toBe(`https://firma.pl/oferta?${UTM}`);
  });

  it('dopisuje parametry po istniejącym zapytaniu bez zmiany jego zapisu', () => {
    expect(withUtm('https://firma.pl/o?id=5&sig=a%2Fb+c', 'przeglad-klimatyzacji-wiosna')).toBe(
      `https://firma.pl/o?id=5&sig=a%2Fb+c&${UTM}`,
    );
  });

  it('nie dubluje znaku zapytania ani łącznika na końcu adresu', () => {
    expect(withUtm('https://firma.pl/o?', 'przeglad-klimatyzacji-wiosna')).toBe(`https://firma.pl/o?${UTM}`);
    expect(withUtm('https://firma.pl/o?id=5&', 'przeglad-klimatyzacji-wiosna')).toBe(`https://firma.pl/o?id=5&${UTM}`);
  });

  it('koduje nazwę kampanii ze spacją i polskimi znakami', () => {
    expect(withUtm('https://firma.pl/', 'Przegląd wiosna & lato')).toBe(
      'https://firma.pl/?utm_source=sms&utm_medium=sms&utm_campaign=Przegl%C4%85d%20wiosna%20%26%20lato',
    );
  });

  it('pozostawia bez zmian adres z dowolnym parametrem utm_', () => {
    expect(withUtm('https://firma.pl/o?utm_source=newsletter', 'wiosna')).toBe('https://firma.pl/o?utm_source=newsletter');
    expect(withUtm('https://firma.pl/o?a=1&UTM_Content=baner#x', 'wiosna')).toBe('https://firma.pl/o?a=1&UTM_Content=baner#x');
  });

  it('pozostawia kotwicę na końcu adresu', () => {
    expect(withUtm('https://firma.pl/o#sekcja', 'przeglad-klimatyzacji-wiosna')).toBe(`https://firma.pl/o?${UTM}#sekcja`);
    expect(withUtm('https://firma.pl/o?id=5#sekcja', 'przeglad-klimatyzacji-wiosna')).toBe(
      `https://firma.pl/o?id=5&${UTM}#sekcja`,
    );
  });
});

describe('targetPattern', () => {
  it('zastępuje człon ścieżki z cyfrą i wartości zapytania', () => {
    expect(targetPattern('https://firma.pl/klient/10482/przeglad?k=9')).toBe('https://firma.pl/klient/{…}/przeglad?k={…}');
  });

  it('zastępuje każdy człon ścieżki z cyfrą', () => {
    expect(targetPattern('https://firma.pl/umowy/2026/KL-10482/aneks')).toBe('https://firma.pl/umowy/{…}/{…}/aneks');
    expect(targetPattern('https://firma.pl/klient/123/')).toBe('https://firma.pl/klient/{…}/');
  });

  it('zastępuje ostatni człon ścieżki, gdy żaden człon nie zawiera cyfry', () => {
    expect(targetPattern('https://firma.pl/oferta/przeglad')).toBe('https://firma.pl/oferta/{…}');
  });

  it('nie traktuje zakodowanego znaku jako cyfry', () => {
    expect(targetPattern('https://firma.pl/Przegl%C4%85d/oferta')).toBe('https://firma.pl/Przegl%C4%85d/{…}');
  });

  it('zastępuje każdą wartość zapytania i parametr bez znaku =', () => {
    expect(targetPattern('https://firma.pl/o/abc?k=9&t=x&flaga')).toBe('https://firma.pl/o/{…}?k={…}&t={…}&{…}');
    expect(targetPattern('https://firma.pl/oferta?jan.kowalski@firma.pl')).toBe('https://firma.pl/{…}?{…}');
  });

  it('pozostawia adres bez ścieżki', () => {
    expect(targetPattern('https://firma.pl')).toBe('https://firma.pl');
    expect(targetPattern('https://firma.pl/')).toBe('https://firma.pl/');
  });

  it('zastępuje ostatni niepusty człon adresu zakończonego ukośnikiem', () => {
    expect(targetPattern('https://firma.pl/oferty/')).toBe('https://firma.pl/{…}/');
    expect(targetPattern('https://firma.pl/oferta/jan-kowalski/')).toBe('https://firma.pl/oferta/{…}/');
  });

  it('pomija kotwicę', () => {
    expect(targetPattern('https://firma.pl/klient/123#termin')).toBe('https://firma.pl/klient/{…}');
  });
});

describe('retentionPattern', () => {
  it('pozostawia domenę i pierwszy człon ścieżki, a resztę ścieżki zastępuje jednym {…}', () => {
    expect(retentionPattern('https://firma.pl/potwierdz/kQpRxZaBmn/wizyta')).toBe('https://firma.pl/potwierdz/{…}');
    expect(retentionPattern('https://firma.pl/klient/jan-kowalski/przeglad')).toBe('https://firma.pl/klient/{…}');
    expect(retentionPattern('https://firma.pl/oferta/jan-kowalski/')).toBe('https://firma.pl/oferta/{…}');
  });

  it('zastępuje całe zapytanie jednym {…}, także parametr bez znaku =', () => {
    expect(retentionPattern('https://firma.pl/oferta?klient=KL-10482&kod=x')).toBe('https://firma.pl/oferta?{…}');
    expect(retentionPattern('https://firma.pl/oferta/?jan.kowalski@firma.pl')).toBe('https://firma.pl/oferta/?{…}');
  });

  it('pomija dane logowania przed nazwą hosta i kotwicę', () => {
    expect(retentionPattern('https://jan.kowalski@firma.pl/oferta/1#termin')).toBe('https://firma.pl/oferta/{…}');
    expect(retentionPattern('https://jan:haslo@firma.pl:8443/oferta/1')).toBe('https://firma.pl:8443/oferta/{…}');
  });

  it('zastępuje pierwszy człon z cyfrą, z parametrem po średniku albo jedyny człon ścieżki', () => {
    expect(retentionPattern('https://firma.pl/KL-10482')).toBe('https://firma.pl/{…}');
    expect(retentionPattern('https://firma.pl/2026/oferta/aBcDeFgHiJ')).toBe('https://firma.pl/{…}');
    expect(retentionPattern('https://firma.pl/oferta;sesja=jan/1')).toBe('https://firma.pl/{…}');
    expect(retentionPattern('https://firma.pl/jan-kowalski')).toBe('https://firma.pl/{…}');
  });

  it('pozostawia adres bez ścieżki', () => {
    expect(retentionPattern('https://firma.pl')).toBe('https://firma.pl');
    expect(retentionPattern('https://firma.pl/')).toBe('https://firma.pl/');
    expect(retentionPattern('https://firma.pl/?kod=9')).toBe('https://firma.pl/?{…}');
  });
});
