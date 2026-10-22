import { describe, expect, it } from 'vitest';
import { authResultsPass, authservIdOf, domainOf, stripComments } from '../../../src/integrations/mail/auth-results.ts';

const AR = (s: string) => [`mx.przyklad.test; ${s}`];

describe('authResultsPass', () => {
  it('dkim=pass z domeną From albo nadrzędną przepuszcza', () => {
    expect(authResultsPass(AR('dkim=pass header.d=przyklad.pl'), 'przyklad.pl')).toBe(true);
    expect(authResultsPass(AR('dkim=pass header.d=przyklad.pl'), 'mail.przyklad.pl')).toBe(true);
    expect(authResultsPass(AR('dkim=pass header.d=inna.pl'), 'przyklad.pl')).toBe(false);
    expect(authResultsPass(AR('dkim=pass header.d=notprzyklad.pl'), 'przyklad.pl')).toBe(false);
    expect(authResultsPass(AR('dkim=pass (2048-bit key) header.d=PRZYKLAD.pl header.i=@przyklad.pl'), 'przyklad.pl')).toBe(true);
  });
  it('spf=pass z mailfrom w domenie From przepuszcza; fail i brak nagłówka nie', () => {
    expect(authResultsPass(AR('spf=pass smtp.mailfrom=bounce.przyklad.pl'), 'przyklad.pl')).toBe(true);
    expect(authResultsPass(AR('spf=pass smtp.mailfrom=jan@przyklad.pl'), 'przyklad.pl')).toBe(true);
    expect(authResultsPass(AR('spf=fail smtp.mailfrom=przyklad.pl; dkim=none'), 'przyklad.pl')).toBe(false);
    expect(authResultsPass(AR('spf=pass smtp.mailfrom=inna.pl'), 'przyklad.pl')).toBe(false);
    expect(authResultsPass([], 'przyklad.pl')).toBe(false);
    expect(authResultsPass(AR('dkim=pass header.d=przyklad.pl'), '')).toBe(false);
  });
  it('liczy się tylko pierwszy nagłówek od góry (serwer skrzynki); nagłówek dopisany niżej przez nadawcę nie przepuszcza', () => {
    expect(authResultsPass([...AR('spf=fail smtp.mailfrom=x.pl; dkim=none'), 'atakujacy.test; dkim=pass header.d=przyklad.pl'], 'przyklad.pl')).toBe(false);
    expect(authResultsPass([...AR('dkim=pass header.d=przyklad.pl'), 'atakujacy.test; spf=fail smtp.mailfrom=x.pl'], 'przyklad.pl')).toBe(true);
  });
  it('z nazwą serwera czytany jest tylko pierwszy nagłówek od góry i musi nosić tę nazwę', () => {
    const forgedBelowForeign = ['atakujacy.test; dkim=pass header.d=przyklad.test', 'mx.google.com; dkim=pass header.d=przyklad.test'];
    expect(authResultsPass(forgedBelowForeign, 'przyklad.test', 'mx.google.com')).toBe(false);
    const forgedBelowGenuine = ['mx.google.com; dkim=fail header.d=przyklad.test', 'mx.google.com; dkim=pass header.d=przyklad.test'];
    expect(authResultsPass(forgedBelowGenuine, 'przyklad.test', 'mx.google.com')).toBe(false);
    expect(authResultsPass(['mx.google.com; dkim=pass header.d=przyklad.test', 'atakujacy.test; dkim=fail'], 'przyklad.test', 'mx.google.com')).toBe(true);
  });
  it('z nazwą serwera brak nagłówka oznacza odmowę; wielkość liter i wersja nie mają znaczenia', () => {
    expect(authResultsPass([], 'przyklad.test', 'mx.google.com')).toBe(false);
    expect(authResultsPass(['MX.Google.com 1; spf=pass smtp.mailfrom=przyklad.test'], 'przyklad.test', 'mx.google.com')).toBe(true);
  });
  it('dkim=pass w komentarzu nie przepuszcza, komentarz przed nazwą serwera nie psuje jej odczytu', () => {
    expect(authResultsPass(['mx.google.com; dkim=fail (dkim=pass header.d=przyklad.test) header.d=przyklad.test'], 'przyklad.test')).toBe(false);
    expect(authservIdOf('(odebrane) mx.google.com 1; dkim=pass')).toBe('mx.google.com');
    expect(authservIdOf('; dkim=pass')).toBeNull();
    expect(stripComments('a (b (c) d) e')).toBe('a  e');
  });
  it('domainOf zwraca część po małpie małymi literami', () => {
    expect(domainOf('Jan@PRZYKLAD.pl')).toBe('przyklad.pl');
    expect(domainOf('bez-malpy')).toBe('');
  });
});
