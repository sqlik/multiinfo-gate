import { describe, expect, it } from 'vitest';
import { foldText, matchPrefix } from '../../../src/integrations/group/prefix.ts';

describe('matchPrefix', () => {
  it.each([
    ['serwis jutro', 'serwis', 'jutro'], ['Serwis jutro', 'serwis', 'jutro'], ['SERWIS: jutro', 'serwis', 'jutro'],
    ['serwis : jutro', 'serwis', 'jutro'], ['Serwis:jutro', 'serwis', 'jutro'], ['  serwis\njutro 8:00', 'serwis', 'jutro 8:00'],
    ['Łódź: odprawa', 'lodz', 'odprawa'], ['lodz odprawa', 'łódź', 'odprawa'],
  ])('%j z prefiksem %s daje treść %j', (text, prefix, body) => expect(matchPrefix(text, prefix)).toEqual({ ok: true, body }));
  it('„serwisant” nie pasuje do „serwis”, a brak prefiksu to no_prefix', () => {
    expect(matchPrefix('serwisant jutro', 'serwis')).toEqual({ ok: false, reason: 'no_prefix' });
    expect(matchPrefix('jutro odprawa', 'serwis')).toEqual({ ok: false, reason: 'no_prefix' });
    expect(matchPrefix('ser', 'serwis')).toEqual({ ok: false, reason: 'no_prefix' });
  });
  it('sam prefiks, także z dwukropkiem, to empty', () => {
    expect(matchPrefix('serwis', 'serwis')).toEqual({ ok: false, reason: 'empty' });
    expect(matchPrefix('Serwis: ', 'serwis')).toEqual({ ok: false, reason: 'empty' });
  });
  it('pusty prefiks przepuszcza całą treść po przycięciu, a pustą odrzuca', () => {
    expect(matchPrefix('  jutro odprawa  ', '')).toEqual({ ok: true, body: 'jutro odprawa' });
    expect(matchPrefix('   ', '')).toEqual({ ok: false, reason: 'empty' });
  });
  it('treść zachowuje oryginalne znaki i wielkość liter', () => {
    expect(matchPrefix('KIEROWNICY Narada w ŚRODĘ', 'kierownicy')).toEqual({ ok: true, body: 'Narada w ŚRODĘ' });
  });
  it('foldText zdejmuje polskie znaki i wielkość liter', () => {
    expect(foldText('ŁÓDŹ ŻERAŃ')).toBe('lodz zeran');
  });
});
