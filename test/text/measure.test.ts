import { describe, expect, it } from 'vitest';
import { measureText } from '../../src/text/measure.ts';

describe('measureText', () => {
  it('liczy tekst ASCII jako GSM-7, jedno miejsce na znak', () => {
    const m = measureText('Ala ma kota', 'auto');
    expect(m).toEqual({ encoding: 'gsm', characters: 11, slots: 11 });
  });

  it('liczy nawiasy klamrowe podwójnie', () => {
    const m = measureText('{TAK}', 'auto');
    expect(m).toEqual({ encoding: 'gsm', characters: 5, slots: 7 });
  });

  it('przechodzi na UCS-2, gdy w trybie auto pojawi się polski znak', () => {
    const m = measureText('Zażółć', 'auto');
    expect(m).toEqual({ encoding: 'ucs2', characters: 6, slots: 6 });
  });

  it('wymusza GSM-7 mimo polskich znaków, gdy zażądano gsm', () => {
    const m = measureText('Zażółć', 'gsm');
    expect(m.encoding).toBe('gsm');
    expect(m.characters).toBe(6);
    expect(m.slots).toBe(6);
  });

  it('wymusza UCS-2 dla czystego ASCII, gdy zażądano unicode', () => {
    const m = measureText('Ala ma kota', 'unicode');
    expect(m).toEqual({ encoding: 'ucs2', characters: 11, slots: 11 });
  });

  it('liczy pary zastępcze UTF-16 jako dwa znaki w UCS-2', () => {
    const m = measureText('\u{1F600}', 'auto');
    expect(m).toEqual({ encoding: 'ucs2', characters: 2, slots: 2 });
  });

  it('mierzy przykładowy tekst produkcyjny: 176 znaków, 180 miejsc', () => {
    const text =
      'Przypominamy o wizycie w Spol dnia 26.08 o godz. 10:00, ul. Kolejowa 12. ' +
      'Potwierdz przybycie wpisujac {TAK} lub odwolaj wpisujac {NIE}. ' +
      'Dziekujemy. Prosimy o punktualnosc. Spol';
    const m = measureText(text, 'auto');
    expect(m.encoding).toBe('gsm');
    expect(m.characters).toBe(176);
    expect(m.slots).toBe(180);
  });
});
