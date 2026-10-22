/**
 * Czyszczenie treści maila do SMS-a: odcięcie cytatów, podpisu (od nazwy nadawcy, zwrotu
 * zamykającego, podpisu telefonu), stopki (separator, klauzula prawna i rejestrowa) oraz fraz
 * podanych przez administratora. Pracuje na tekście po zamianie HTML na tekst (`ParsedMail.textFull`).
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

/** Zwroty klauzuli rejestrowej: linia zawierająca którykolwiek z nich zaczyna stopkę, także bez nazwy nadawcy. */
export const LEGAL_CONTAINS: readonly string[] = [
  'z siedzibą w', 'zarejestrowana w rejestrze', 'zarejestrowany w rejestrze', 'registered office', 'registered in england',
];

/** Zwroty rejestrowe spotykane też w treści („Sąd Rejonowy wyznaczył termin”): liczą się tylko w linii ze znacznikiem firmy. */
export const LEGAL_WEAK: readonly string[] = ['kapitał zakładowy', 'sąd rejonowy'];
export const COMPANY_MARKERS: readonly string[] = ['krs', 'nip', 'regon', 'sp. z o.o', 'sp. z o. o', 's.a.', 'sp.j.', 'sp.k.', 'ltd', 'gmbh'];

/** Podpisy telefonów i programów pocztowych: początek linii krótszej niż DEVICE_MAX_LINE. */
export const DEVICE_STARTS: readonly string[] = [
  'wysłane z iphone', 'wysłane z ipada', 'wysłane z urządzenia', 'wysłane z aplikacji', 'wysłano z aplikacji',
  'sent from my ', 'get outlook for', 'pobierz aplikację outlook',
];

/** Linia będąca wyłącznie znacznikiem obrazka osadzonego z części tekstowej Outlooka; znika z treści wszędzie. */
export const CID_LINE = /^\[cid:[^\]]*\]$/i;

export const CLOSING_MAX_LINE = 40;
/** „Pobierz aplikację Outlook dla systemu Android” ma 45 znaków; powiadomienie „Wysłano z aplikacji Kamery: …” jest dłuższe. */
export const DEVICE_MAX_LINE = 60;

const lower = (s: string): string => s.toLocaleLowerCase('pl');

/** Nazwa nadawcy i linia podpisu są krótkie; dłuższe nie są porównywane, bo usuwanie nawiasów rośnie z kwadratem długości. */
export const NAME_MAX_LENGTH = 200;

/** Słowa nazwy nadawcy małymi literami, bez przecinków i fragmentów w nawiasach; pusta lista dla nazwy dłuższej niż NAME_MAX_LENGTH. */
export function nameTokens(name: string): string[] {
  if (name.length > NAME_MAX_LENGTH) return [];
  return lower(name.replace(/\([^()]*\)/g, ' ').replace(/,/g, ' ')).split(/\s+/).filter((t) => t !== '');
}

/**
 * Linia równa nazwie nadawcy (ten sam zbiór słów) zaczyna podpis, gdy stoi po pustej linii albo jest całą
 * treścią; nazwa jednowyrazowa nie liczy się, bo „Biuro” bywa treścią, a nazwa pod „Zgłaszający:” jest polem.
 */
const isSenderNameLine = (lines: string[], i: number, nameWords: string[]): boolean => {
  if (nameWords.length < 2) return false;
  const words = nameTokens(lines[i]!);
  if (words.length !== nameWords.length || !words.every((w) => nameWords.includes(w))) return false;
  if (i > 0) return lines[i - 1]!.trim() === '';
  return lines.slice(1).every((l) => l.trim() === '');
};

const isQuoteLine = (lines: string[], i: number): boolean => {
  const line = lines[i]!;
  if (line.startsWith('>')) return true;
  if (QUOTE_HEADERS.some((re) => re.test(line))) return true;
  if (QUOTE_BLOCK_START.test(line)) {
    for (let j = i + 1; j <= i + 3 && j < lines.length; j += 1) if (QUOTE_BLOCK_FOLLOW.test(lines[j]!)) return true;
  }
  return false;
};

const isSignatureLine = (lines: string[], i: number, cutFrom: string[], nameWords: string[]): boolean => {
  const line = lines[i]!;
  if (line === '-- ' || line === '--') return true;
  const l = lower(line.trimStart());
  if (l.length < CLOSING_MAX_LINE && CLOSING_PHRASES.some((p) => l.startsWith(p))) return true;
  if (l.length < DEVICE_MAX_LINE && DEVICE_STARTS.some((p) => l.startsWith(p))) return true;
  if (LEGAL_STARTS.some((p) => l.startsWith(p))) return true;
  if (LEGAL_CONTAINS.some((p) => l.includes(p))) return true;
  if (LEGAL_WEAK.some((p) => l.includes(p)) && COMPANY_MARKERS.some((m) => l.includes(m))) return true;
  if (isSenderNameLine(lines, i, nameWords)) return true;
  return cutFrom.some((p) => p !== '' && l.startsWith(lower(p)));
};

/** Porządki białych znaków: spacje na końcach linii, najwyżej jedna pusta linia z rzędu, puste krańce. */
const tidy = (lines: string[]): string => lines
  .map((l) => l.trimEnd())
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/** Oczyszczona treść: bez znaczników obrazków, od pierwszej linii cytatu albo podpisu w dół nic nie zostaje. */
export function cleanText(textFull: string, cutFrom: string[], senderName = ''): string {
  const lines = textFull.split(/\r?\n/).filter((l) => !CID_LINE.test(l.trim()));
  const nameWords = nameTokens(senderName);
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (isQuoteLine(lines, i) || isSignatureLine(lines, i, cutFrom, nameWords)) { end = i; break; }
  }
  return tidy(lines.slice(0, end));
}
