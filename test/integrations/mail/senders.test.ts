import { describe, expect, it } from 'vitest';
import { matchSender } from '../../../src/integrations/mail/senders.ts';

const S = [{ pattern: '@sqlik.com', recipients: ['48601000001'] }, { pattern: 'tomek@sqlik.com', recipients: ['48601000002'] }, { pattern: 'ups@przyklad.test', recipients: [] }];

describe('matchSender', () => {
  it('pełny adres ma pierwszeństwo przed domeną, porównanie bez wielkości liter', () => {
    expect(matchSender('Tomek@SQLIK.com', S)?.recipients).toEqual(['48601000002']);
    expect(matchSender('jan@sqlik.com', S)?.pattern).toBe('@sqlik.com');
    expect(matchSender('UPS@przyklad.test', S)?.pattern).toBe('ups@przyklad.test');
  });
  it('domena nie obejmuje poddomen, pusta lista nie dopasowuje nikogo, pusty From też nie', () => {
    expect(matchSender('jan@mail.sqlik.com', S)).toBeNull();
    expect(matchSender('jan@sqlik.com', [])).toBeNull();
    expect(matchSender('', S)).toBeNull();
    expect(matchSender('jan@sqlik.com.pl', S)).toBeNull();
  });
});
