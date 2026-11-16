import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../src/api/server.ts';
import type { AgentConfig } from '../../src/integrations/config.ts';
import { FILE_LOADED_MESSAGE } from '../../src/mcp/tools/file.ts';
import { AgentFilesRepo } from '../../src/store/agent-files.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, agentApiDeps, seedAgent } from '../helpers/agent.ts';
import { mcpSession, textOf } from '../helpers/mcp.ts';

const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);
const COLUMNS = ['Numer', 'Kontrahent', 'Kwota', 'Termin'];
const VALUES = ['48601000011', 'Hurtownia Kowalski', '1 234,50 zł', '30.11.2026'];
const NAME = 'przypomnienia-listopad.xlsx';

let db: Database;
let key: Buffer;
let seed: ReturnType<typeof seedAgent>;
let app: FastifyInstance;

function setup(scopes: AgentConfig['scopes'] = ['send']): void {
  seed = seedAgent(db, key, { scopes });
  app = buildApiServer(agentApiDeps(db, key, { now: () => NOW }));
}

beforeEach(() => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
});

const header = { name: NAME, columns: COLUMNS, phoneColumn: 0, totalRows: 3 };
const line = (n: number) => ({ line: n, cells: VALUES.map((v, i) => (i === 1 ? `${v} ${n}` : v)) });

describe('upload_file_rows', () => {
  it('upload_file_rows: wynik fileId, received, total, complete bez żadnej wartości z wierszy', async () => {
    setup();
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    const first = await mcp.call('upload_file_rows', { ...header, offset: 0, rows: [line(2), line(3)] });
    expect(first.isError).toBeUndefined();
    const fileId = first.structuredContent!.fileId as string;
    expect(first.structuredContent).toEqual({ fileId, received: 2, total: 3, complete: false });
    // Ponowienie porcji przez aplikację nie dopisuje wierszy drugi raz.
    const repeated = await mcp.call('upload_file_rows', { fileId, offset: 0, rows: [line(2), line(3)] });
    expect(repeated.structuredContent).toEqual({ fileId, received: 2, total: 3, complete: false });
    const last = await mcp.call('upload_file_rows', { fileId, offset: 2, rows: [line(4)], done: true });
    expect(last.structuredContent).toEqual({ fileId, received: 3, total: 3, complete: true });
    expect(textOf(last)).toBe('Bramka przyjęła wszystkie wiersze pliku: 3 z 3. Plik jest gotowy do przygotowania wysyłki.');
    for (const result of [first, repeated, last]) {
      const json = JSON.stringify(result);
      for (const value of [...VALUES, NAME, 'Hurtownia']) expect(json).not.toContain(value);
    }
    expect(new AgentFilesRepo(db).rows(fileId).map((r) => r.line)).toEqual([2, 3, 4]);
  });

  it('upload_file_rows: done przy niekomplecie, luka w offsetach i szkic innego połączenia dają błąd narzędzia', async () => {
    setup();
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    const first = await mcp.call('upload_file_rows', { ...header, offset: 0, rows: [line(2)] });
    const fileId = first.structuredContent!.fileId as string;
    const early = await mcp.call('upload_file_rows', { fileId, offset: 1, rows: [line(3)], done: true });
    expect(early).toMatchObject({ isError: true, structuredContent: { error: 'upload_incomplete' } });
    const gap = await mcp.call('upload_file_rows', { fileId, offset: 5, rows: [line(7)] });
    expect(gap).toMatchObject({ isError: true, structuredContent: { error: 'upload_gap' } });
    const unknown = await mcp.call('upload_file_rows', { fileId: 'fil_obcy', offset: 0, rows: [] });
    expect(unknown).toMatchObject({ isError: true, structuredContent: { error: 'file_unknown' } });
    const headless = await mcp.call('upload_file_rows', { offset: 0, rows: [line(2)] });
    expect(headless).toMatchObject({ isError: true, structuredContent: { error: 'file_header_missing' } });
  });

  it('porcja 5000 wierszy ponad 512 KB przechodzi przez POST /mcp, a treść ponad 4 MB daje błąd JSON-RPC', async () => {
    setup();
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    // Wiersz około 150 bajtów, jak w próbie punktu kontrolnego A.
    const company = 'Przedsiębiorstwo Handlowo-Usługowe Hurtownia Kowalski i Wspólnicy';
    const rows = Array.from({ length: 5000 }, (_, i) => ({ line: i + 2, cells: [VALUES[0], `${company} ${i}`, VALUES[2], VALUES[3]] }));
    const params = { name: 'upload_file_rows', arguments: { ...header, totalRows: 5000, offset: 0, rows, done: true } };
    expect(JSON.stringify(params).length).toBeGreaterThan(512 * 1024);
    const result = (await mcp.rpc('tools/call', params)).json().result;
    expect(result.structuredContent).toMatchObject({ received: 5000, total: 5000, complete: true });
    const huge = await mcp.rpc('tools/call', { name: 'upload_file_rows', arguments: { ...header, offset: 0, rows: [{ line: 2, cells: ['x'.repeat(4 * 1024 * 1024)] }] } });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().error.message).toBe('Treść żądania przekracza 4 MB.');
  });

  it('upload_file_rows bez widoków: views_required', async () => {
    setup();
    const mcp = await mcpSession(app, seed.secret);
    const result = await mcp.call('upload_file_rows', { ...header, offset: 0, rows: [line(2)] });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: 'views_required' } });
    expect(textOf(result)).toBe('Przesyłanie pliku działa wyłącznie w widoku bramki, który wyświetlają aplikacje z widokami, na przykład claude.ai i ChatGPT.');
    expect(new AgentFilesRepo(db).current(seed.connectionId, NOW)).toBeUndefined();
  });
});

describe('open_file_send', () => {
  it('open_file_send z widokami: pole wyboru pliku w widoku i limity w danych strukturalnych', async () => {
    setup();
    const result = await (await mcpSession(app, seed.secret, { apps: true })).call('open_file_send');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ views: true, limits: { rows: 50_000, megabytes: 20, formats: ['csv', 'txt', 'xlsx'] } });
    expect(textOf(result)).toContain('Widok bramki wyświetla pole wyboru pliku z odbiorcami.');
  });

  it('open_file_send bez widoków: wyjaśnienie ze spec 5.9, bez widoku', async () => {
    setup();
    const result = await (await mcpSession(app, seed.secret)).call('open_file_send');
    expect(result.isError).toBeUndefined();
    expect(result._meta).toBeUndefined();
    expect(result.structuredContent).toEqual({ views: false });
    expect(textOf(result)).toBe('Rozsyłka z pliku działa wyłącznie w aplikacjach, które wyświetlają widoki bramki, na przykład w claude.ai i ChatGPT. '
      + 'Ta aplikacja nie wyświetla widoków bramki, dlatego nie może odczytać pliku z odbiorcami. Przekaż tę informację użytkownikowi.');
  });

  it('tools/list z widokami: upload_file_rows z visibility app, open_file_send z widokiem plik', async () => {
    setup();
    const tools = await (await mcpSession(app, seed.secret, { apps: true })).tools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('open_file_send')!._meta).toEqual({ ui: { resourceUri: 'ui://multiinfo-gate/plik' } });
    expect(byName.get('open_file_send')!.annotations).toEqual({ title: 'Rozsyłka z pliku', readOnlyHint: true, openWorldHint: false });
    expect(byName.get('upload_file_rows')!._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(byName.get('upload_file_rows')!.annotations).toEqual({
      title: 'Przekaż wiersze pliku', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
  });

  it('tools/list bez zakresu „Wysyłka SMS-ów” nie zawiera narzędzi pliku', async () => {
    setup(['send_group', 'read_sent']);
    const names = (await (await mcpSession(app, seed.secret, { apps: true })).tools()).map((t) => t.name);
    expect(names).not.toContain('open_file_send');
    expect(names).not.toContain('upload_file_rows');
  });

  it('stała wiadomość widoku po przekazaniu pliku jest tekstem ze specyfikacji', () => {
    expect(FILE_LOADED_MESSAGE).toBe('Plik z odbiorcami jest wczytany w widoku bramki. Przygotuj treść SMS-a z polami pliku.');
  });
});
