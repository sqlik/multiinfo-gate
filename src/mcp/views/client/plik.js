// Widok „Rozsyłka z pliku”: pracownik wybiera plik z odbiorcami, a widok czyta go na komputerze pracownika
// i przekazuje wiersze do bramki porcjami narzędziem upload_file_rows, widocznym wyłącznie dla widoku.
// Wartości z pliku nie trafiają do agenta. Elementy oznaczone „próba A” służą punktowi kontrolnemu A
// i zastępuje je czytnik docelowy.

import {
  applyTheme, button, buttons, cancelledText, createBridge, esc, field, fields, forwardedText, note, num, plural, sayIn, section, textOf, txt,
} from './bridge.js';

/** Wiadomość do rozmowy po przekazaniu pliku: stały tekst bramki, jak FILE_LOADED_MESSAGE w narzędziach. */
export const FILE_LOADED = 'Plik z odbiorcami jest wczytany w widoku bramki. Przygotuj treść SMS-a z polami pliku.';

// próba A: rozmiary porcji do porównania czasu przesyłania w aplikacjach AI.
export const CHUNK_SIZES = [500, 1000, 2500, 5000];
export const CHUNK_DEFAULT = 1000;

/** Największy plik, który czyta widok. */
const FILE_BYTES_MAX = 20 * 1024 * 1024;
/** Liczba wierszy pokazywanych pracownikowi przed przekazaniem pliku. */
const PREVIEW_ROWS = 5;
const PHONE_HEADER = /numer|telefon|tel|phone|msisdn/i;

// próba A: uproszczony podział CSV UTF-8 według wierszy i separatora, bez cudzysłowów.
export function splitCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((raw, i) => ({ line: i + 1, raw })).filter((l) => l.raw.trim() !== '');
  if (lines.length === 0) return null;
  const separator = lines[0].raw.includes(';') ? ';' : ',';
  const cells = (raw) => raw.split(separator).map((c) => c.trim());
  const columns = cells(lines[0].raw);
  return {
    columns,
    phoneColumn: Math.max(0, columns.findIndex((c) => PHONE_HEADER.test(c))),
    rows: lines.slice(1).map((l) => ({ line: l.line, cells: cells(l.raw) })),
  };
}

// próba A: środowisko ramki widoku dla czytnika docelowego (XLSX i CSV w Windows-1250).
export function environment(win) {
  let cp1250 = false;
  try {
    cp1250 = new win.TextDecoder('windows-1250').encoding === 'windows-1250';
  } catch {
    cp1250 = false;
  }
  const yes = (v) => (v ? 'tak' : 'nie');
  return `Środowisko: DecompressionStream ${yes(typeof win.DecompressionStream === 'function')}, Windows-1250 ${yes(cp1250)}`;
}

/**
 * Przesłanie wierszy porcjami w kolejności offsetów. Nagłówek pliku przechodzi wyłącznie w pierwszej porcji.
 * Odmowa limitu żądań klucza wstrzymuje przesyłanie na `retryAfterSec` i ponawia tę samą porcję. Po komplecie
 * widok wysyła do rozmowy stałą wiadomość. Wynik: { error, forwarded }.
 */
export async function transferFile(bridge, file, { size, wait, clock, onChunk = () => undefined }) {
  const total = file.rows.length;
  let fileId = null;
  let offset = 0;
  for (;;) {
    const rows = file.rows.slice(offset, offset + size);
    const last = offset + rows.length >= total;
    const head = fileId === null ? { name: file.name, columns: file.columns, phoneColumn: file.phoneColumn, totalRows: total } : { fileId };
    const started = clock();
    const result = await bridge.callTool('upload_file_rows', { ...head, offset, rows, ...(last ? { done: true } : {}) });
    const out = result.structuredContent ?? {};
    if (result.isError) {
      if (out.error !== 'rate_limited') return { error: textOf(result), forwarded: false };
      onChunk({ offset, rows: rows.length, ms: clock() - started, retried: true });
      await wait((out.retryAfterSec ?? 60) * 1000);
      continue;
    }
    onChunk({ offset, rows: rows.length, ms: clock() - started, retried: false });
    fileId = out.fileId;
    if (out.complete) break;
    if (!(out.received > offset)) return { error: 'Bramka nie przyjęła porcji wierszy. Wybierz plik ponownie.', forwarded: false };
    offset = out.received;
  }
  return { error: null, forwarded: await bridge.sendMessage(FILE_LOADED) };
}

/** Rozpoznanie pliku i pierwsze wiersze: wartości widzi wyłącznie pracownik, agent tylko nazwy kolumn. */
function renderFile(file, s) {
  const head = `<tr>${file.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
  const body = file.rows.slice(0, PREVIEW_ROWS).map((r) => `<tr>${r.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  return section('Rozpoznanie pliku', fields(
    field('Plik', txt(file.name)),
    field('Wiersze danych', txt(num(file.rows.length))),
    field('Kolumna numeru', txt(file.columns[file.phoneColumn] ?? '-')),
  ) + note(`Agent zobaczy wyłącznie nazwy kolumn: ${file.columns.join(', ')}`)
    + `<table>${head}${body}</table>`
    + buttons(button('Przekaż plik do bramki', { act: 'upload', kind: 'primary', disabled: s.busy || s.done })));
}

// próba A: czas każdej porcji i czas całego przesłania.
function renderChunks(chunks, s) {
  if (chunks.length === 0) return '';
  const rows = chunks.map((c) => `<tr><td>${num(c.offset + 1)}</td><td class="num">${num(c.rows)}</td>`
    + `<td class="num">${num(Math.round(c.ms))} ms</td><td>${c.retried ? 'limit żądań, ponowienie' : 'przyjęta'}</td></tr>`).join('');
  const sum = chunks.reduce((a, c) => a + c.ms, 0);
  return section('Przesyłanie porcjami', '<table><tr><th>Od wiersza</th><th class="num">Wiersze</th><th class="num">Czas</th><th>Wynik</th></tr>'
    + `${rows}</table>${note(`Łącznie ${plural(chunks.length, 'wywołanie', 'wywołania', 'wywołań')}, ${num(Math.round(sum))} ms, rozmiar porcji ${num(s.size)}`)}`);
}

/** Uruchomienie widoku: pole wyboru pliku, odczyt, rozpoznanie, przekazanie porcjami i wiadomość do rozmowy. */
export function startFile(win, env) {
  const doc = win.document;
  const root = doc.getElementById('tresc');
  const say = sayIn(doc);
  const s = { file: null, size: CHUNK_DEFAULT, chunks: [], busy: false, done: false };

  root.innerHTML = section('Plik z odbiorcami', fields(
    field('Plik CSV w kodowaniu UTF-8', '<input type="file" id="plik" class="sel" accept=".csv,.txt">'),
    // próba A: wybór rozmiaru porcji.
    field('Rozmiar porcji', `<select class="sel" id="porcja">${CHUNK_SIZES.map((n) => `<option value="${n}"${n === CHUNK_DEFAULT ? ' selected' : ''}>${num(n)} wierszy</option>`).join('')}</select>`),
  ) + note(environment(win))) + '<div id="stan"></div>';
  const state = doc.getElementById('stan');
  const draw = () => {
    state.innerHTML = (s.file ? renderFile(s.file, s) : '') + renderChunks(s.chunks, s);
  };

  const bridge = createBridge(win, {
    version: env.version,
    onContext: (context) => applyTheme(doc, context),
    onToolCancelled: (reason) => say('wait', cancelledText(reason)),
  });

  async function read(picked) {
    s.file = null;
    s.chunks = [];
    s.done = false;
    if (picked.size > FILE_BYTES_MAX) return say('fail', 'Plik przekracza 20 MB, dlatego widok go nie odczyta');
    const parsed = splitCsv(new win.TextDecoder('utf-8').decode(await picked.arrayBuffer()));
    if (parsed === null || parsed.rows.length === 0) return say('fail', 'Plik nie zawiera wierszy danych');
    s.file = { name: picked.name, ...parsed };
    return say('plain', '');
  }

  async function upload() {
    s.busy = true;
    s.chunks = [];
    say('wait', 'Widok przekazuje plik do bramki');
    draw();
    try {
      const clock = () => (win.performance ? win.performance.now() : Date.now());
      const wait = (ms) => new Promise((resolve) => win.setTimeout(resolve, ms));
      const result = await transferFile(bridge, s.file, { size: s.size, wait, clock, onChunk: (c) => { s.chunks.push(c); draw(); } });
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

  root.addEventListener('change', (event) => {
    const t = event.target;
    if (t.id === 'porcja') {
      s.size = Number(t.value);
      return;
    }
    if (t.id !== 'plik' || !t.files || t.files.length === 0) return;
    void read(t.files[0]).then(draw, (error) => say('fail', error instanceof Error ? error.message : String(error)));
  });
  root.addEventListener('click', (event) => {
    const target = event.target.closest?.('button[data-act="upload"]');
    if (!target || target.disabled || s.file === null) return;
    void upload();
  });
}
