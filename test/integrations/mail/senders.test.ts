import { describe, expect, it } from 'vitest';
import { matchSender } from '../../../src/integrations/mail/senders.ts';

const S = [{ pattern: '@przyklad.pl', recipients: ['48601000001'] }, { pattern: 'jan@przyklad.pl', recipients: ['48601000002'] }, { pattern: 'ups@przyklad.test', recipients: [] }];

describe('matchSender', () => {
  it('pełny adres ma pierwszeństwo przed domeną, porównanie bez wielkości liter', () => {
    expect(matchSender('Jan@PRZYKLAD.pl', S)?.recipients).toEqual(['48601000002']);
    expect(matchSender('anna@przyklad.pl', S)?.pattern).toBe('@przyklad.pl');
    expect(matchSender('UPS@przyklad.test', S)?.pattern).toBe('ups@przyklad.test');
  });
  it('domena nie obejmuje poddomen, pusta lista nie dopasowuje nikogo, pusty From też nie', () => {
    expect(matchSender('jan@mail.przyklad.pl', S)).toBeNull();
    expect(matchSender('jan@przyklad.pl', [])).toBeNull();
    expect(matchSender('', S)).toBeNull();
    expect(matchSender('jan@przyklad.pl.pl', S)).toBeNull();
  });
});
