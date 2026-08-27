/**
 * Alfabet GSM 03.38. Znaki z tablicy rozszerzonej są w wiadomości poprzedzane
 * znakiem ucieczki, więc zajmują dwa miejsca zamiast jednego.
 *
 * Uwaga: dokumentacja Multiinfo v6.1 wymienia tylko siedem znaków rozszerzonych,
 * pomijając ~ oraz €. Tablica poniżej jest zgodna z normą, nie z dokumentacją.
 */

const BASIC_CHARS =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

export const GSM_BASIC: ReadonlySet<string> = new Set(BASIC_CHARS);

export const GSM_EXTENDED: ReadonlySet<string> = new Set([
  '^', '{', '}', '\\', '[', '~', ']', '|', '€',
]);

/** Czy znak da się zapisać w alfabecie GSM, w tablicy podstawowej lub rozszerzonej. */
export function isGsmChar(ch: string): boolean {
  return GSM_BASIC.has(ch) || GSM_EXTENDED.has(ch);
}

/** Liczba miejsc, jaką znak zajmuje w wiadomości GSM-7. Zero oznacza znak spoza alfabetu. */
export function gsmSlotsFor(ch: string): 0 | 1 | 2 {
  if (GSM_EXTENDED.has(ch)) return 2;
  if (GSM_BASIC.has(ch)) return 1;
  return 0;
}
