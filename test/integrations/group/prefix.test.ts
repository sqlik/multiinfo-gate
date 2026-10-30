import { describe, expect, it } from 'vitest';
import { foldText, matchPrefix } from '../../../src/integrations/group/prefix.ts';

describe('matchPrefix', () => {
  it.each([
    ['dzieci jutro', 'dzieci', 'jutro'], ['Dzieci jutro', 'dzieci', 'jutro'], ['DZIECI: jutro', 'dzieci', 'jutro'],
    ['dzieci : jutro', 'dzieci', 'jutro'], ['Dzieci:jutro', 'dzieci', 'jutro'], ['  dzieci\njutro 8:00', 'dzieci', 'jutro 8:00'],
    ['Żłobek: zbiórka', 'zlobek', 'zbiórka'], ['zlobek zbiórka', 'żłobek', 'zbiórka'],
  ])('%j z prefiksem %s daje treść %j', (text, prefix, body) => expect(matchPrefix(text, prefix)).toEqual({ ok: true, body }));
  it('„dzieciak” nie pasuje do „dzieci”, a brak prefiksu to no_prefix', () => {
    expect(matchPrefix('dzieciak jutro', 'dzieci')).toEqual({ ok: false, reason: 'no_prefix' });
    expect(matchPrefix('jutro zbiórka', 'dzieci')).toEqual({ ok: false, reason: 'no_prefix' });
    expect(matchPrefix('dzi', 'dzieci')).toEqual({ ok: false, reason: 'no_prefix' });
  });
  it('sam prefiks, także z dwukropkiem, to empty', () => {
    expect(matchPrefix('dzieci', 'dzieci')).toEqual({ ok: false, reason: 'empty' });
    expect(matchPrefix('Dzieci: ', 'dzieci')).toEqual({ ok: false, reason: 'empty' });
  });
  it('pusty prefiks przepuszcza całą treść po przycięciu, a pustą odrzuca', () => {
    expect(matchPrefix('  jutro zbiórka  ', '')).toEqual({ ok: true, body: 'jutro zbiórka' });
    expect(matchPrefix('   ', '')).toEqual({ ok: false, reason: 'empty' });
  });
  it('treść zachowuje oryginalne znaki i wielkość liter', () => {
    expect(matchPrefix('RODZICE Zebranie w ŚRODĘ', 'rodzice')).toEqual({ ok: true, body: 'Zebranie w ŚRODĘ' });
  });
  it('foldText zdejmuje polskie znaki i wielkość liter', () => {
    expect(foldText('ŻŁÓBEK')).toBe('zlobek');
  });
});
