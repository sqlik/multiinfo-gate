import { measureText, type EncodingRequest } from './measure.ts';
import { segmentText, TooManyPartsError } from './segment.ts';

/**
 * Przycięcie do `maxParts` części tym samym licznikiem, którym API dzieli wiadomości. Kodowanie
 * podaje integracja, w której autor wybiera je sam (Power Automate); pozostałe liczą `auto`.
 */
export function fitToParts(text: string, maxParts: number, encoding: EncodingRequest = 'auto'): { text: string; parts: number; over: boolean } {
  const fits = (candidate: string): number | null => {
    try {
      return segmentText(candidate, measureText(candidate, encoding), maxParts).parts;
    } catch (e) {
      if (e instanceof TooManyPartsError) return null;
      throw e;
    }
  };
  const whole = fits(text);
  if (whole !== null) return { text, parts: whole, over: false };
  // Ucinamy po znakach, aż zmieści się w limicie. Treść w GSM-7 kończą trzy kropki,
  // bo znak wielokropka spoza alfabetu GSM przełączyłby ją na UCS-2.
  const chars = [...text];
  const cutAt = (n: number): string => {
    const head = chars.slice(0, n).join('');
    return measureText(head, encoding).encoding === 'gsm' ? `${head}...` : `${head}…`;
  };
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(cutAt(mid)) !== null) lo = mid;
    else hi = mid - 1;
  }
  const cut = cutAt(lo);
  return { text: cut, parts: fits(cut) ?? maxParts, over: true };
}
