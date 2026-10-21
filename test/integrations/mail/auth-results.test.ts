import { describe, expect, it } from 'vitest';
import { authResultsPass, domainOf } from '../../../src/integrations/mail/auth-results.ts';

const AR = (s: string) => [`mx.przyklad.test; ${s}`];

describe('authResultsPass', () => {
  it('dkim=pass z domeną From albo nadrzędną przepuszcza', () => {
    expect(authResultsPass(AR('dkim=pass header.d=sqlik.com'), 'sqlik.com')).toBe(true);
    expect(authResultsPass(AR('dkim=pass header.d=sqlik.com'), 'mail.sqlik.com')).toBe(true);
    expect(authResultsPass(AR('dkim=pass header.d=inna.pl'), 'sqlik.com')).toBe(false);
    expect(authResultsPass(AR('dkim=pass header.d=notsqlik.com'), 'sqlik.com')).toBe(false);
    expect(authResultsPass(AR('dkim=pass (2048-bit key) header.d=SQLIK.com header.i=@sqlik.com'), 'sqlik.com')).toBe(true);
  });
  it('spf=pass z mailfrom w domenie From przepuszcza; fail i brak nagłówka nie', () => {
    expect(authResultsPass(AR('spf=pass smtp.mailfrom=bounce.sqlik.com'), 'sqlik.com')).toBe(true);
    expect(authResultsPass(AR('spf=pass smtp.mailfrom=jan@sqlik.com'), 'sqlik.com')).toBe(true);
    expect(authResultsPass(AR('spf=fail smtp.mailfrom=sqlik.com; dkim=none'), 'sqlik.com')).toBe(false);
    expect(authResultsPass(AR('spf=pass smtp.mailfrom=inna.pl'), 'sqlik.com')).toBe(false);
    expect(authResultsPass([], 'sqlik.com')).toBe(false);
    expect(authResultsPass(AR('dkim=pass header.d=sqlik.com'), '')).toBe(false);
  });
  it('kilka nagłówków: wystarczy jeden pozytywny', () => {
    expect(authResultsPass([...AR('spf=fail smtp.mailfrom=x.pl'), ...AR('dkim=pass header.d=sqlik.com')], 'sqlik.com')).toBe(true);
  });
  it('domainOf zwraca część po małpie małymi literami', () => {
    expect(domainOf('Tomek@SQLIK.com')).toBe('sqlik.com');
    expect(domainOf('bez-malpy')).toBe('');
  });
});
