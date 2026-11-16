import { describe, expect, it } from 'vitest';
import { measure } from '../../src/mcp/views/client/measure.js';
import { measureText, type EncodingRequest } from '../../src/text/measure.ts';
import { segmentText } from '../../src/text/segment.ts';

// Licznik w widoku musi liczyć tak jak bramka przy przygotowaniu i wysyłce.
const TEXTS = [
  '',
  'Serwis jutro o 9:00.',
  'Przegląd klimatyzacji w czwartek o 9:00.',
  'Kod {A1} [B2] ~ | € ^ \\',
  'a'.repeat(160),
  'a'.repeat(161),
  'a'.repeat(306),
  'a'.repeat(307),
  '€'.repeat(80),
  'a'.repeat(159) + '€',
  'ą'.repeat(70),
  'ą'.repeat(71),
  'ż'.repeat(134) + 'ł',
  'Awaria w hali B 🔧 proszę o kontakt',
  '🔧'.repeat(35),
  '🔧'.repeat(36),
  'a'.repeat(66) + '🔧',
  'Zażółć gęślą jaźń\nNowa linia\r\nI tabulator\t.',
];
const ENCODINGS: EncodingRequest[] = ['auto', 'gsm', 'unicode'];

describe('measure w widoku', () => {
  const cases = TEXTS.flatMap((text) => ENCODINGS.map((encoding) => ({ text, encoding })));

  it('measure zgodne z measureText i segmentText dla ponad 40 przykładów (GSM, rozszerzone, polskie znaki, emoji, granice 160/161 i 70/71)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const { text, encoding } of cases) {
      const m = measureText(text, encoding);
      const expected = { encoding: m.encoding, characters: m.characters, parts: segmentText(text, m, 1000).parts };
      expect(measure(text, encoding), `${encoding}: ${JSON.stringify(text.slice(0, 30))} (${text.length})`).toEqual(expected);
    }
  });
});
