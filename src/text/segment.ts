import { gsmSlotsFor } from './gsm-alphabet.ts';
import type { Measurement } from './measure.ts';

export interface Segmentation {
  parts: number;
  /** Pojemność jednej części w miejscach, zależna od tego, czy wiadomość jest wieloczęściowa. */
  slotsPerPart: number;
  slotsUsed: number;
  /** Ile miejsc zostaje wolnych w ostatniej części. */
  slotsRemaining: number;
  /** Indeksy znaków, na których zaczynają się kolejne części. Puste dla jednej części. */
  boundaries: number[];
}

export class TooManyPartsError extends Error {
  constructor(
    readonly parts: number,
    readonly maxParts: number,
    readonly slotsOver: number,
  ) {
    super(
      `Wiadomość wymaga ${parts} części, a dozwolone jest ${maxParts}. ` +
      `Usuń co najmniej ${slotsOver} miejsc.`,
    );
    this.name = 'TooManyPartsError';
  }
}

const LIMITS = {
  gsm:  { single: 160, multi: 153 },
  ucs2: { single: 70,  multi: 67  },
} as const;

/**
 * Zwraca listę kosztów kolejnych jednostek tekstu wraz z ich długością w indeksach
 * ciągu. Dla GSM-7 jednostką jest znak (punkt kodowy), dla UCS-2 - jednostka UTF-16,
 * ale pary zastępcze traktujemy łącznie, żeby nie rozdzielić ich między części.
 */
function units(text: string, encoding: Measurement['encoding']): Array<{ cost: number; length: number }> {
  const out: Array<{ cost: number; length: number }> = [];
  for (const ch of text) {
    const length = ch.length;
    const cost = encoding === 'ucs2' ? length : (gsmSlotsFor(ch) || 1);
    out.push({ cost, length });
  }
  return out;
}

export function segmentText(text: string, m: Measurement, maxParts: number): Segmentation {
  const limits = LIMITS[m.encoding];
  const list = units(text, m.encoding);

  if (m.slots <= limits.single) {
    return {
      parts: 1,
      slotsPerPart: limits.single,
      slotsUsed: m.slots,
      slotsRemaining: limits.single - m.slots,
      boundaries: [],
    };
  }

  const capacity = limits.multi;
  const boundaries: number[] = [];
  let index = 0;
  let inPart = 0;
  let parts = 1;

  for (const unit of list) {
    if (inPart + unit.cost > capacity) {
      boundaries.push(index);
      parts += 1;
      inPart = 0;
    }
    inPart += unit.cost;
    index += unit.length;
  }

  if (parts > maxParts) {
    throw new TooManyPartsError(parts, maxParts, m.slots - maxParts * capacity);
  }

  return {
    parts,
    slotsPerPart: capacity,
    slotsUsed: m.slots,
    slotsRemaining: capacity - inPart,
    boundaries,
  };
}
