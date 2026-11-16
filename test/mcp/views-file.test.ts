import { describe, expect, it } from 'vitest';
import { FILE_LOADED, splitCsv, transferFile } from '../../src/mcp/views/client/plik.js';
import { FILE_LOADED_MESSAGE } from '../../src/mcp/tools/file.ts';
import { BUILT_VIEWS, viewHtml } from '../../src/mcp/views/index.ts';

type Args = { fileId?: string; offset: number; rows: Array<{ line: number }>; done?: boolean; totalRows?: number; columns?: string[]; name?: string };

/** Atrapa mostu: bramka przyjmuje porcje jak AgentFilesRepo, a pierwsza wskazana porcja dostaje odmowę limitu żądań. */
function fakeBridge(opts: { limitedAt?: number[]; message?: boolean } = {}) {
  const calls: Args[] = [];
  const messages: string[] = [];
  const limited = new Set(opts.limitedAt ?? []);
  let received = 0;
  let total = 0;
  return {
    calls, messages,
    async callTool(name: string, args: Args) {
      expect(name).toBe('upload_file_rows');
      calls.push(args);
      if (limited.delete(calls.length)) {
        return { isError: true, content: [{ type: 'text', text: 'Przekroczono limit 60 żądań na minutę klucza. Spróbuj ponownie za minutę.' }], structuredContent: { error: 'rate_limited', retryAfterSec: 60 } };
      }
      if (args.totalRows !== undefined) total = args.totalRows;
      if (args.offset === received) received += args.rows.length;
      return { content: [], structuredContent: { fileId: 'fil_1', received, total, complete: args.done === true && received === total } };
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

describe('widok próbny rozsyłki z pliku', () => {
  it('widok próbny: porcje w kolejności offsetów, ponowienie porcji po rate_limited, stała wiadomość po przesłaniu', async () => {
    const bridge = fakeBridge({ limitedAt: [2] });
    const waits: number[] = [];
    const chunks: Array<{ offset: number; rows: number; retried: boolean }> = [];
    let clock = 0;
    const result = await transferFile(bridge, FILE, {
      size: 2, wait: async (ms: number) => { waits.push(ms); }, clock: () => (clock += 10),
      onChunk: (c: { offset: number; rows: number; ms: number; retried: boolean }) => chunks.push({ offset: c.offset, rows: c.rows, retried: c.retried }),
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

  it('błąd porcji inny niż limit żądań przerywa przesyłanie bez wiadomości do rozmowy', async () => {
    const bridge = fakeBridge();
    const failing = {
      ...bridge,
      callTool: async (name: string, args: Args) => (args.offset === 2
        ? { isError: true, content: [{ type: 'text', text: 'Szkic pliku wygasł.' }], structuredContent: { error: 'file_expired' } }
        : bridge.callTool(name, args)),
    };
    const result = await transferFile(failing, FILE, { size: 2, wait: async () => undefined, clock: () => 0 });
    expect(result).toEqual({ error: 'Szkic pliku wygasł.', forwarded: false });
    expect(bridge.messages).toEqual([]);
  });

  it('splitCsv: UTF-8 ze znacznikiem BOM, średnik albo przecinek, puste wiersze pominięte, numer wiersza z pliku', () => {
    expect(splitCsv('﻿Numer;Kontrahent;Kwota\r\n48601000011;Hurtownia Łódź;1 234,50 zł\r\n\r\n48601000012;Serwis Południe;99,00 zł\r\n')).toEqual({
      columns: ['Numer', 'Kontrahent', 'Kwota'], phoneColumn: 0,
      rows: [{ line: 2, cells: ['48601000011', 'Hurtownia Łódź', '1 234,50 zł'] }, { line: 4, cells: ['48601000012', 'Serwis Południe', '99,00 zł'] }],
    });
    expect(splitCsv('Kontrahent,Telefon\nFlota Północ,48601000021\n')).toEqual({
      columns: ['Kontrahent', 'Telefon'], phoneColumn: 1, rows: [{ line: 2, cells: ['Flota Północ', '48601000021'] }],
    });
    expect(splitCsv('\n\n')).toBeNull();
  });

  it('dokument widoku plik: pole wyboru pliku, lista rozmiaru porcji i wiersz środowiska', () => {
    expect(BUILT_VIEWS).toContain('plik');
    const html = viewHtml('plik');
    expect(html).toContain('Rozsyłka z pliku - Multiinfo Gate');
    expect(html).toContain('startFile(window,');
  });
});
