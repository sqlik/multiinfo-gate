import { describe, expect, it } from 'vitest';
import { measureText } from '../../src/text/measure.ts';
import { TooManyPartsError, segmentText } from '../../src/text/segment.ts';

const seg = (text: string, req: 'auto' | 'gsm' | 'unicode' = 'auto', maxParts = 9) =>
  segmentText(text, measureText(text, req), maxParts);

describe('segmentText', () => {
  it('mieści 160 miejsc GSM-7 w jednej części', () => {
    const s = seg('a'.repeat(160));
    expect(s.parts).toBe(1);
    expect(s.slotsPerPart).toBe(160);
    expect(s.slotsRemaining).toBe(0);
    expect(s.boundaries).toEqual([]);
  });

  it('dzieli 161 miejsc na dwie części po 153', () => {
    const s = seg('a'.repeat(161));
    expect(s.parts).toBe(2);
    expect(s.slotsPerPart).toBe(153);
    expect(s.boundaries).toEqual([153]);
  });

  it('jeden nawias klamrowy przy 160 znakach wymusza podział', () => {
    const s = seg('a'.repeat(159) + '{');
    expect(s.slotsUsed).toBe(161);
    expect(s.parts).toBe(2);
  });

  it('nie przecina znaku rozszerzonego na granicy segmentu', () => {
    // 152 znaki zwykłe, potem klamra: klamra zaczyna się na 152. miejscu
    // i nie zmieści się w 153, więc granica wypada przed nią.
    const s = seg('a'.repeat(152) + '{' + 'b'.repeat(200));
    expect(s.boundaries[0]).toBe(152);
  });

  it('wyznacza granicę po 149 znakach dla tekstu produkcyjnego', () => {
    const text =
      'Przypominamy o wizycie w Spol dnia 26.08 o godz. 10:00, ul. Kolejowa 12. ' +
      'Potwierdz przybycie wpisujac {TAK} lub odwolaj wpisujac {NIE}. ' +
      'Dziekujemy. Prosimy o punktualnosc. Spol';
    const s = seg(text);
    expect(s.parts).toBe(2);
    expect(s.boundaries).toEqual([149]);
    expect(s.slotsUsed).toBe(180);
    expect(s.slotsRemaining).toBe(126);
    expect(text.slice(149)).toBe('rosimy o punktualnosc. Spol');
  });

  it('mieści 70 znaków UCS-2 w jednej części', () => {
    const s = seg('ą'.repeat(70));
    expect(s.parts).toBe(1);
    expect(s.slotsPerPart).toBe(70);
  });

  it('dzieli 71 znaków UCS-2 na dwie części po 67', () => {
    const s = seg('ą'.repeat(71));
    expect(s.parts).toBe(2);
    expect(s.slotsPerPart).toBe(67);
    expect(s.boundaries).toEqual([67]);
  });

  it('nie rozdziela pary zastępczej UTF-16 między części', () => {
    const s = seg('a'.repeat(66) + '\u{1F600}' + 'b'.repeat(100), 'unicode');
    expect(s.boundaries[0]).toBe(66);
  });

  it('odrzuca tekst przekraczający maxParts i podaje nadmiar miejsc', () => {
    try {
      seg('a'.repeat(400), 'auto', 2);
      expect.unreachable('powinien zgłosić TooManyPartsError');
    } catch (e) {
      expect(e).toBeInstanceOf(TooManyPartsError);
      const err = e as TooManyPartsError;
      expect(err.parts).toBe(3);
      expect(err.maxParts).toBe(2);
      expect(err.slotsOver).toBe(400 - 2 * 153);
    }
  });
});
