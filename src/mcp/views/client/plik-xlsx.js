// Odczyt skoroszytu XLSX w widoku: archiwum ZIP, XML skoroszytu, wspólne teksty, style i arkusze. Wartości
// komórek widok formatuje według formatu liczb komórki, tak jak pokazuje je Excel w polskich ustawieniach.
// Czytnik nie korzysta z DOMParser, ponieważ arkusz z 50 000 wierszy jako drzewo DOM zajmuje wielokrotnie
// więcej pamięci niż odczyt kolejnych znaczników.

const NOT_WORKBOOK = 'Plik nie jest skoroszytem programu Excel w formacie .xlsx. Zapisz go w Excelu jako „Skoroszyt programu Excel (.xlsx)” albo „CSV UTF-8”.';
export const BROKEN = 'Widok nie odczytał skoroszytu, ponieważ plik jest uszkodzony. Zapisz go w Excelu ponownie albo jako „CSV UTF-8”.';
const NO_INFLATE = 'Przeglądarka nie odczytuje skoroszytów .xlsx w widoku. Zapisz plik w Excelu jako „CSV UTF-8” i wybierz go ponownie.';

/** Największa łączna wielkość rozpakowanych plików XML skoroszytu. */
const UNZIPPED_MAX = 300 * 1024 * 1024;

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/**
 * Rozpakowanie metodą deflate przez DecompressionStream, z przerwaniem po przekroczeniu zadeklarowanej wielkości.
 * Błąd rozpakowania, w przeglądarce opisany po angielsku, czytnik zamienia na komunikat o uszkodzonym pliku.
 */
async function inflate(data, size) {
  if (typeof DecompressionStream !== 'function') throw new Error(NO_INFLATE);
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(size);
  let at = 0;
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw new Error(BROKEN);
    }
    const { done, value } = chunk;
    if (done) break;
    if (at + value.length > size) {
      await reader.cancel();
      throw new Error(BROKEN);
    }
    out.set(value, at);
    at += value.length;
  }
  if (at !== size) throw new Error(BROKEN);
  return out;
}

/**
 * Pliki XML i relacje z archiwum ZIP według katalogu centralnego, metody 0 (bez kompresji) i 8 (deflate).
 * Pozostałe pliki, na przykład obrazy, czytnik pomija.
 */
export async function unzip(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (u32(bytes, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(BROKEN);
  const count = u16(bytes, end + 10);
  let at = u32(bytes, end + 16);
  const files = new Map();
  let total = 0;
  const names = new TextDecoder('utf-8');
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) throw new Error(BROKEN);
    const method = u16(bytes, at + 10);
    const packed = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const skip = nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + skip;
    if (!/\.(xml|rels)$/i.test(name)) continue;
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw new Error(BROKEN);
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    if (start + packed > bytes.length) throw new Error(BROKEN);
    total += size;
    if (total > UNZIPPED_MAX) throw new Error(BROKEN);
    const data = bytes.subarray(start, start + packed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflate(data, size));
    else throw new Error(BROKEN);
  }
  return files;
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Tekst XML bez odwołań do znaków i z kodami Excela `_xHHHH_` zamienionymi na znaki. */
function xmlText(raw) {
  const text = raw.indexOf('&') < 0 ? raw : raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] !== '#') return ENTITY[e];
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
  return text.indexOf('_x') < 0 ? text : text.replace(/_x([0-9A-Fa-f]{4})_/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const TAG = /<(\/?)([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Atrybuty znacznika według nazwy lokalnej, bez przedrostka przestrzeni nazw. */
function attributes(raw) {
  const out = {};
  if (!raw) return out;
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1];
    out[name.slice(name.indexOf(':') + 1)] = xmlText(m[2] ?? m[3]);
  }
  return out;
}

/**
 * Odczyt XML po kolei: `open(name, attrs, empty)`, `close(name)` i `text(raw)` z nazwami lokalnymi znaczników.
 * Deklaracje, komentarze i instrukcje przetwarzania są pomijane, a sekcja CDATA trafia do `text` jako tekst.
 */
function scanXml(xml, handler) {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      handler.text?.(xml.slice(i), false);
      break;
    }
    if (lt > i) handler.text?.(xml.slice(i, lt), false);
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      handler.text?.(xml.slice(lt + 9, e < 0 ? n : e), true);
      i = e < 0 ? n : e + 3;
    } else if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
      const e = xml.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
    } else {
      TAG.lastIndex = lt;
      const m = TAG.exec(xml);
      if (!m) throw new Error(BROKEN);
      if (m[1]) handler.close?.(m[3]);
      else {
        handler.open?.(m[3], m[4], m[5] === '/');
        if (m[5] === '/') handler.close?.(m[3]);
      }
      i = TAG.lastIndex;
    }
  }
}

const xmlOf = (files, path) => {
  const data = files.get(path);
  return data ? new TextDecoder('utf-8').decode(data) : null;
};

/** Ścieżka pliku z relacji: względna wobec katalogu `xl/` albo bezwzględna w archiwum. */
const relPath = (target) => (target.startsWith('/') ? target.slice(1) : `xl/${target}`).replace(/\/[^/]+\/\.\.\//g, '/');

/** Teksty z `<t>` w elemencie `<si>` albo `<is>`, z pominięciem zapisu fonetycznego `<rPh>`. */
function richTextCollector() {
  let inPhonetic = 0;
  let inT = false;
  let buffer = '';
  return {
    open(name) {
      if (name === 'rPh') inPhonetic += 1;
      else if (name === 't' && inPhonetic === 0) inT = true;
    },
    close(name) {
      if (name === 'rPh') inPhonetic -= 1;
      else if (name === 't') inT = false;
    },
    text(raw, cdata) {
      if (inT) buffer += cdata ? raw : xmlText(raw);
    },
    take() {
      const out = buffer;
      buffer = '';
      return out;
    },
  };
}

function readStrings(xml) {
  const strings = [];
  if (!xml) return strings;
  const rich = richTextCollector();
  scanXml(xml, {
    open: (name) => rich.open(name),
    close(name) {
      rich.close(name);
      if (name === 'si') strings.push(rich.take());
    },
    text: (raw, cdata) => rich.text(raw, cdata),
  });
  return strings;
}

/** Formaty liczb komórek według indeksu stylu `s`: kod formatu albo identyfikator formatu wbudowanego. */
function readStyles(xml) {
  const custom = new Map();
  const xfs = [];
  if (!xml) return xfs;
  let inCellXfs = false;
  scanXml(xml, {
    open(name, raw) {
      if (name === 'numFmt') {
        const a = attributes(raw);
        custom.set(Number(a.numFmtId), a.formatCode ?? 'General');
      } else if (name === 'cellXfs') inCellXfs = true;
      else if (name === 'xf' && inCellXfs) xfs.push(Number(attributes(raw).numFmtId ?? 0));
    },
    close(name) {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });
  return xfs.map((id) => custom.get(id) ?? BUILTIN_FORMATS[id] ?? 'General');
}

/**
 * Skoroszyt: widoczne arkusze w kolejności z `xl/workbook.xml`, system dat 1904, wspólne teksty i formaty
 * liczb komórek. Arkusze ukryte i arkusze wykresów są pomijane.
 */
export async function readWorkbook(bytes) {
  const files = await unzip(bytes);
  const workbook = xmlOf(files, 'xl/workbook.xml');
  if (workbook === null) throw new Error(NOT_WORKBOOK);
  const declared = [];
  let date1904 = false;
  scanXml(workbook, {
    open(name, raw) {
      if (name === 'sheet') declared.push(attributes(raw));
      else if (name === 'workbookPr') {
        const flag = attributes(raw).date1904;
        date1904 = flag === '1' || flag === 'true';
      }
    },
  });
  const rels = new Map();
  scanXml(xmlOf(files, 'xl/_rels/workbook.xml.rels') ?? '', {
    open(name, raw) {
      if (name === 'Relationship') {
        const a = attributes(raw);
        rels.set(a.Id, { type: String(a.Type ?? '').split('/').pop(), path: relPath(String(a.Target ?? '')) });
      }
    },
  });
  const relOf = (type, fallback) => [...rels.values()].find((r) => r.type === type)?.path ?? fallback;
  const all = declared.map((a) => ({ name: a.name ?? '', state: a.state ?? 'visible', rel: rels.get(a.id) }))
    .filter((s) => s.rel && s.rel.type === 'worksheet' && files.has(s.rel.path));
  const visible = all.filter((s) => s.state === 'visible');
  const sheets = (visible.length > 0 ? visible : all).map((s) => ({ name: s.name, path: s.rel.path }));
  if (sheets.length === 0) throw new Error(NOT_WORKBOOK);
  return {
    sheets, date1904, files,
    strings: readStrings(xmlOf(files, relOf('sharedStrings', 'xl/sharedStrings.xml'))),
    formats: readStyles(xmlOf(files, relOf('styles', 'xl/styles.xml'))),
  };
}

/** Indeks kolumny z adresu komórki: A1 → 0, AB12 → 27; -1 bez adresu. */
function columnIndex(ref) {
  let index = 0;
  let letters = 0;
  for (const ch of String(ref ?? '')) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) index = index * 26 + (code - 64);
    else if (code >= 97 && code <= 122) index = index * 26 + (code - 96);
    else break;
    letters += 1;
  }
  return letters === 0 ? -1 : index - 1;
}

/**
 * Wiersze arkusza `index` z listy `book.sheets` jako teksty sformatowane według formatu komórki. Numer wiersza
 * pochodzi z atrybutu `r`, kolumna z adresu komórki, a brakujące komórki w wierszu są pustymi tekstami.
 */
export function readSheet(book, index) {
  const sheet = book.sheets[index];
  const xml = sheet ? xmlOf(book.files, sheet.path) : null;
  if (xml === null) throw new Error(BROKEN);
  const rows = [];
  let row = null;
  let cell = null;
  let inValue = false;
  let inFormula = false;
  const rich = richTextCollector();
  let inInline = false;

  const finishCell = () => {
    const { type, value, style, inline } = cell;
    let out = '';
    if (type === 's') out = book.strings[Number(value)] ?? '';
    else if (type === 'inlineStr') out = inline;
    else if (type === 'str') out = value;
    else if (type === 'b') out = value.trim() === '1' || value.trim() === 'true' ? 'PRAWDA' : 'FAŁSZ';
    else if (type === 'e') out = '';
    else if (type === 'd') out = value;
    else if (value.trim() !== '') {
      const number = Number(value);
      out = Number.isFinite(number) ? formatNumber(number, book.formats[style] ?? 'General', book.date1904) : value;
    }
    while (row.cells.length < cell.column) row.cells.push('');
    row.cells[cell.column] = out;
  };

  scanXml(xml, {
    open(name, raw) {
      if (name === 'row') {
        const r = Number(attributes(raw).r);
        row = { line: Number.isInteger(r) && r > 0 ? r : (rows.at(-1)?.line ?? 0) + 1, cells: [] };
      } else if (name === 'c' && row) {
        const a = attributes(raw);
        const column = columnIndex(a.r);
        cell = { column: column >= 0 ? column : row.cells.length, type: a.t ?? 'n', style: Number(a.s ?? 0), value: '', inline: '' };
      } else if (cell) {
        if (name === 'v') inValue = true;
        else if (name === 'f') inFormula = true;
        else if (name === 'is') inInline = true;
        else if (inInline) rich.open(name);
      }
    },
    close(name) {
      if (name === 'row' && row) {
        rows.push(row);
        row = null;
      } else if (name === 'c' && cell) {
        finishCell();
        cell = null;
      } else if (name === 'v') inValue = false;
      else if (name === 'f') inFormula = false;
      else if (name === 'is' && cell) {
        inInline = false;
        cell.inline = rich.take();
      } else if (inInline) rich.close(name);
    },
    text(raw, cdata) {
      if (!cell || inFormula) return;
      if (inValue) cell.value += cdata ? raw : xmlText(raw);
      else if (inInline) rich.text(raw, cdata);
    },
  });
  return rows;
}

// Formaty wbudowane według identyfikatora; daty krótkie w zapisie polskim. Identyfikatory 5-8 zależą od
// ustawień regionalnych Excela, dlatego widok pokazuje je jako liczby bez symbolu waluty.
const BUILTIN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 5: '#,##0', 6: '#,##0', 7: '#,##0.00', 8: '#,##0.00',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 14: 'dd.mm.yyyy', 15: 'dd.mm.yyyy', 16: 'dd.mm.yyyy',
  17: 'dd.mm.yyyy', 18: 'hh:mm', 19: 'hh:mm:ss', 20: 'hh:mm', 21: 'hh:mm:ss', 22: 'dd.mm.yyyy hh:mm',
  37: '#,##0', 38: '#,##0', 39: '#,##0.00', 40: '#,##0.00', 45: 'mm:ss', 46: 'hh:mm:ss', 47: 'mm:ss', 48: 'General', 49: '@',
};

/** Sekcje formatu oddzielone średnikami poza tekstem w cudzysłowach, nawiasami i znakami poprzedzonymi `\`. */
function formatSections(code) {
  const sections = [''];
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    if (c === '"') {
      const e = code.indexOf('"', i + 1);
      const stop = e < 0 ? code.length : e;
      sections[sections.length - 1] += code.slice(i, stop + 1);
      i = stop;
    } else if (c === '\\' || c === '_' || c === '*') {
      sections[sections.length - 1] += code.slice(i, i + 2);
      i += 1;
    } else if (c === '[') {
      const e = code.indexOf(']', i);
      const stop = e < 0 ? code.length : e;
      sections[sections.length - 1] += code.slice(i, stop + 1);
      i = stop;
    } else if (c === ';') sections.push('');
    else sections[sections.length - 1] += c;
  }
  return sections;
}

/**
 * Elementy sekcji formatu: tekst stały (`lit`), znak liczby (`num`: 0 # ? . ,), procent, litery daty i czasu
 * oraz znaki, których widok nie odwzorowuje (`other`: zapis wykładniczy, ułamek, tekst `@`).
 */
function formatTokens(section) {
  const tokens = [];
  for (let i = 0; i < section.length; i += 1) {
    const c = section[i];
    if (c === '"') {
      const e = section.indexOf('"', i + 1);
      const stop = e < 0 ? section.length : e;
      tokens.push({ kind: 'lit', text: section.slice(i + 1, stop) });
      i = stop;
    } else if (c === '\\') {
      tokens.push({ kind: 'lit', text: section[i + 1] ?? '' });
      i += 1;
    } else if (c === '_' || c === '*') i += 1;
    else if (c === '[') {
      const e = section.indexOf(']', i);
      const stop = e < 0 ? section.length : e;
      const inner = section.slice(i + 1, stop);
      if (inner[0] === '$') tokens.push({ kind: 'lit', text: inner.slice(1).split('-')[0] });
      else if (/^(h+|m+|s+)$/i.test(inner)) tokens.push({ kind: 'time', text: inner.toLowerCase()[0], elapsed: inner.length });
      i = stop;
    } else if (/^(AM\/PM|A\/P)/i.test(section.slice(i))) {
      tokens.push({ kind: 'time', text: 'h' });
      i += /^AM\/PM/i.test(section.slice(i)) ? 4 : 2;
    } else if ('0#?.,'.includes(c)) tokens.push({ kind: 'num', text: c });
    else if (c === '%') tokens.push({ kind: 'pct', text: c });
    else if (/[dmy]/i.test(c)) tokens.push({ kind: 'date', text: c.toLowerCase() });
    else if (/[hs]/i.test(c)) tokens.push({ kind: 'time', text: c.toLowerCase() });
    else if (/[eE/@]/.test(c)) tokens.push({ kind: 'other', text: c });
    else tokens.push({ kind: 'lit', text: c });
  }
  return tokens;
}

/** Opis formatu: rodzaj, a dla liczb liczba miejsc, separator tysięcy, skala, procent, tekst przed i po liczbie. */
function describeSection(section) {
  if (/^\s*general\s*$/i.test(section.replace(/\[[^\]]*\]/g, ''))) return { kind: 'general' };
  const tokens = formatTokens(section);
  const hasTime = tokens.some((t) => t.kind === 'time');
  const hasDate = tokens.some((t) => t.kind === 'date' && t.text !== 'm') || (tokens.some((t) => t.text === 'm') && !hasTime);
  if (hasDate || hasTime) {
    // Czas trwania w nawiasach, na przykład [h]:mm, liczy jednostki od zera ponad dobę albo godzinę.
    const elapsed = tokens.find((t) => t.elapsed);
    return {
      kind: 'date', date: hasDate, time: hasTime, hours: tokens.some((t) => t.kind === 'time' && t.text === 'h'),
      seconds: tokens.some((t) => t.text === 's'), elapsed: elapsed ? { unit: elapsed.text, width: elapsed.elapsed } : null,
    };
  }
  if (tokens.some((t) => t.kind === 'other' || t.kind === 'date')) return { kind: 'general' };
  const first = tokens.findIndex((t) => t.kind === 'num');
  if (first < 0) return { kind: 'literal', text: tokens.map((t) => t.text).join('') };
  let last = first;
  for (let k = first; k < tokens.length; k += 1) if (tokens[k].kind === 'num') last = k;
  const body = tokens.slice(first, last + 1);
  // Tekst między znakami liczby, na przykład zapis numeru telefonu: format nierozpoznany.
  if (body.some((t) => t.kind !== 'num')) return { kind: 'general' };
  const pattern = body.map((t) => t.text).join('');
  // Przecinki po ostatnim znaku cyfry dzielą wartość przez 1000 każdy.
  const scale = /,+$/.exec(pattern)?.[0].length ?? 0;
  const core = scale ? pattern.slice(0, -scale) : pattern;
  const dot = core.indexOf('.');
  const intPart = dot < 0 ? core : core.slice(0, dot);
  const fracPart = dot < 0 ? '' : core.slice(dot + 1);
  const text = (list) => list.map((t) => t.text).join('');
  return {
    kind: 'number',
    decimals: (fracPart.match(/[0#?]/g) ?? []).length,
    grouping: intPart.includes(','),
    minInt: (intPart.match(/0/g) ?? []).length,
    scale,
    percent: tokens.some((t) => t.kind === 'pct'),
    prefix: text(tokens.slice(0, first)),
    suffix: text(tokens.slice(last + 1)),
  };
}

const formatCache = new Map();

/** Sekcje formatu dla wartości dodatnich, ujemnych i zera, bez warunków w nawiasach i kolorów. */
function formatOf(code) {
  let entry = formatCache.get(code);
  if (!entry) {
    const sections = formatSections(String(code));
    entry = { sections: sections.slice(0, 3).map(describeSection) };
    formatCache.set(code, entry);
  }
  return entry;
}

const PLAIN = new Intl.NumberFormat('en-US', { useGrouping: false, maximumSignificantDigits: 15 });

/** Liczba z 15 cyframi znaczącymi, jak w Excelu, bez zapisu wykładniczego: „1234.5”. */
const plain = (value) => PLAIN.format(value);

/** Wartość bezwzględna zaokrąglona do `decimals` miejsc od połowy w górę: ['1234', '50']. */
function roundParts(value, decimals) {
  const [int, frac = ''] = plain(Math.abs(value)).split('.');
  if (frac.length <= decimals) return [int, frac.padEnd(decimals, '0')];
  let digits = BigInt(int + frac.slice(0, decimals));
  if (frac[decimals] >= '5') digits += 1n;
  const s = digits.toString().padStart(decimals + 1, '0');
  return [s.slice(0, s.length - decimals), s.slice(s.length - decimals)];
}

const groupThousands = (int) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Liczba w formacie ogólnym: przecinek dziesiętny, bez separatora tysięcy i bez zapisu wykładniczego. */
const general = (value) => plain(value).replace('.', ',');

function formatDecimal(value, f) {
  let v = Math.abs(value);
  if (f.percent) v *= 100;
  if (f.scale) v /= 1000 ** f.scale;
  const [int, frac] = roundParts(v, f.decimals);
  let whole = int.replace(/^0+(?=\d)/, '');
  if (whole === '0' && f.minInt === 0) whole = '';
  whole = whole.padStart(f.minInt, '0');
  if (f.grouping) whole = groupThousands(whole);
  return `${f.prefix}${whole}${frac ? `,${frac}` : ''}${f.suffix}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Czas trwania w sekundach według formatu [h]:mm, [h]:mm:ss, [mm]:ss albo [ss]: „36:00”, „90:00”. */
function formatElapsed(total, f) {
  const { unit, width } = f.elapsed;
  const lead = (n) => String(n).padStart(width, '0');
  const sec = f.seconds && unit !== 's' ? `:${pad2(total % 60)}` : '';
  if (unit === 'h') return `${lead(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}${sec}`;
  if (unit === 'm') return `${lead(Math.floor(total / 60))}${sec}`;
  return lead(total);
}

/** Liczba seryjna daty Excela jako „30.11.2026”, „30.11.2026 14:00”, „14:00”, „15:07” w formacie mm:ss albo czas trwania. */
function formatDate(value, f, date1904) {
  if (value < 0 || value > 2958465) return null;
  const total = Math.round(value * 86400);
  if (f.elapsed && !f.date) return formatElapsed(total, f);
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(base + total * 1000);
  const date = `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  const time = !f.hours && f.seconds ? `${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
    : `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${f.seconds ? `:${pad2(d.getUTCSeconds())}` : ''}`;
  if (f.date && f.time) return `${date} ${time}`;
  return f.date ? date : time;
}

/**
 * Wartość komórki jako tekst według kodu formatu: liczby z przecinkiem dziesiętnym i spacją tysięcy, procenty,
 * kwoty z tekstem formatu, na przykład „zł”, daty i godziny w zapisie polskim, wartości logiczne jako PRAWDA
 * i FAŁSZ. Format nierozpoznany: liczba z przecinkiem dziesiętnym bez separatora tysięcy.
 */
export function formatNumber(value, formatCode, date1904) {
  if (typeof value === 'boolean') return value ? 'PRAWDA' : 'FAŁSZ';
  if (typeof value !== 'number') return String(value ?? '');
  if (!Number.isFinite(value)) return '';
  const { sections } = formatOf(formatCode ?? 'General');
  let f = sections[0];
  let sign = value < 0 ? '-' : '';
  if (value < 0 && sections[1]) {
    f = sections[1];
    sign = '';
  } else if (value === 0 && sections[2]) f = sections[2];
  switch (f.kind) {
    case 'number': return sign + formatDecimal(value, f);
    case 'date': return formatDate(value, f, date1904) ?? general(value);
    case 'literal': return f.text;
    default: return general(value);
  }
}
