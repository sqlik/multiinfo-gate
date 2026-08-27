import { gsmSlotsFor, isGsmChar } from './gsm-alphabet.ts';

/** Kodowanie faktycznie użyte przy wysyłce. */
export type Encoding = 'gsm' | 'ucs2';

/**
 * Kodowanie zażądane przez klienta.
 * `auto`    - polskie znaki wymuszają UCS-2, żeby zachować pisownię
 * `gsm`     - wymusza GSM-7; Multiinfo zamieni diakrytyki na łacińskie odpowiedniki
 * `unicode` - wymusza UCS-2
 */
export type EncodingRequest = 'auto' | 'gsm' | 'unicode';

export interface Measurement {
  encoding: Encoding;
  /** Liczba jednostek kodowych: znaki w GSM-7, jednostki UTF-16 w UCS-2. */
  characters: number;
  /** Liczba zajętych miejsc; w GSM-7 znaki rozszerzone liczą się podwójnie. */
  slots: number;
}

/** Czy cały tekst da się zapisać w alfabecie GSM. */
function fitsGsm(text: string): boolean {
  for (const ch of text) {
    if (!isGsmChar(ch)) return false;
  }
  return true;
}

export function measureText(text: string, requested: EncodingRequest): Measurement {
  const encoding: Encoding =
    requested === 'unicode' ? 'ucs2'
    : requested === 'gsm' ? 'gsm'
    : fitsGsm(text) ? 'gsm'
    : 'ucs2';

  if (encoding === 'ucs2') {
    // UCS-2 rozlicza jednostki UTF-16, więc para zastępcza kosztuje dwa miejsca.
    const units = text.length;
    return { encoding, characters: units, slots: units };
  }

  let characters = 0;
  let slots = 0;
  for (const ch of text) {
    characters += 1;
    // Znak spoza alfabetu trafia tu tylko przy wymuszonym GSM-7; Multiinfo
    // zastąpi go odpowiednikiem łacińskim, więc liczymy go jako jedno miejsce.
    slots += gsmSlotsFor(ch) || 1;
  }
  return { encoding, characters, slots };
}
