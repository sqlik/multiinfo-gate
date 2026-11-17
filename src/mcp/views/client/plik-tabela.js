// Rozpoznanie tabeli z pliku w widoku: rodzaj pliku, wiersz nagłówka, nazwy kolumn i kolumna numeru oraz
// podział wierszy na porcje przesyłane do bramki.

import { decodeBytes, detectSeparator, parseCsv } from './plik-csv.js';
import { readSheet, readWorkbook } from './plik-xlsx.js';

/** Nazwy nagłówka kolumny numeru po złożeniu wielkości liter i polskich znaków. */
export const PHONE_HEADERS = ['numer', 'telefon', 'tel', 'komorka', 'nr telefonu', 'phone', 'msisdn', 'numer telefonu', 'nr tel', 'telefon komorkowy'];

/** Największa liczba wierszy w porcji, ustalona w punkcie kontrolnym A. */
export const UPLOAD_CHUNK = 2500;
/** Największa wielkość wierszy porcji w JSON; porcja 5000 wierszy i 952 KB przeszła w obu aplikacjach AI. */
export const UPLOAD_BYTES = 900 * 1024;
/** Limity pliku, jak FILE_ROWS_MAX i FILE_MEGABYTES_MAX w bramce. */
export const ROWS_MAX = 50_000;
export const FILE_BYTES_MAX = 20 * 1024 * 1024;

/** Udział poprawnych numerów, od którego kolumna bez nazwy z listy jest kolumną numeru. */
const PHONE_SHARE = 0.9;

/** Komunikat o pliku większym niż FILE_BYTES_MAX, także przed odczytem bajtów. */
export const FILE_TOO_BIG = 'Rozmiar pliku przekracza 20 MB, dlatego widok go nie odczyta';
const EMPTY = 'Plik nie zawiera wierszy danych';
const XLS = 'Widok nie odczytuje plików .xls z programu Excel 97-2003. Zapisz plik w Excelu jako „Skoroszyt programu Excel (.xlsx)” albo „CSV UTF-8” i wybierz go ponownie.';
const LOCKED = 'Skoroszyt jest zabezpieczony hasłem, dlatego widok go nie odczyta. Usuń hasło w Excelu albo zapisz plik jako „CSV UTF-8” i wybierz go ponownie.';

/** Numer telefonu: 9-15 cyfr po usunięciu spacji, łączników, nawiasów, kropek i wiodącego plusa, jak w bramce. */
export function looksLikePhone(value) {
  return /^\d{9,15}$/.test(String(value ?? '').replace(/[\s().-]/g, '').replace(/^\+/, ''));
}

/** Litera kolumny jak w Excelu: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const FOLD = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

/** Nazwa do porównań: małe litery bez polskich znaków, pojedyncze spacje, bez kropki i dwukropka na końcu. */
const fold = (name) => name.toLowerCase().replace(/[ąćęłńóśźż]/g, (ch) => FOLD[ch]).replace(/\s+/g, ' ').trim().replace(/[.:]+$/, '');

const isEmptyRow = (cells) => cells.every((c) => String(c ?? '').trim() === '');

/** Liczba kolumn tabeli: do ostatniej niepustej komórki w którymkolwiek wierszu. */
function tableWidth(rows) {
  let width = 0;
  for (const r of rows) {
    for (let i = r.cells.length - 1; i >= width; i -= 1) {
      if (String(r.cells[i] ?? '').trim() !== '') {
        width = i + 1;
        break;
      }
    }
  }
  return width;
}

/**
 * Czy pierwszy niepusty wiersz jest nagłówkiem. Nie jest nim wiersz z numerem telefonu ani wiersz bez nazwy
 * z listy PHONE_HEADERS, w którym pusta komórka stoi nad kolumną numeru rozpoznaną po zawartości dalszych
 * wierszy. W drugim przypadku pierwszy klient nie ma numeru, a jego dane nie mogą stać się nazwami kolumn.
 */
function guessHeader(filled, width) {
  const first = filled[0].cells;
  if (first.some(looksLikePhone)) return false;
  if (first.some((c) => PHONE_HEADERS.includes(fold(String(c ?? ''))))) return true;
  const rest = filled.slice(1);
  if (rest.length === 0) return true;
  for (let i = 0; i < width; i += 1) {
    if (String(first[i] ?? '').trim() !== '') continue;
    if (rest.filter((r) => looksLikePhone(r.cells[i])).length >= PHONE_SHARE * rest.length) return false;
  }
  return true;
}

/**
 * Nagłówek, nazwy kolumn, wiersze danych i kandydatki na kolumnę numeru. Wiersz nagłówka jest pierwszym
 * niepustym wierszem według guessHeader, chyba że `header` określa go wprost. Kolumna bez nazwy
 * otrzymuje nazwę „Kolumna” z literą, a nazwa powtórzona literę w nawiasie. Puste wiersze są pomijane.
 */
export function analyze(rows, { header } = {}) {
  const filled = rows.filter((r) => !isEmptyRow(r.cells));
  if (filled.length === 0) return { header: false, columns: [], data: [], phoneCandidates: [] };
  const width = tableWidth(filled);
  const useHeader = header ?? guessHeader(filled, width);
  const seen = new Set();
  const columns = Array.from({ length: width }, (_, i) => {
    const raw = useHeader ? String(filled[0].cells[i] ?? '').trim() : '';
    const name = raw || `Kolumna ${columnLetter(i)}`;
    if (!seen.has(fold(name))) {
      seen.add(fold(name));
      return name;
    }
    const renamed = `${name} (${columnLetter(i)})`;
    seen.add(fold(renamed));
    return renamed;
  });
  const data = (useHeader ? filled.slice(1) : filled).map((r) => ({
    line: r.line, cells: Array.from({ length: width }, (_, i) => String(r.cells[i] ?? '')),
  }));
  return { header: useHeader, columns, data, phoneCandidates: phoneCandidates(columns, data, useHeader) };
}

/** Kolumna numeru po nazwie nagłówka, a bez nazwy z listy po zawartości: co najmniej 90% poprawnych numerów. */
function phoneCandidates(columns, data, useHeader) {
  const indexes = columns.map((_, i) => i);
  const byName = useHeader ? indexes.filter((i) => PHONE_HEADERS.includes(fold(columns[i]))) : [];
  if (byName.length > 0) return byName;
  if (data.length === 0) return [];
  return indexes.filter((i) => data.filter((r) => looksLikePhone(r.cells[i])).length >= PHONE_SHARE * data.length);
}

const isOle = (b) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
const isZip = (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/**
 * Odczyt pliku według zawartości: archiwum ZIP jako skoroszyt XLSX z pierwszym arkuszem, kontener OLE jako
 * plik .xls albo skoroszyt z hasłem, pozostałe jako CSV. Błąd jest gotowym komunikatem dla pracownika.
 */
export async function readFileBytes(name, bytes) {
  if (bytes.length > FILE_BYTES_MAX) return { error: FILE_TOO_BIG };
  if (bytes.length === 0) return { error: EMPTY };
  if (isOle(bytes)) return { error: /\.xlsx$/i.test(name) ? LOCKED : XLS };
  if (isZip(bytes)) {
    try {
      const book = await readWorkbook(bytes);
      return { kind: 'xlsx', book, sheet: 0, rows: readSheet(book, 0) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const { text, encoding } = decodeBytes(bytes);
  const separator = detectSeparator(text);
  return { kind: 'csv', encoding, separator, rows: parseCsv(text, separator) };
}

const encoder = new TextEncoder();

/**
 * Koniec porcji zaczynającej się od `offset`: najwyżej `size` wierszy, a wiersze porcji zapisane w JSON
 * zajmują najwyżej `bytes` bajtów. Porcja zawiera zawsze co najmniej jeden wiersz.
 */
export function nextChunk(rows, offset, { size = UPLOAD_CHUNK, bytes = UPLOAD_BYTES } = {}) {
  let total = 2;
  let end = offset;
  while (end < rows.length && end - offset < size) {
    const add = encoder.encode(JSON.stringify(rows[end])).length + (end > offset ? 1 : 0);
    if (end > offset && total + add > bytes) break;
    total += add;
    end += 1;
  }
  return end;
}
