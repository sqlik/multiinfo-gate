import { describe, expect, it } from 'vitest';
import { num } from '../../src/mcp/views/client/bridge.js';
import { FILE_LOADED, renderLoaded, startFile, transferFile } from '../../src/mcp/views/client/plik.js';
import { analyze, ROWS_MAX, UPLOAD_CHUNK } from '../../src/mcp/views/client/plik-tabela.js';
import { FILE_LOADED_MESSAGE } from '../../src/mcp/tools/file.ts';
import { BUILT_VIEWS, viewFiles, viewHtml } from '../../src/mcp/views/index.ts';
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
function viewWindow(gate: ReturnType<typeof gateway>) {
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
      else if (msg.method === 'tools/call') reply(gate.answer((msg.params as { arguments: Args }).arguments));
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
  const click = (act: string) => {
    const button = { dataset: { act }, disabled: false };
    node('tresc').handlers.get('click')!({ target: { closest: (sel: string) => (sel.includes('data-act') ? button : null) } });
  };
  return { win, node, sent, pick, click };
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
    expect(html).toContain('<select class="sel" id="numer"><option value="0" selected>Numer</option><option value="1">Kontrahent</option>');
    expect(html).toContain('<input type="checkbox" id="naglowek" checked>');
    expect(html).toContain('Pierwszy wiersz zawiera nazwy kolumn');
    expect(html).toContain('<div class="txt">7</div>');
    expect(html).toContain('<div class="txt">UTF-8</div>');
    expect(html).toContain('<div class="txt">średnik</div>');
    expect(html).toContain('<button type="button" class="btn btn-primary" data-act="upload">Przekaż plik do bramki</button>');
  });

  it('widok: kolumna numeru do wyboru, arkusze skoroszytu jako lista, limit wierszy wyłącza przekazanie', () => {
    const rows = [{ line: 1, cells: ['Telefon', 'Tel'] }, { line: 2, cells: ['48601000011', '48601000012'] }];
    const html = renderLoaded(loaded(rows, { source: { kind: 'xlsx', sheet: 1, book: { sheets: [{ name: 'Listopad' }, { name: 'Grudzień <b>' }] } } }));
    expect(html).toContain('<select class="sel" id="numer"><option value="" selected>Wybierz kolumnę z numerami</option><option value="0">Telefon</option><option value="1">Tel</option></select>');
    expect(html).toContain('Numery telefonów występują w kilku kolumnach, dlatego wybierz właściwą z listy');
    expect(html).toContain('<select class="sel" id="arkusz"><option value="0">Listopad</option><option value="1" selected>Grudzień &lt;b&gt;</option></select>');
    expect(html).toContain('<button type="button" class="btn btn-primary" data-act="upload" disabled>Przekaż plik do bramki</button>');
    const many = Array.from({ length: ROWS_MAX + 1 }, (_, i) => ({ line: i + 2, cells: ['48601000011'] }));
    const over = renderLoaded(loaded([{ line: 1, cells: ['Numer'] }, ...many]));
    expect(over).toContain('data-act="upload" disabled');
    expect(over).toContain(`Plik zawiera ${num(50_001)} wierszy danych, a bramka przyjmuje najwyżej ${num(50_000)} wierszy. Podziel plik na mniejsze części.`);
  });

  it('widok: przesyłanie dopiero po Przekaż plik do bramki, porcje UPLOAD_CHUNK, stała wiadomość po przesłaniu', async () => {
    const gate = gateway();
    const w = viewWindow(gate);
    startFile(w.win, { version: '1.13.0' });
    expect(w.node('tresc').innerHTML).toContain('accept=".csv,.txt,.xlsx"');
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
    expect(viewFiles('plik')).toEqual(['bridge.js', 'measure.js', 'chart.js', 'plik-csv.js', 'plik-xlsx.js', 'plik-tabela.js', 'plik.js']);
    const html = viewHtml('plik');
    expect(html).toContain('Rozsyłka z pliku - Multiinfo Gate');
    expect(html).toContain('startFile(window,');
    expect(html).not.toContain('Środowisko');
    expect(html).not.toContain('Rozmiar porcji');
    expect(html).not.toMatch(/próba A/i);
  });

  it('style: pole wyboru pliku i listy wyśrodkowane w pionie, strzałka listy z odstępem, obwódki pól pliku w kolorze akcji', () => {
    expect(VIEW_STYLE).toContain('.pick{position:relative;display:flex;align-items:center;');
    expect(VIEW_STYLE).toMatch(/select\.sel\{[^}]*appearance:none;[^}]*padding:0 34px 0 10px;/);
    expect(VIEW_STYLE).toContain('.accent .sel,.accent .pick{border-color:var(--signal)}');
  });
});
