// Odczyt pliku CSV w widoku: kodowanie znaków, separator kolumn i pola według RFC 4180. Plik nie opuszcza
// komputera pracownika, dlatego czytnik działa w ramce widoku bez bibliotek zewnętrznych.

// MacCentralEurope (tabela Apple CENTEURO) dla bajtów 0x80-0xFF. Excel dla macOS zapisuje w tym kodowaniu
// format „CSV”, a TextDecoder według WHATWG go nie zna.
const MAC_CE_HIGH = 'ÄĀāÉĄÖÜáąČäčĆćéŹźĎíďĒēĖóėôöõúĚěü†°Ę£§•¶ß®©™ę¨≠ģĮįĪ≤≥īĶ∂∑łĻļĽľĹĺŅņŃ¬√ńŇ∆«»… ňŐÕőŌ'
  + '\u2013\u2014“”‘’÷◊ōŔŕŘ‹›řŖŗŠ‚„šŚśÁŤťÍŽžŪÓÔūŮÚůŰűŲųÝýķŻŁżĢˇ';

const POLISH_LETTERS = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g;

const polishCount = (text) => (text.match(POLISH_LETTERS) ?? []).length;

/** Bajty w kodowaniu MacCentralEurope jako tekst. */
function decodeMacCe(bytes) {
  const parts = [];
  for (let start = 0; start < bytes.length; start += 8192) {
    const codes = Array.from(bytes.subarray(start, start + 8192), (b) => (b < 0x80 ? b : MAC_CE_HIGH.charCodeAt(b - 0x80)));
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join('');
}

/**
 * Tekst pliku i rozpoznane kodowanie. Znacznik BOM wskazuje UTF-8 albo UTF-16, a plik bez znacznika jest UTF-8,
 * gdy bajty tworzą poprawny UTF-8. W przeciwnym razie widok wybiera Windows-1250 albo MacCentralEurope według
 * liczby polskich liter, a przy remisie Windows-1250.
 */
export function decodeBytes(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    const cp1250 = new TextDecoder('windows-1250').decode(bytes);
    const mac = decodeMacCe(bytes);
    return polishCount(mac) > polishCount(cp1250) ? { text: mac, encoding: 'x-mac-ce' } : { text: cp1250, encoding: 'windows-1250' };
  }
}

/** Liczba wierszy, z których widok rozpoznaje separator. */
const SEPARATOR_LINES = 20;

/** Separatory w kolejności pierwszeństwa przy remisie. */
export const SEPARATOR_CHARS = [';', '\t', ','];

/**
 * Separator kolumn z pierwszych wierszy: ten, który dzieli najwięcej wierszy na tyle samo pól co pierwszy
 * wiersz, a przy remisie ten z większą liczbą pól i kolejny według SEPARATOR_CHARS. Znaki w cudzysłowach
 * pomijane. Dzięki temu przecinki w polach bez cudzysłowów, typowe dla polskiego Excela, nie przeważają
 * nad średnikiem. Plik bez separatora w pierwszym wierszu ma jedną kolumnę i średnik.
 */
export function detectSeparator(text) {
  const zero = () => ({ ';': 0, '\t': 0, ',': 0 });
  const lines = [];
  let counts = zero();
  let quoted = false;
  for (let i = 0; i < text.length && lines.length < SEPARATOR_LINES; i += 1) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === '\n') {
      lines.push(counts);
      counts = zero();
    } else if (c === ';' || c === '\t' || c === ',') counts[c] += 1;
  }
  if (lines.length < SEPARATOR_LINES) lines.push(counts);
  const used = lines.filter((l) => SEPARATOR_CHARS.some((sep) => l[sep] > 0));
  if (used.length === 0) return ';';
  let best = ';';
  let bestScore = 0;
  let bestFields = 0;
  for (const sep of SEPARATOR_CHARS) {
    const fields = used[0][sep];
    if (fields === 0) continue;
    const score = used.filter((l) => l[sep] === fields).length;
    if (score > bestScore || (score === bestScore && fields > bestFields)) {
      best = sep;
      bestScore = score;
      bestFields = fields;
    }
  }
  return best;
}

/** Koniec pola bez cudzysłowu: separator, znak nowego wiersza albo koniec tekstu. */
function fieldEnd(text, from, separator) {
  let k = from;
  while (k < text.length) {
    const c = text[k];
    if (c === separator || c === '\n' || c === '\r') break;
    k += 1;
  }
  return k;
}

/**
 * Wiersze CSV według RFC 4180: pola w cudzysłowach, podwojony cudzysłów, podział wiersza w polu, końce wierszy
 * `\r\n` i `\n`. Numer wiersza liczony od 1 według wierszy CSV, a znak nowego wiersza na końcu pliku nie tworzy
 * pustego wiersza.
 */
export function parseCsv(text, separator) {
  const rows = [];
  const n = text.length;
  if (n === 0) return rows;
  let i = 0;
  let cells = [];
  for (;;) {
    let value;
    if (text[i] === '"') {
      let out = '';
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) {
          out += text.slice(j);
          j = n;
          break;
        }
        out += text.slice(j, q);
        if (text[q + 1] === '"') {
          out += '"';
          j = q + 2;
          continue;
        }
        j = q + 1;
        break;
      }
      // Znaki po cudzysłowie zamykającym, przed separatorem, dołączane są do pola bez zmian.
      const k = fieldEnd(text, j, separator);
      value = out + text.slice(j, k);
      i = k;
    } else {
      const k = fieldEnd(text, i, separator);
      value = text.slice(i, k);
      i = k;
    }
    cells.push(value);
    if (i >= n) {
      rows.push({ line: rows.length + 1, cells });
      break;
    }
    if (text[i] === separator) {
      i += 1;
      continue;
    }
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    rows.push({ line: rows.length + 1, cells });
    cells = [];
    if (i >= n) break;
  }
  return rows;
}
