// Widok „Rozsyłka z pliku”: pracownik wybiera plik z odbiorcami, a widok czyta go na komputerze pracownika,
// rozpoznaje nagłówek i kolumnę numeru, pokazuje pierwsze wiersze i po zatwierdzeniu przekazuje wiersze
// do bramki porcjami narzędziem upload_file_rows, widocznym wyłącznie dla widoku. Agent otrzymuje tylko
// stałą wiadomość o wczytaniu pliku, a wartości z pliku do niego nie trafiają.

import {
  applyTheme, button, buttons, cancelledText, createBridge, esc, field, fields, forwardedText, note, num, pluralWord, sayIn, section, textOf, txt,
} from './bridge.js';
import { stackBar } from './chart.js';
import {
  analyze, FILE_BYTES_MAX, FILE_TOO_BIG, nextChunk, readFileBytes, ROWS_MAX, UPLOAD_BYTES, UPLOAD_CHUNK,
} from './plik-tabela.js';
import { readSheet } from './plik-xlsx.js';

/** Wiadomość do rozmowy po przekazaniu pliku: stały tekst bramki, jak FILE_LOADED_MESSAGE w narzędziach. */
export const FILE_LOADED = 'Plik z odbiorcami jest wczytany w widoku bramki. Przygotuj treść SMS-a z polami pliku.';

/** Liczba wierszy danych pokazywanych pracownikowi przed przekazaniem pliku. */
const PREVIEW_ROWS = 5;

const ENCODINGS = {
  'utf-8': 'UTF-8', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16', 'windows-1250': 'Windows-1250', 'x-mac-ce': 'MacCentralEurope z Excela dla macOS',
};
const SEPARATORS = { ';': 'średnik', ',': 'przecinek', '\t': 'tabulator' };

/** Pole wyboru pliku: ukryte pole systemowe, przycisk i nazwa pliku wyśrodkowane w pionie w jednej ramce. */
const PICKER = '<label class="pick"><input type="file" id="plik" accept=".csv,.txt,.xlsx">'
  + '<span class="btn pick-btn">Wybierz plik</span><span class="pick-name" id="plik-nazwa">Nie wybrano pliku</span></label>';

/**
 * Przesłanie wierszy porcjami w kolejności offsetów: najwyżej `size` wierszy i `bytes` bajtów w porcji. Nagłówek
 * pliku przechodzi wyłącznie w pierwszej porcji. Odmowa limitu żądań klucza wstrzymuje przesyłanie
 * na `retryAfterSec` i ponawia tę samą porcję. Po komplecie widok wysyła do rozmowy stałą wiadomość.
 * Wynik: { error, forwarded }.
 */
export async function transferFile(bridge, file, { size = UPLOAD_CHUNK, bytes = UPLOAD_BYTES, wait, onChunk = () => undefined }) {
  const total = file.rows.length;
  let fileId = null;
  let offset = 0;
  for (;;) {
    const end = nextChunk(file.rows, offset, { size, bytes });
    const rows = file.rows.slice(offset, end);
    const last = end >= total;
    const head = fileId === null ? { name: file.name, columns: file.columns, phoneColumn: file.phoneColumn, totalRows: total } : { fileId };
    const result = await bridge.callTool('upload_file_rows', { ...head, offset, rows, ...(last ? { done: true } : {}) });
    const out = result.structuredContent ?? {};
    if (result.isError) {
      if (out.error !== 'rate_limited') return { error: textOf(result), forwarded: false };
      onChunk({ offset, rows: rows.length, retried: true });
      await wait((out.retryAfterSec ?? 60) * 1000);
      continue;
    }
    onChunk({ offset, rows: rows.length, retried: false });
    fileId = out.fileId;
    if (out.complete) break;
    if (last || !(out.received > offset)) return { error: 'Bramka nie przyjęła wszystkich wierszy pliku. Wybierz plik ponownie.', forwarded: false };
    offset = out.received;
  }
  return { error: null, forwarded: await bridge.sendMessage(FILE_LOADED) };
}

const selectOf = (id, options) => `<select class="sel" id="${id}">${options.join('')}</select>`;
const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;

/** Komunikat w sekcji, gdy pliku nie można przekazać; null, gdy można. */
function blocker(t) {
  if (t.data.length === 0) return 'Plik nie zawiera wierszy danych';
  if (t.data.length > ROWS_MAX) {
    return `Plik zawiera ${num(t.data.length)} wierszy danych, a bramka przyjmuje najwyżej ${num(ROWS_MAX)} wierszy. Podziel plik na mniejsze części.`;
  }
  return null;
}

/** Postęp przekazywania i wynik: pasek przekazanych wierszy i liczba wierszy przyjętych przez bramkę. */
function renderProgress(s) {
  if (!s.progress) return '';
  const { sent, total } = s.progress;
  const text = s.done ? `Bramka przyjęła ${num(total)} ${pluralWord(total, 'wiersz', 'wiersze', 'wierszy')} z pliku`
    : `Przekazano ${num(sent)} z ${num(total)} ${pluralWord(total, 'wiersza', 'wierszy', 'wierszy')}`;
  return section('Przekazanie do bramki', stackBar([{ tone: s.done ? 'ok' : 'wait', value: sent }, { tone: 'rest', value: total - sent }]) + note(text));
}

/**
 * Rozpoznanie pliku i pierwsze wiersze danych. Wartości z pliku widzi wyłącznie pracownik w widoku, a zdanie
 * pod tabelą mówi, że agent zobaczy tylko nazwy kolumn. Wszystkie wartości trafiają do widoku jako tekst.
 */
export function renderLoaded(s) {
  const t = s.table;
  const xlsx = s.source.kind === 'xlsx';
  const picked = s.phoneColumn !== null && s.phoneColumn !== undefined;
  const phoneHint = picked ? '' : t.phoneCandidates.length > 1
    ? 'Numery telefonów występują w kilku kolumnach, dlatego wybierz właściwą z listy'
    : 'Widok nie rozpoznał kolumny z numerami telefonów, dlatego wybierz ją z listy';
  const phoneSelect = selectOf('numer', [...(picked ? [] : [option('', 'Wybierz kolumnę z numerami', true)]),
    ...t.columns.map((c, i) => option(i, c, i === s.phoneColumn))]);
  const stop = blocker(t);
  const recognition = fields(
    field('Kolumna numeru', phoneSelect, phoneHint),
    field('Wiersze danych', txt(num(t.data.length))),
    xlsx ? field('Arkusz', selectOf('arkusz', s.source.book.sheets.map((sheet, i) => option(i, sheet.name, i === s.source.sheet))))
      : field('Kodowanie znaków', txt(ENCODINGS[s.source.encoding] ?? s.source.encoding)),
    xlsx ? field('Format pliku', txt('Skoroszyt programu Excel (.xlsx)')) : field('Separator kolumn', txt(SEPARATORS[s.source.separator] ?? s.source.separator)),
  ) + `<label class="check"><input type="checkbox" id="naglowek"${t.header ? ' checked' : ''}> Pierwszy wiersz zawiera nazwy kolumn</label>`
    + (stop ? `<p class="notice n-fail">${esc(stop)}</p>` : '');
  const head = `<tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
  const body = t.data.slice(0, PREVIEW_ROWS).map((r) => `<tr>${r.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  const disabled = s.busy || s.done || !picked || stop !== null;
  return section('Rozpoznanie pliku', recognition)
    + section('Pierwsze wiersze danych', `<div class="scroll"><table>${head}${body}</table></div>`
      + note(`Agent zobaczy wyłącznie nazwy kolumn: ${t.columns.join(', ')}`)
      + buttons(button('Przekaż plik do bramki', { act: 'upload', kind: 'primary', disabled })))
    + renderProgress(s);
}

/** Uruchomienie widoku: wybór pliku, odczyt, rozpoznanie, przekazanie porcjami i wiadomość do rozmowy. */
export function startFile(win, env) {
  const doc = win.document;
  const root = doc.getElementById('tresc');
  const say = sayIn(doc);
  const s = { name: '', source: null, rows: [], table: null, phoneColumn: null, busy: false, done: false, progress: null };

  root.innerHTML = '<div class="accent">' + section('Plik z odbiorcami', fields(
    field('Plik CSV, TXT albo XLSX', PICKER),
    field('Limity pliku', txt(`${num(ROWS_MAX)} wierszy danych i ${FILE_BYTES_MAX / 1024 / 1024} MB`)),
  )) + '<div id="stan"></div></div>';
  const state = doc.getElementById('stan');
  const draw = () => {
    state.innerHTML = s.table ? renderLoaded(s) : '';
  };

  const bridge = createBridge(win, {
    version: env.version,
    onContext: (context) => applyTheme(doc, context),
    onToolCancelled: (reason) => say('wait', cancelledText(reason)),
  });

  /** Nowe rozpoznanie tabeli; wybrana wcześniej kolumna numeru zostaje, gdy `keep` i kolumna istnieje. */
  function apply(table, keep = false) {
    const previous = s.phoneColumn;
    s.table = table;
    s.phoneColumn = table.phoneCandidates.length === 1 ? table.phoneCandidates[0] : null;
    if (keep && previous !== null && previous < table.columns.length) s.phoneColumn = previous;
    s.done = false;
    s.progress = null;
    draw();
  }

  async function read(picked) {
    Object.assign(s, { name: picked.name, source: null, rows: [], table: null, phoneColumn: null, done: false, progress: null });
    const name = doc.getElementById('plik-nazwa');
    name.textContent = picked.name;
    name.className = 'pick-name set';
    draw();
    if (picked.size > FILE_BYTES_MAX) return say('fail', FILE_TOO_BIG);
    say('wait', 'Widok odczytuje plik');
    const result = await readFileBytes(picked.name, new Uint8Array(await picked.arrayBuffer()));
    if (result.error) return say('fail', result.error);
    s.source = result;
    s.rows = result.rows;
    apply(analyze(s.rows));
    return say('plain', '');
  }

  async function upload() {
    const t = s.table;
    s.busy = true;
    s.done = false;
    s.progress = { sent: 0, total: t.data.length };
    say('wait', 'Widok przekazuje plik do bramki');
    draw();
    try {
      const wait = (ms) => new Promise((resolve) => win.setTimeout(resolve, ms));
      const result = await transferFile(bridge, { name: s.name, columns: t.columns, phoneColumn: s.phoneColumn, rows: t.data }, {
        wait,
        onChunk: (c) => {
          if (c.retried) return say('wait', 'Bramka wstrzymała przekazywanie z powodu limitu żądań klucza. Widok wznowi je automatycznie.');
          s.progress = { sent: c.offset + c.rows, total: t.data.length };
          say('wait', 'Widok przekazuje plik do bramki');
          return draw();
        },
      });
      if (result.error !== null) return say('fail', result.error);
      s.done = true;
      return say(result.forwarded ? 'ok' : 'plain', result.forwarded
        ? forwardedText('Informacja o wczytaniu pliku') : 'Bramka przyjęła plik. Napisz w rozmowie, jaką treść SMS-a przygotować.');
    } catch (error) {
      return say('fail', error instanceof Error ? error.message : String(error));
    } finally {
      s.busy = false;
      draw();
    }
  }

  const fail = (error) => say('fail', error instanceof Error ? error.message : String(error));

  root.addEventListener('change', (event) => {
    const t = event.target;
    // Podczas przekazywania widok nie zmienia pliku ani rozpoznania.
    if (s.busy) return draw();
    if (t.id === 'plik') {
      if (t.files && t.files.length > 0) void read(t.files[0]).catch(fail);
    } else if (t.id === 'arkusz' && s.source?.kind === 'xlsx') {
      try {
        s.source = { ...s.source, sheet: Number(t.value) };
        s.rows = readSheet(s.source.book, s.source.sheet);
        apply(analyze(s.rows));
      } catch (error) {
        fail(error);
      }
    } else if (t.id === 'naglowek' && s.table) apply(analyze(s.rows, { header: t.checked }), true);
    else if (t.id === 'numer' && s.table) {
      s.phoneColumn = t.value === '' ? null : Number(t.value);
      s.done = false;
      s.progress = null;
      draw();
    }
    return undefined;
  });
  root.addEventListener('click', (event) => {
    const target = event.target.closest?.('button[data-act]');
    if (!target || target.disabled || target.dataset.act !== 'upload') return;
    if (s.table === null || s.busy || s.done || s.phoneColumn === null || blocker(s.table) !== null) return;
    void upload();
  });
}
