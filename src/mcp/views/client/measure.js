// Licznik znaków i części w widoku, zgodny z measureText i segmentText bramki. Alfabet GSM 03.38
// jak w src/text/gsm-alphabet.ts: znaki z tablicy rozszerzonej zajmują dwa miejsca.

const GSM_BASIC = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const GSM_EXTENDED = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);
const PART_LIMITS = { gsm: { single: 160, multi: 153 }, ucs2: { single: 70, multi: 67 } };

/** Miejsca znaku w GSM-7; znak spoza alfabetu przy wymuszonym GSM Multiinfo zamienia na jeden znak łaciński. */
const gsmSlots = (ch) => (GSM_EXTENDED.has(ch) ? 2 : 1);
const isGsm = (ch) => GSM_BASIC.has(ch) || GSM_EXTENDED.has(ch);

/**
 * Kodowanie, liczba znaków i części treści. `encoding` to żądanie: auto, gsm albo unicode. Części liczone
 * jak w bramce: znak albo para zastępcza nie trafia do dwóch części naraz.
 */
export function measure(text, encoding = 'auto') {
  const chars = [...String(text ?? '')];
  const used = encoding === 'unicode' ? 'ucs2' : encoding === 'gsm' ? 'gsm' : chars.every(isGsm) ? 'gsm' : 'ucs2';
  const costs = chars.map((ch) => (used === 'ucs2' ? ch.length : gsmSlots(ch)));
  const slots = costs.reduce((sum, c) => sum + c, 0);
  const characters = used === 'ucs2' ? slots : chars.length;
  const limits = PART_LIMITS[used];
  if (slots <= limits.single) return { encoding: used, characters, parts: 1 };
  let parts = 1;
  let inPart = 0;
  for (const cost of costs) {
    if (inPart + cost > limits.multi) {
      parts += 1;
      inPart = 0;
    }
    inPart += cost;
  }
  return { encoding: used, characters, parts };
}
