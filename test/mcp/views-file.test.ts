import { describe, expect, it } from 'vitest';
import { hostError, num } from '../../src/mcp/views/client/bridge.js';
import { renderStatus } from '../../src/mcp/views/client/co-moge.js';
import {
  FILE_LOADED, FILE_REFRESH_MAX_MS, FILE_REFRESH_MS, filePending, fileSettled, renderFilePreview, renderFileProgress, renderLoaded, startFile, transferFile, watchFileSend,
} from '../../src/mcp/views/client/plik.js';
import { FIX_MESSAGE } from '../../src/mcp/views/client/send.js';
import { analyze, ROWS_MAX, UPLOAD_CHUNK } from '../../src/mcp/views/client/plik-tabela.js';
import { FILE_LOADED_MESSAGE } from '../../src/mcp/tools/file.ts';
import { BUILT_VIEWS, viewFiles, viewHtml } from '../../src/mcp/views/index.ts';
import { makeZipFiles } from '../helpers/zip.ts';
import { VIEW_STYLE } from '../../src/mcp/views/style.ts';

type Args = { fileId?: string; offset: number; rows: Array<{ line: number; cells: string[] }>; done?: boolean; totalRows?: number; columns?: string[]; name?: string; phoneColumn?: number };

/** Bramka przyjmująca porcje jak AgentFilesRepo. */
function gateway(opts: { limitedAt?: number[] } = {}) {
  const calls: Args[] = [];
  const limited = new Set(opts.limitedAt ?? []);
  let received = 0;
  let total = 0;
  const answer = (args: Args) => {
    calls.push(args);
    if (limited.delete(calls.length)) {
      return { isError: true, content: [{ type: 'text', text: 'Przekroczono limit 60 żądań na minutę klucza. Spróbuj ponownie za minutę.' }], structuredContent: { error: 'rate_limited', retryAfterSec: 60 } };
    }
    if (args.totalRows !== undefined) total = args.totalRows;
    if (args.offset === received) received += args.rows.length;
    return { content: [], structuredContent: { fileId: 'fil_1', received, total, complete: args.done === true && received === total } };
  };
  return { calls, answer };
}

/** Atrapa mostu: bramka przyjmuje porcje, a pierwsza wskazana porcja dostaje odmowę limitu żądań. */
function fakeBridge(opts: { limitedAt?: number[]; message?: boolean } = {}) {
  const gate = gateway(opts);
  const messages: string[] = [];
  return {
    calls: gate.calls, messages,
    async callTool(name: string, args: Args) {
      expect(name).toBe('upload_file_rows');
      return gate.answer(args);
    },
    async sendMessage(text: string) {
      messages.push(text);
      return opts.message !== false;
    },
  };
}

const FILE = {
  name: 'przypomnienia-listopad.csv', columns: ['Numer', 'Kontrahent', 'Kwota', 'Termin'], phoneColumn: 0,
  rows: Array.from({ length: 5 }, (_, i) => ({ line: i + 2, cells: ['48601000011', `Hurtownia ${i}`, '1 234,50 zł', '30.11.2026'] })),
};

type Element = { innerHTML: string; textContent: string; hidden: boolean; className: string; handlers: Map<string, (event: unknown) => void>; addEventListener: (type: string, fn: (event: unknown) => void) => void };

/** Atrapa ramki widoku: elementy tworzone według identyfikatora, aplikacja odpowiada na żądania widoku od razu. */
function viewWindow(gate: { answer: (args: Args, name: string) => unknown }) {
  const listeners: Array<(event: { data: unknown; source: unknown }) => void> = [];
  const sent: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = [];
  const nodes = new Map<string, Element>();
  const node = (id: string): Element => {
    let el = nodes.get(id);
    if (!el) {
      const handlers = new Map<string, (event: unknown) => void>();
      el = { innerHTML: '', textContent: '', hidden: false, className: '', handlers, addEventListener: (type, fn) => handlers.set(type, fn) };
      nodes.set(id, el);
    }
    return el;
  };
  const deliver = (data: unknown) => { for (const fn of listeners) fn({ data, source: parent }); };
  const parent = {
    postMessage(msg: (typeof sent)[number]) {
      sent.push(msg);
      if (msg.id === undefined) return;
      const reply = (result: unknown) => queueMicrotask(() => deliver({ jsonrpc: '2.0', id: msg.id, result }));
      if (msg.method === 'ui/initialize') reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'a', version: '1' }, hostCapabilities: { serverTools: {}, message: {} }, hostContext: {} });
      else if (msg.method === 'tools/call') {
        const params = msg.params as { name: string; arguments: Args };
        reply(gate.answer(params.arguments, params.name));
      }
      else reply({});
    },
  };
  const win = {
    parent, TextDecoder, setTimeout,
    document: { getElementById: node, documentElement: { dataset: {}, style: { setProperty: () => undefined } } },
    addEventListener: (type: string, fn: (event: { data: unknown; source: unknown }) => void) => { if (type === 'message') listeners.push(fn); },
  };
  const pick = (name: string, content: Uint8Array) => node('tresc').handlers.get('change')!({
    target: { id: 'plik', files: [{ name, size: content.length, arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.length) }] },
  });
  const click = (act: string, data: Record<string, string> = {}) => {
    const button = { dataset: { act, ...data }, disabled: false, classList: { contains: () => false } };
    node('tresc').handlers.get('click')!({ target: { closest: (sel: string) => (sel.includes('data-act') ? button : null) } });
  };
  const change = (target: Record<string, unknown>) => node('tresc').handlers.get('change')!({ target });
  /** Powiadomienie aplikacji dla widoku, na przykład dane wejściowe i wynik narzędzia. */
  const notify = (method: string, params: unknown) => deliver({ jsonrpc: '2.0', method, params });
  return { win, node, sent, pick, click, change, notify };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(check()).toBe(true);
}

const loaded = (rows: Array<{ line: number; cells: string[] }>, extra: Record<string, unknown> = {}) => {
  const table = analyze(rows);
  return {
    name: 'przypomnienia-listopad.csv', source: { kind: 'csv', encoding: 'utf-8', separator: ';' }, table,
    phoneColumn: table.phoneCandidates.length === 1 ? table.phoneCandidates[0] : null, busy: false, done: false, progress: null, ...extra,
  };
};

describe('widok rozsyłki z pliku', () => {
  it('transferFile: porcje w kolejności offsetów, ponowienie porcji po rate_limited, stała wiadomość po przesłaniu', async () => {
    const bridge = fakeBridge({ limitedAt: [2] });
    const waits: number[] = [];
    const chunks: Array<{ offset: number; rows: number; retried: boolean }> = [];
    const result = await transferFile(bridge, FILE, {
      size: 2, wait: async (ms: number) => { waits.push(ms); },
      onChunk: (c: { offset: number; rows: number; retried: boolean }) => chunks.push(c),
    });
    expect(result).toEqual({ error: null, forwarded: true });
    expect(bridge.calls.map((c) => [c.offset, c.rows.length, c.fileId ?? null, c.done ?? false])).toEqual([
      [0, 2, null, false], [2, 2, 'fil_1', false], [2, 2, 'fil_1', false], [4, 1, 'fil_1', true],
    ]);
    // Nagłówek pliku przechodzi wyłącznie w pierwszej porcji.
    expect(bridge.calls[0]).toMatchObject({ name: FILE.name, columns: FILE.columns, phoneColumn: 0, totalRows: 5 });
    expect(bridge.calls.slice(1).some((c) => 'columns' in c || 'name' in c)).toBe(false);
    expect(waits).toEqual([60_000]);
    expect(chunks).toEqual([{ offset: 0, rows: 2, retried: false }, { offset: 2, rows: 2, retried: true }, { offset: 2, rows: 2, retried: false }, { offset: 4, rows: 1, retried: false }]);
    expect(bridge.messages).toEqual([FILE_LOADED]);
    expect(FILE_LOADED).toBe(FILE_LOADED_MESSAGE);
  });

  it('transferFile: odmowa wiadomości przez aplikację AI po komplecie wierszy nie jest błędem przekazania', async () => {
    const bridge = fakeBridge();
    const declining = { ...bridge, sendMessage: async () => { throw hostError('ui/message', 'User declined the message'); } };
    expect(await transferFile(declining, FILE, { wait: async () => undefined })).toEqual({ error: null, forwarded: false });
  });

  it('transferFile: błąd porcji inny niż limit żądań przerywa przesyłanie bez wiadomości do rozmowy', async () => {
    const bridge = fakeBridge();
    const failing = {
      ...bridge,
      callTool: async (name: string, args: Args) => (args.offset === 2
        ? { isError: true, content: [{ type: 'text', text: 'Szkic pliku wygasł.' }], structuredContent: { error: 'file_expired' } }
        : bridge.callTool(name, args)),
    };
    const result = await transferFile(failing, FILE, { size: 2, wait: async () => undefined });
    expect(result).toEqual({ error: 'Szkic pliku wygasł.', forwarded: false });
    expect(bridge.messages).toEqual([]);
  });

  it('widok: zdanie z nazwami kolumn, pierwsze wiersze tylko w widoku, nazwa kolumny z <script> jako tekst', () => {
    const rows = [{ line: 1, cells: ['Numer', 'Kontrahent', '<script>alert(1)</script>'] },
      ...Array.from({ length: 7 }, (_, i) => ({ line: i + 2, cells: [`4860100001${i}`, `Hurtownia ${i}`, '<b>99,00 zł</b>'] }))];
    const html = renderLoaded(loaded(rows));
    expect(html).not.toContain('<script>');
    expect(html).toContain('<p class="note">Agent zobaczy wyłącznie nazwy kolumn: Numer, Kontrahent, &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).toContain('<th>&lt;script&gt;alert(1)&lt;/script&gt;</th>');
    expect(html).toContain('<td>&lt;b&gt;99,00 zł&lt;/b&gt;</td>');
    expect(html).toContain('Hurtownia 4');
    expect(html).not.toContain('Hurtownia 5');
    expect(html).toContain('<select class="sel" aria-label="Kolumna numeru" id="numer"><option value="0" selected>Numer</option><option value="1">Kontrahent</option>');
    // Kolumna numeru wyróżniona w nagłówku tabeli podglądu.
    expect(html).toContain('<tr><th class="ph">Numer</th><th>Kontrahent</th>');
    expect(html).toContain('<input type="checkbox" id="naglowek" checked>');
    expect(html).toContain('Pierwszy wiersz zawiera nazwy kolumn');
    expect(html).toContain('<div class="txt">7</div>');
    expect(html).toContain('<div class="txt">UTF-8</div>');
    expect(html).toContain('<select class="sel" aria-label="Separator kolumn" id="separator"><option value=";" selected>średnik</option><option value="tab">tabulator</option><option value=",">przecinek</option></select>');
    expect(html).toContain('<button type="button" class="btn btn-primary" data-act="upload">Przekaż plik do bramki</button>');
  });

  it('widok: kolumna numeru do wyboru, arkusze skoroszytu jako lista, limit wierszy wyłącza przekazanie', () => {
    const rows = [{ line: 1, cells: ['Telefon', 'Tel'] }, { line: 2, cells: ['48601000011', '48601000012'] }];
    const html = renderLoaded(loaded(rows, { source: { kind: 'xlsx', sheet: 1, book: { sheets: [{ name: 'Listopad' }, { name: 'Grudzień <b>' }] } } }));
    expect(html).toContain('<select class="sel" aria-label="Kolumna numeru" id="numer"><option value="" selected>Wybierz kolumnę z numerami</option><option value="0">Telefon</option><option value="1">Tel</option></select>');
    expect(html).toContain('Numery telefonów występują w kilku kolumnach, dlatego wybierz właściwą z listy');
    expect(html).not.toContain('class="ph"');
    expect(html).toContain('<select class="sel" aria-label="Arkusz" id="arkusz"><option value="0">Listopad</option><option value="1" selected>Grudzień &lt;b&gt;</option></select>');
    expect(html).toContain('<button type="button" class="btn btn-primary" data-act="upload" disabled>Przekaż plik do bramki</button>');
    const many = Array.from({ length: ROWS_MAX + 1 }, (_, i) => ({ line: i + 2, cells: ['48601000011'] }));
    const over = renderLoaded(loaded([{ line: 1, cells: ['Numer'] }, ...many]));
    expect(over).toContain('data-act="upload" disabled');
    expect(over).toContain(`Plik zawiera ${num(50_001)} wierszy danych, a bramka przyjmuje najwyżej ${num(50_000)} wierszy. Podziel plik na mniejsze części.`);
    const wide = renderLoaded(loaded([{ line: 1, cells: ['Numer', 'Kontrahent'] }, { line: 2, cells: ['48601000011', 'Hurtownia'], width: 16_384 } as { line: number; cells: string[] }]));
    expect(wide).toContain('data-act="upload" disabled');
    expect(wide).toContain(`Plik zawiera ${num(16_384)} kolumny, a bramka przyjmuje najwyżej 50 kolumn. Usuń z pliku kolumny, których wysyłka nie wykorzystuje, także pojedyncze wartości w odległych kolumnach.`);
  });

  it('widok: przesyłanie dopiero po Przekaż plik do bramki, porcje UPLOAD_CHUNK, stała wiadomość po przesłaniu', async () => {
    const gate = gateway();
    const w = viewWindow(gate);
    startFile(w.win, { version: '1.13.0' });
    expect(w.node('tresc').innerHTML).toContain('accept=".csv,.txt,.xlsx,.xls"');
    const csv = ['Numer;Kontrahent;Kwota', ...Array.from({ length: 6000 }, (_, i) => `486010${String(i).padStart(5, '0')};Hurtownia Łódź;1 234,50 zł`)].join('\r\n');
    w.pick('przypomnienia.csv', new Uint8Array(Buffer.from(csv)));
    await until(() => w.node('stan').innerHTML.includes('Agent zobaczy wyłącznie nazwy kolumn: Numer, Kontrahent, Kwota'));
    expect(w.node('plik-nazwa').textContent).toBe('przypomnienia.csv');
    expect(w.sent.filter((m) => m.method === 'tools/call')).toEqual([]);
    w.click('upload');
    await until(() => w.node('komunikat').textContent.includes('została przekazana aplikacji AI'));
    expect(gate.calls.map((c) => [c.offset, c.rows.length, c.done ?? false])).toEqual([[0, UPLOAD_CHUNK, false], [2500, 2500, false], [5000, 1000, true]]);
    expect(gate.calls[0]).toMatchObject({ name: 'przypomnienia.csv', columns: ['Numer', 'Kontrahent', 'Kwota'], phoneColumn: 0, totalRows: 6000 });
    expect(gate.calls[0]!.rows[0]).toEqual({ line: 2, cells: ['48601000000', 'Hurtownia Łódź', '1 234,50 zł'] });
    const message = w.sent.find((m) => m.method === 'ui/message')!;
    expect(message.params).toEqual({ role: 'user', content: [{ type: 'text', text: FILE_LOADED }] });
    expect(w.node('stan').innerHTML).toContain(`Bramka przyjęła ${num(6000)} wierszy`);
    expect(w.node('stan').innerHTML).toContain('data-act="upload" disabled');
  });

  it('widok: plik wybrany w trakcie odczytu poprzedniego zastępuje go, rozpoznanie i przekazanie dotyczą ostatniego pliku', async () => {
    const gate = gateway();
    const w = viewWindow(gate);
    startFile(w.win, { version: '1.13.0' });
    const csv = (rows: string[]) => new Uint8Array(Buffer.from(['Numer;Kontrahent', ...rows].join('\r\n')));
    const a = csv(['48601000011;Plik A - stara lista']);
    const b = csv(['48601000022;Plik B - właściwa lista']);
    let releaseA: () => void = () => undefined;
    const slowA = new Promise<void>((resolve) => { releaseA = resolve; });
    w.change({ id: 'plik', files: [{ name: 'lista-pazdziernik.csv', size: a.length, arrayBuffer: async () => { await slowA; return a.buffer.slice(0); } }] });
    w.pick('lista-listopad.csv', b);
    await until(() => w.node('stan').innerHTML.includes('Plik B - właściwa lista'));
    releaseA();
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.node('plik-nazwa').textContent).toBe('lista-listopad.csv');
    expect(w.node('stan').innerHTML).toContain('Plik B - właściwa lista');
    expect(w.node('stan').innerHTML).not.toContain('Plik A - stara lista');
    w.click('upload');
    await until(() => gate.calls.length > 0);
    expect(gate.calls[0]).toMatchObject({ name: 'lista-listopad.csv' });
    expect(JSON.stringify(gate.calls[0]!.rows)).toContain('48601000022');
  });

  it('widok: pole wyboru pliku wyłączone w trakcie przekazywania, wybór w tym czasie pomijany z wyczyszczeniem pola', async () => {
    const w = viewWindow(gateway());
    startFile(w.win, { version: '1.13.0' });
    w.pick('przypomnienia.csv', new Uint8Array(Buffer.from('Numer;Kontrahent\r\n48601000011;Hurtownia Łódź')));
    await until(() => w.node('stan').innerHTML.includes('Przekaż plik do bramki'));
    const input = w.node('plik') as unknown as { disabled?: boolean };
    expect(input.disabled).toBeFalsy();
    w.click('upload');
    expect(input.disabled).toBe(true);
    // Zdarzenie wyboru, które mimo to dotrze w trakcie przekazywania, nie zmienia pliku, a pole wraca do stanu bez wyboru,
    // dzięki czemu ponowny wybór tego samego pliku po przekazaniu wywoła zdarzenie.
    const late = { id: 'plik', value: 'C:\\fakepath\\inna-lista.csv', files: [{ name: 'inna-lista.csv', size: 10, arrayBuffer: async () => new ArrayBuffer(0) }] };
    w.change(late);
    expect(late.value).toBe('');
    expect(w.node('plik-nazwa').textContent).toBe('przypomnienia.csv');
    await until(() => w.node('komunikat').textContent.includes('została przekazana aplikacji AI'));
    expect(input.disabled).toBe(false);
  });

  it('widok: separator kolumn do zmiany z listy, zmiana dzieli wiersze pliku na nowo', async () => {
    const w = viewWindow(gateway());
    startFile(w.win, { version: '1.13.0' });
    // Każdy wiersz zawiera tyle samo przecinków i średników, dlatego widok wybiera średnik, a pracownik zmienia go na przecinek.
    w.pick('kontrahenci.csv', new Uint8Array(Buffer.from('Numer,Kontrahent;uwagi\r\n48601000011,Hurtownia Łódź;brak\r\n48601000012,Serwis Kraków;brak\r\n')));
    await until(() => w.node('stan').innerHTML.includes('id="separator"'));
    expect(w.node('stan').innerHTML).toContain('<option value=";" selected>średnik</option>');
    w.change({ id: 'separator', value: ',' });
    expect(w.node('stan').innerHTML).toContain('<option value="," selected>przecinek</option>');
    expect(w.node('stan').innerHTML).toContain('Agent zobaczy wyłącznie nazwy kolumn: Numer, Kontrahent;uwagi');
    expect(w.node('stan').innerHTML).toContain('<td>Hurtownia Łódź;brak</td>');
    w.change({ id: 'separator', value: 'tab' });
    expect(w.node('stan').innerHTML).toContain('<option value="tab" selected>tabulator</option>');
    expect(w.node('stan').innerHTML).toContain('Agent zobaczy wyłącznie nazwy kolumn: Numer,Kontrahent;uwagi</p>');
  });

  it('widok: uszkodzony skoroszyt daje komunikat o uszkodzonym pliku, bez tekstu wyjątku i bez rozpoznania', async () => {
    const zip = new Uint8Array(makeZipFiles({
      'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Listopad" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Numer</t></is></c></row></sheetData></worksheet>',
    }));
    const name = Buffer.from('xl/worksheets/sheet1.xml');
    const at = Buffer.from(zip).indexOf(name) + name.length;
    for (let i = at; i < at + 8; i += 1) zip[i] = 0xff;
    const w = viewWindow(gateway());
    startFile(w.win, { version: '1.13.0' });
    w.pick('przypomnienia-listopad.xlsx', zip);
    await until(() => w.node('komunikat').className === 'notice n-fail');
    expect(w.node('komunikat').textContent).toBe('Widok nie odczytał skoroszytu, ponieważ plik jest uszkodzony. Zapisz go w Excelu ponownie albo jako „CSV UTF-8”.');
    expect(w.node('stan').innerHTML).toBe('');
  });

  it('widok: plik .xls daje komunikat bez wywołań narzędzi bramki', async () => {
    const w = viewWindow(gateway());
    startFile(w.win, { version: '1.13.0' });
    w.pick('kontrahenci.xls', Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    await until(() => w.node('komunikat').textContent.includes('Excel 97-2003'));
    expect(w.node('komunikat').className).toBe('notice n-fail');
    expect(w.node('stan').innerHTML).toBe('');
    expect(w.sent.filter((m) => m.method === 'tools/call')).toEqual([]);
  });

  it('dokument widoku plik: moduły czytnika, pole wyboru pliku z XLSX, bez elementów punktu kontrolnego A', () => {
    expect(BUILT_VIEWS).toContain('plik');
    expect(viewFiles('plik')).toEqual(['bridge.js', 'measure.js', 'chart.js', 'doreczenia.js', 'send.js', 'plik-csv.js', 'plik-xlsx.js', 'plik-tabela.js', 'plik.js']);
    const html = viewHtml('plik');
    expect(html).toContain('Rozsyłka z pliku - Multiinfo Gate');
    expect(html).toContain('startFile(window,');
    expect(html).not.toContain('Środowisko');
    expect(html).not.toContain('Rozmiar porcji');
    expect(html).not.toMatch(/próba A/i);
  });

  it('dostępność: każda lista wyboru rozpoznania pliku i podglądu ma nazwę dostępną z etykiety pola', () => {
    const named = (html: string) => {
      const selects = [...html.matchAll(/<select\b[^>]*>/g)].map((m) => m[0]);
      expect(selects.length).toBeGreaterThan(0);
      return selects.map((tag) => /\baria-label="([^"]+)"/.exec(tag)?.[1] ?? null);
    };
    const table = analyze([{ line: 1, cells: ['Telefon', 'Numer klienta', 'Kontrahent'] }, { line: 2, cells: ['48601000011', '48601000012', 'Hurtownia'] }]);
    const loadedHtml = renderLoaded({
      name: 'p.xlsx', table, phoneColumn: null, busy: false, done: false, progress: null,
      source: { kind: 'xlsx', sheet: 0, book: { sheets: [{ name: 'Listopad' }, { name: 'Grudzień' }] } },
    });
    expect(named(loadedHtml)).toEqual(['Kolumna numeru', 'Arkusz']);
    expect(named(renderLoaded(loaded([{ line: 1, cells: ['Numer'] }, { line: 2, cells: ['48601000011'] }])))).toEqual(['Kolumna numeru', 'Separator kolumn']);
    expect(named(renderFilePreview(PREVIEW, META, { input: INPUT }))).toEqual(['Nadawca', 'Usługa Multiinfo', 'Kolumna identyfikatora klienta']);
  });

  it('style: pole wyboru pliku i listy wyśrodkowane w pionie, strzałka listy z odstępem, obwódki pól we wszystkich widokach w kolorze akcji', () => {
    expect(VIEW_STYLE).toMatch(/\.pick\{position:relative;display:flex;align-items:center;[^}]*border:1px solid var\(--signal\)/);
    expect(VIEW_STYLE).toMatch(/\.pick:has\(input:disabled\)\{[^}]*border-color:var\(--rule\)/);
    expect(VIEW_STYLE).toMatch(/select\.sel\{[^}]*appearance:none;[^}]*padding:0 34px 0 10px;/);
    // Decyzja Tomka 2026-11-17: obwódki pól jak okno treści SMS-a we wszystkich widokach, pole wyłączone szare.
    expect(VIEW_STYLE).toMatch(/\.sel,\.inp\{[^}]*border:1px solid var\(--signal\)/);
    expect(VIEW_STYLE).toMatch(/\.sel:disabled,\.inp:disabled\{[^}]*border-color:var\(--rule\)/);
    expect(VIEW_STYLE).toMatch(/\.seg2\{[^}]*border:1px solid var\(--signal\)/);
    expect(VIEW_STYLE).not.toContain('.accent');
    expect(VIEW_STYLE).toMatch(/th\.ph\{[^}]*color:var\(--signal-dark\)/);
  });
});

const TEMPLATE = 'Przypominamy o płatności faktury dla {Kontrahent} na kwotę {Kwota} do {Termin}.';
const sample = (line: number, to: string, company: string) => ({
  line, to, text: `Przypominamy o płatności faktury dla ${company} na kwotę 1 234,50 zł do 30.11.2026.`, parts: 2,
});
const PREVIEW = {
  draftId: 'drf_plik', expiresAt: '2026-11-17T10:30:00.000Z', fields: ['Kontrahent', 'Kwota', 'Termin'], recipients: 1200, parts: 2400, partsHistogram: { 2: 1200 },
  excluded: { columns: 1, invalid_phone: 2, invalid_client_id: 0, empty_field: 1, too_many_parts: 0 }, duplicates: 3, sameNumberDifferentText: 2, truncated: 0,
  encodings: { gsm: 0, ucs2: 1200 }, packages: 1, schedule: null as null | { startAt: string; handoverAt: string },
  serviceId: '20841', services: [{ id: '20841', label: 'Biuro handlowe' }, { id: '20842', label: '20842' }],
  orig: 'FIRMA', senders: [{ value: 'FIRMA', label: 'FIRMA' }, { value: null, label: 'numer usługi' }],
  guard: { calls: 29, recipients: 4800, resetsAt: '2026-11-17T11:00:00.000Z' }, blocked: null as string | null,
};
const META = {
  name: 'przypomnienia-listopad.xlsx', columns: ['Numer', 'Kontrahent', 'Kwota', 'Termin', 'Klient'],
  samples: [sample(2, '48601000011', 'Hurtownia Kowalski'), sample(600, '48601000600', 'Serwis Nowak'), sample(1205, '48601001205', 'Biuro Zielińska')],
  excludedRows: [{ line: 7, reason: 'invalid_phone', phone: '12345' }, { line: 9, reason: 'columns', phone: null }, { line: 15, reason: 'invalid_phone', phone: '' }, { line: 40, reason: 'empty_field', phone: '48601000040' }],
  excludedMore: 0, repeatedNumbers: ['48601000015', '48601000016'],
};
const INPUT = { text: TEMPLATE, clientIdColumn: 'klient' };

const STATUS = {
  id: 'fsd_7k2', created: { at: '2026-11-17T09:00:00.000Z', local: '17.11.2026 10:00' }, recipients: 1200, packages: 2,
  byStatus: { sending: 1, completed: 1 } as Record<string, number>, statusLabels: { sending: 'w wysyłce', completed: 'zakończona' } as Record<string, string>,
  delivered: 900, failed: 40, other: 10, notSent: 0, schedule: null as null | Record<string, unknown>, cancellable: 0, reportReady: false, final: false,
};
const SCHEDULED = {
  ...STATUS, byStatus: { scheduled: 2 }, statusLabels: { scheduled: 'zaplanowana' }, delivered: 0, failed: 0, other: 0, cancellable: 2,
  schedule: { startAt: { at: '2026-11-20T07:00:00.000Z', local: '20.11.2026 08:00' }, handoverAt: { at: '2026-11-20T06:50:00.000Z', local: '20.11.2026 07:50' } },
};

describe('podgląd, wysyłka i postęp rozsyłki z pliku', () => {
  it('widok podglądu: treść z polami, 3 wiadomości z przełączaniem, liczby, wyłączenia z numerem wiersza, ostrzeżenie o numerach, usługa, nadawca, termin', () => {
    const html = renderFilePreview(PREVIEW, META, { input: INPUT, sample: 0 });
    // Treść z polami z danych wejściowych narzędzia, pola wyróżnione.
    expect(html).toContain('Przypominamy o płatności faktury dla <span class="slot">{Kontrahent}</span> na kwotę <span class="slot">{Kwota}</span>');
    // Pierwsza gotowa wiadomość i przełącznik trzech wiadomości z numerami wierszy.
    expect(html).toContain('dla Hurtownia Kowalski na kwotę');
    expect(html).not.toContain('Serwis Nowak');
    expect(html).toContain('<button type="button" class="on" data-act="sample" data-i="0">wiersz 2</button>');
    expect(html).toContain('<button type="button" data-act="sample" data-i="2">wiersz 1205</button>');
    expect(html).toContain('<b>2</b> części');
    expect(html).toContain('48601000011');
    const second = renderFilePreview(PREVIEW, META, { input: INPUT, sample: 1 });
    expect(second).toContain('dla Serwis Nowak na kwotę');
    expect(second).toContain('<button type="button" class="on" data-act="sample" data-i="1">wiersz 600</button>');
    // Liczby odbiorców, SMS-ów, części, rozsyłek i kodowanie.
    expect(html).toContain(`<div class="v">${num(1200)}</div>`);
    expect(html).toContain(`<div class="v">${num(2400)}</div>`);
    expect(html).toContain(`<div class="lbl">Zostało odbiorców</div><div class="v">${num(4800)}</div>`);
    expect(html).toContain('Unicode, z polskimi znakami');
    // Wiersze wyłączone w liście rozwijanej z numerem wiersza i powodem.
    expect(html).toContain('<details class="it">');
    // Próba B (B7): wartość z kolumny numeru obok wiersza, kolumny dopasowane do treści i wyrównane do lewej.
    expect(html).toContain('<tr><th class="fit">Wiersz pliku</th><th class="fit">Numer w pliku</th><th>Powód</th></tr>');
    expect(html).toContain('<tr><td class="fit">7</td><td class="fit">12345</td><td>błędny numer telefonu</td></tr>');
    expect(html).toContain('<tr><td class="fit">9</td><td class="fit">-</td><td>wiersz niezgodny z nagłówkiem</td></tr>');
    expect(html).toContain('<tr><td class="fit">15</td><td class="fit">puste</td><td>błędny numer telefonu</td></tr>');
    expect(html).toContain('Wiersze wyłączone z wysyłki: 4');
    // Próba B (B6): liczba wierszy po myślniku z rzeczownikiem.
    expect(html).toContain('Przyczyny: błędny numer telefonu - 2 wiersze, puste pole użyte w treści - 1 wiersz, wiersz niezgodny z nagłówkiem - 1 wiersz');
    expect(html).toContain('Wiersze z tym samym numerem i tą samą treścią: 3. Bramka wyśle każdą taką wiadomość raz.');
    // Ostrzeżenie o numerach z różnymi treściami z listą numerów.
    expect(html).toContain('<p class="notice n-wait">Numery z różnymi treściami: 2. Każdy z tych numerów otrzyma wszystkie przeznaczone dla niego SMS-y.</p>');
    // Próba B (B12): lista numerów rozwijana na życzenie, jak lista wierszy wyłączonych.
    expect(html).toContain('<div class="inbox"><details class="it"><summary><div class="it-top"><b>Lista numerów</b><span class="it-tag">2 numery</span></div></summary>'
      + '<div class="it-body"><p class="nums">48601000015, 48601000016</p></div></details></div>');
    // Usługa, nadawca i plik; kolumna identyfikatora klienta ustawiona według clientIdColumn bez względu na wielkość liter.
    expect(html).toContain('<select class="sel" aria-label="Nadawca" name="orig"><option value="FIRMA" selected>FIRMA</option><option value="">numer usługi</option></select>');
    expect(html).toContain('<option value="20841" selected>Biuro handlowe (20841)</option>');
    expect(html).toContain('<div class="txt">przypomnienia-listopad.xlsx</div>');
    expect(html).toContain('<select class="sel" aria-label="Kolumna identyfikatora klienta" name="clientIdColumn"><option value="">bez identyfikatora</option><option value="Numer">Numer</option>');
    expect(html).toContain('<option value="Klient" selected>Klient</option>');
    expect(renderFilePreview(PREVIEW, META, { input: { text: TEMPLATE }, sample: 0 })).toContain('<option value="" selected>bez identyfikatora</option>');
    expect(html).not.toContain('Termin rozpoczęcia');
    const scheduled = renderFilePreview({ ...PREVIEW, schedule: { startAt: '2026-11-20T07:00:00.000Z', handoverAt: '2026-11-20T06:50:00.000Z' } }, META, { input: INPUT, sample: 0 });
    expect(scheduled).toContain('<div class="txt">2026-11-20 08:00</div>');
    expect(scheduled).toContain('Anulowanie jest możliwe do chwili przekazania rozsyłki do Multiinfo, zwykle 10 minut przed terminem');
    // Próba B (B10): plik i termin w wierszach na całą szerokość, listy parami: Nadawca i Usługa, Kolumna identyfikatora i Kodowanie.
    expect(scheduled).toContain('<div class="field wide"><span class="lbl">Plik</span><div class="txt">przypomnienia-listopad.xlsx</div></div>');
    expect(scheduled).toContain('<div class="field wide"><span class="lbl">Termin</span>');
    const order = ['Plik', 'Nadawca', 'Usługa Multiinfo', 'Kolumna identyfikatora klienta', 'Kodowanie', 'Termin'].map((l) => scheduled.indexOf(`lbl">${l}<`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
  });

  it('widok: blocked daje nieaktywny przycisk i wyjaśnienie; termin daje Zaplanuj; Popraw treść w rozmowie wysyła stałą wiadomość', async () => {
    const reason = 'Integracja Agent AI - biuro handlowe pozwala wysłać 1000 odbiorców w ciągu 60 minut. Plik zawiera 1200 odbiorców. '
      + 'Poproś administratora bramki o zmianę ochrony przed burzą w integracji.';
    const blocked = renderFilePreview({ ...PREVIEW, blocked: reason }, META, { input: INPUT, sample: 0 });
    expect(blocked).toContain(`<p class="notice n-fail">${reason}</p>`);
    expect(blocked).toContain(`data-act="send" disabled>Wyślij do ${num(1200)} odbiorców</button>`);
    const ready = renderFilePreview(PREVIEW, META, { input: INPUT, sample: 0 });
    expect(ready).toContain(`data-act="send">Wyślij do ${num(1200)} odbiorców</button>`);
    expect(ready).not.toContain('n-fail');
    const scheduled = renderFilePreview({ ...PREVIEW, schedule: { startAt: '2026-11-20T07:00:00.000Z', handoverAt: '2026-11-20T06:50:00.000Z' } }, META, { input: INPUT, sample: 0 });
    expect(scheduled).toContain(`data-act="send">Zaplanuj wysyłkę do ${num(1200)} odbiorców</button>`);
    expect(ready).toContain('<button type="button" class="btn" data-act="fix">Popraw treść w rozmowie</button>');

    const calls: Array<[string, Args]> = [];
    const w = viewWindow({ answer: (args, name) => { calls.push([name, args]); return { content: [], structuredContent: {} }; } });
    startFile(w.win, { version: '1.13.0' });
    w.notify('ui/notifications/tool-input', { arguments: INPUT });
    w.notify('ui/notifications/tool-result', { content: [], structuredContent: PREVIEW, _meta: { ...META, confirm: 'mig_cf_1' } });
    await until(() => w.node('tresc').innerHTML.includes('dla Hurtownia Kowalski'));
    w.click('fix');
    await until(() => w.sent.some((m) => m.method === 'ui/message'));
    expect(w.sent.find((m) => m.method === 'ui/message')!.params).toEqual({ role: 'user', content: [{ type: 'text', text: FIX_MESSAGE }] });
    expect(calls).toEqual([]);
  });

  it('widok: zmiana kolumny identyfikatora i przełączenie wiadomości; Wyślij woła send_file_sms z kluczem i przechodzi w postęp', async () => {
    const calls: Array<[string, Args]> = [];
    const w = viewWindow({
      answer: (args, name) => {
        calls.push([name, args]);
        if (name === 'prepare_file_sms') return { content: [], structuredContent: { ...PREVIEW, draftId: 'drf_nowy' }, _meta: { ...META, confirm: 'mig_cf_2' } };
        if (name === 'send_file_sms') return { content: [], structuredContent: { draftId: 'drf_nowy', kind: 'file', id: 'fsd_7k2', packages: ['pkg_1', 'pkg_2'], recipients: 1200, schedule: null, repeated: false } };
        return { content: [], structuredContent: STATUS, _meta: { name: 'przypomnienia-listopad.xlsx' } };
      },
    });
    startFile(w.win, { version: '1.13.0' });
    w.notify('ui/notifications/tool-input', { arguments: INPUT });
    w.notify('ui/notifications/tool-result', { content: [], structuredContent: PREVIEW, _meta: { ...META, confirm: 'mig_cf_1' } });
    await until(() => w.node('tresc').innerHTML.includes('dla Hurtownia Kowalski'));
    w.click('sample', { i: '2' });
    expect(w.node('tresc').innerHTML).toContain('dla Biuro Zielińska');
    w.change({ name: 'clientIdColumn', value: 'Numer' });
    await until(() => calls.length === 1);
    expect(calls[0]).toEqual(['prepare_file_sms', { text: TEMPLATE, clientIdColumn: 'Numer' }]);
    w.change({ name: 'clientIdColumn', value: '' });
    await until(() => calls.length === 2);
    expect(calls[1]).toEqual(['prepare_file_sms', { text: TEMPLATE }]);
    w.click('send');
    await until(() => calls.length === 4);
    expect(calls[2]).toEqual(['send_file_sms', { draftId: 'drf_nowy', confirm: 'mig_cf_2' }]);
    expect(calls[3]).toEqual(['file_send_status', { id: 'fsd_7k2' }]);
    await until(() => w.node('tresc').innerHTML.includes('Wysyłka z pliku fsd_7k2'));
    expect(w.node('tresc').innerHTML).toContain('<div class="txt">przypomnienia-listopad.xlsx</div>');
    expect(w.node('na-zywo').textContent).toBe('● na żywo, co 30 s');
  });

  it('widok: wartości z pliku z <img onerror> i nazwa pliku jako tekst', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderFilePreview(PREVIEW, {
      ...META, name: `${evil}.xlsx`, columns: ['Numer', evil], samples: [{ line: 2, to: '48601000011', text: `Dla ${evil}`, parts: 1 }], repeatedNumbers: [evil],
    }, { input: { text: `Dla {${evil}}`, clientIdColumn: evil }, sample: 0 });
    expect(html).not.toContain('<img');
    expect(html).toContain('Dla &lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<div class="txt">&lt;img src=x onerror=alert(1)&gt;.xlsx</div>');
    const progress = renderFileProgress(STATUS, { name: `${evil}.xlsx` });
    expect(progress).not.toContain('<img');
    expect(progress).toContain('&lt;img src=x onerror=alert(1)&gt;.xlsx');
  });

  it('widok postępu: suma rozsyłek, odświeżanie co 30 s do stanów ostatecznych, Zaplanowana na i Anuluj wysyłkę', async () => {
    const html = renderFileProgress(STATUS, { name: 'przypomnienia-listopad.xlsx' });
    expect(html).toContain('<h3>Wysyłka z pliku fsd_7k2</h3>');
    expect(html).toContain('<div class="lbl">W trakcie</div><div class="v">250</div>');
    expect(html).toContain('<div class="lbl">Doręczone</div><div class="v">900</div>');
    expect(html).toContain('<div class="lbl">Niedoręczone</div><div class="v">40</div>');
    expect(html).toContain('<div class="lbl">Pozostałe</div><div class="v">10</div>');
    expect(html).toContain('Rozsyłki według stanu: w wysyłce 1, zakończona 1');
    expect(html).not.toContain('data-act="csv"');
    expect(html).not.toContain('Anuluj wysyłkę');
    const done = renderFileProgress({ ...STATUS, byStatus: { completed: 2 }, statusLabels: { completed: 'zakończona' }, reportReady: true, final: true }, { name: 'a.csv' });
    expect(done).toContain('data-act="csv" data-file="report">Pobierz raport CSV</button>');
    expect(done).toContain('data-file="failed">Pobierz CSV niedoręczonych</button>');

    const scheduled = renderFileProgress(SCHEDULED, { name: 'a.csv' });
    expect(scheduled).toContain('<h3>Zaplanowana wysyłka</h3>');
    expect(scheduled).toContain('<span class="lbl">Zaplanowana na</span><div class="txt">2026-11-20 08:00</div>');
    expect(scheduled).toContain('<span class="lbl">Przekazanie do Multiinfo</span><div class="txt">2026-11-20 07:50</div>');
    expect(scheduled).toContain('<button type="button" class="btn btn-danger" data-act="cancel-file">Anuluj wysyłkę</button>');
    expect(renderFileProgress({ ...SCHEDULED, cancellable: 0 }, { name: 'a.csv' })).not.toContain('Anuluj wysyłkę');
    expect(filePending(SCHEDULED)).toBe(true);
    expect(filePending(STATUS)).toBe(false);
    expect(fileSettled(STATUS)).toBe(false);
    expect(fileSettled({ ...STATUS, reportReady: true })).toBe(true);
    // Wysyłka anulowana w całości: odświeżanie się kończy, a raport nie powstanie.
    const cancelled = { ...STATUS, byStatus: { cancelled: 2 }, statusLabels: { cancelled: 'anulowana' }, delivered: 0, failed: 0, other: 0, notSent: 1200, final: true, cancelled: true };
    expect(fileSettled(cancelled)).toBe(true);
    expect(renderFileProgress(cancelled, { name: 'a.csv' })).toContain('Wysyłka została anulowana, dlatego raport doręczeń nie powstanie');
    expect(renderFileProgress(cancelled, { name: 'a.csv' })).not.toContain('Raport CSV wszystkich rozsyłek będzie dostępny');

    // Odświeżanie co 30 s do raportu wszystkich rozsyłek.
    let n = 0;
    const calls: unknown[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const bridge = { callTool: async (name: string, args: unknown) => { calls.push([name, args]); n += 1; return { structuredContent: n < 2 ? STATUS : { ...STATUS, reportReady: true, final: true } }; } };
    const win = { setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); } };
    const ends: string[] = [];
    const data: unknown[] = [];
    watchFileSend(bridge, win, 'fsd_7k2', { onData: (d: unknown) => data.push(d), onEnd: (why: string) => ends.push(why) });
    expect(timers.map((t) => t.ms)).toEqual([FILE_REFRESH_MS]);
    expect(FILE_REFRESH_MS).toBe(30_000);
    timers.shift()!.fn();
    await until(() => data.length === 1);
    expect(timers.length).toBe(1);
    timers.shift()!.fn();
    await until(() => ends.length === 1);
    expect(ends).toEqual(['settled']);
    expect(calls).toEqual([['file_send_status', { id: 'fsd_7k2' }], ['file_send_status', { id: 'fsd_7k2' }]]);
    // Po 30 minutach odświeżanie kończy się bez stanu ostatecznego.
    let clock = 0;
    const late: string[] = [];
    const lateTimers: Array<() => void> = [];
    watchFileSend({ callTool: async () => ({ structuredContent: STATUS }) }, { setTimeout: (fn: () => void) => { lateTimers.push(fn); } }, 'fsd_7k2',
      { onData: () => undefined, onEnd: (why: string) => late.push(why) }, () => clock);
    clock = FILE_REFRESH_MAX_MS;
    expect(FILE_REFRESH_MAX_MS).toBe(1_800_000);
    lateTimers.shift()!();
    await until(() => late.length === 1);
    expect(late).toEqual(['timeout']);

    // Błąd połączenia: kolejny odczyt za 30 s, a po 30 minutach koniec z błędem.
    clock = 0;
    const replies: unknown[] = [hostError('tools/call', '502'), hostError('tools/call', '502')];
    const flaky: string[] = [];
    const flakyTimers: Array<{ fn: () => void; ms: number }> = [];
    watchFileSend({ callTool: async () => { throw replies.shift(); } }, { setTimeout: (fn: () => void, ms: number) => { flakyTimers.push({ fn, ms }); } },
      'fsd_7k2', { onData: () => undefined, onEnd: (why: string) => flaky.push(why), onRetry: (detail: string) => flaky.push(`ponowienie: ${detail}`) }, () => clock);
    flakyTimers.shift()!.fn();
    await until(() => flaky.length === 1);
    expect(flakyTimers.map((t) => t.ms)).toEqual([FILE_REFRESH_MS]);
    clock = FILE_REFRESH_MAX_MS;
    flakyTimers.shift()!.fn();
    await until(() => flaky.length === 2);
    expect(flaky).toEqual(['ponowienie: 502', 'error']);
    expect(flakyTimers).toEqual([]);
  });

  it('widok postępu: Anuluj wysyłkę woła cancel_package z identyfikatorem wysyłki z pliku i odświeża stan', async () => {
    const calls: Array<[string, Args]> = [];
    let cancelled = false;
    const w = viewWindow({
      answer: (args, name) => {
        calls.push([name, args]);
        if (name === 'cancel_package') {
          cancelled = true;
          return { content: [{ type: 'text', text: 'Anulowano 2 z 2 rozsyłek wysyłki z pliku fsd_7k2.' }], structuredContent: { id: 'fsd_7k2', cancelled: 2, handedOver: 0 } };
        }
        return { content: [], structuredContent: cancelled ? { ...SCHEDULED, byStatus: { cancelled: 2 }, statusLabels: { cancelled: 'anulowana' }, cancellable: 0, notSent: 1200, final: true, reportReady: true } : SCHEDULED, _meta: { name: 'a.csv' } };
      },
    });
    startFile(w.win, { version: '1.13.0' });
    w.notify('ui/notifications/tool-input', { arguments: { id: 'fsd_7k2' } });
    w.notify('ui/notifications/tool-result', { content: [], structuredContent: SCHEDULED, _meta: { name: 'a.csv' } });
    await until(() => w.node('tresc').innerHTML.includes('Zaplanowana wysyłka'));
    // Wysyłka czeka na termin, dlatego widok nie odświeża jej na żywo.
    expect(w.node('na-zywo').textContent).toBe('');
    w.click('cancel-file');
    await until(() => calls.length === 2);
    expect(calls).toEqual([['cancel_package', { id: 'fsd_7k2' }], ['file_send_status', { id: 'fsd_7k2' }]]);
    await until(() => w.node('komunikat').textContent === 'Anulowano 2 z 2 rozsyłek wysyłki z pliku fsd_7k2.');
    expect(w.node('tresc').innerHTML).not.toContain('Anuluj wysyłkę');
  });

  it('Co mogę?: rozsyłka z pliku przy zakresie send', () => {
    const base = {
      available: true, connection: 'Ewa Nowak', integration: 'Agent AI - biuro handlowe', scopes: [{ id: 'send', label: 'Wysyłka SMS-ów' }], expiresAt: null,
      services: [{ id: '20841', label: 'Biuro handlowe' }], maxParts: 3, overflow: 'reject', ratePerMin: 60,
      guard: { calls: 0, callLimit: 30, recipients: 0, recipientLimit: 1000, windowMinutes: 60, resetsAt: null }, groups: 0, schedule: null,
    };
    const html = renderStatus({ ...base, file: { rows: 50_000, megabytes: 20 } }, {});
    expect(html).toContain('<h3>Rozsyłka z pliku</h3>');
    expect(html).toContain(`Plik CSV, TXT albo XLSX do ${num(50_000)} wierszy danych i 20 MB wybiera pracownik w widoku bramki. `
      + 'Wartości z pliku widzi wyłącznie pracownik, a agent otrzymuje nazwy kolumn i liczby.');
    expect(renderStatus({ ...base, file: null }, {})).not.toContain('Rozsyłka z pliku');
  });
});
