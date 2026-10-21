import { describe, expect, it } from 'vitest';
import { authResultsPass, domainOf } from '../../../src/integrations/mail/auth-results.ts';

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
  it('domainOf zwraca część po małpie małymi literami', () => {
    expect(domainOf('Jan@PRZYKLAD.pl')).toBe('przyklad.pl');
    expect(domainOf('bez-malpy')).toBe('');
  });
});
