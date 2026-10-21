/**
 * Czyszczenie treści maila do SMS-a: odcięcie cytatów, podpisu, stopki oraz fraz podanych
 * przez administratora. Pracuje na tekście po zamianie HTML na tekst (`ParsedMail.textFull`).
 */

/** Zwroty zamykające: linia krótsza niż CLOSING_MAX_LINE znaków zaczynająca się od jednego z nich kończy treść. */
export const CLOSING_PHRASES: readonly string[] = [
  'pozdrawiam', 'z pozdrowieniami', 'z poważaniem', 'z wyrazami szacunku', 'dziękuję',
  'best regards', 'kind regards', 'regards', 'sincerely', 'thanks',
];

/** Nagłówki cytatu: od pierwszej pasującej linii w dół wszystko jest cytatem. */
export const QUOTE_HEADERS: readonly RegExp[] = [
  /^W dniu .+ napisał\(?a?\)?:?\s*$/i,
  /^On .+ wrote:\s*$/i,
  /^-----\s*Original Message\s*-----/i,
  /^-----\s*Wiadomość oryginalna\s*-----/i,
  /^Dnia .+ pisze:\s*$/i,
  /^Le .+ a écrit\s*:/i,
];

/** Blok nagłówków cytatu Outlooka: `Od:` albo `From:` z kolejnymi liniami nagłówków w następnych trzech. */
const QUOTE_BLOCK_START = /^(Od|From):\s.+/i;
const QUOTE_BLOCK_FOLLOW = /^(Wysłano|Sent|Do|To|Temat|Subject):/i;

/** Początki klauzul prawnych traktowane jak stopka. */
export const LEGAL_STARTS: readonly string[] = [
  'ta wiadomość', 'niniejsza wiadomość', 'this e-mail', 'this email', 'this message', 'administratorem danych',
];

export const CLOSING_MAX_LINE = 40;

const lower = (s: string): string => s.toLocaleLowerCase('pl');

const isQuoteLine = (lines: string[], i: number): boolean => {
  const line = lines[i]!;
  if (line.startsWith('>')) return true;
  if (QUOTE_HEADERS.some((re) => re.test(line))) return true;
  if (QUOTE_BLOCK_START.test(line)) {
    for (let j = i + 1; j <= i + 3 && j < lines.length; j += 1) if (QUOTE_BLOCK_FOLLOW.test(lines[j]!)) return true;
  }
  return false;
};

const isSignatureLine = (line: string, cutFrom: string[]): boolean => {
  if (line === '-- ' || line === '--') return true;
  const l = lower(line.trimStart());
  if (l.length < CLOSING_MAX_LINE && CLOSING_PHRASES.some((p) => l.startsWith(p))) return true;
  if (LEGAL_STARTS.some((p) => l.startsWith(p))) return true;
  return cutFrom.some((p) => p !== '' && l.startsWith(lower(p)));
};

/** Porządki białych znaków: spacje na końcach linii, najwyżej jedna pusta linia z rzędu, puste krańce. */
const tidy = (lines: string[]): string => lines
  .map((l) => l.trimEnd())
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export function cleanText(textFull: string, cutFrom: string[]): string {
  const lines = textFull.split(/\r?\n/);
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (isQuoteLine(lines, i) || isSignatureLine(lines[i]!, cutFrom)) { end = i; break; }
  }
  return tidy(lines.slice(0, end));
}
