import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../src/api/server.ts';
import type { AgentConfig } from '../../src/integrations/config.ts';
import { FILE_COLUMNS_NOTICE } from '../../src/integrations/agent-file.ts';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.ts';
import { FILE_LOADED_MESSAGE } from '../../src/mcp/tools/file.ts';
import { AgentFilesRepo } from '../../src/store/agent-files.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { FileSendsRepo } from '../../src/store/file-sends.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { formatCount } from '../../src/text/numbers.ts';
import { AGENT_SEED_AT, agentApiDeps, seedAgent } from '../helpers/agent.ts';
import { mcpSession, textOf } from '../helpers/mcp.ts';

const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);
const COLUMNS = ['Numer', 'Kontrahent', 'Kwota', 'Termin'];
const VALUES = ['48601000011', 'Hurtownia Kowalski', '1 234,50 zł', '30.11.2026'];
const NAME = 'przypomnienia-listopad.xlsx';
const BASE = 'https://bramka.serwis.example';

let db: Database;
let key: Buffer;
let seed: ReturnType<typeof seedAgent>;
let app: FastifyInstance;

function setup(scopes: AgentConfig['scopes'] = ['send']): void {
  seed = seedAgent(db, key, { scopes });
  app = buildApiServer(agentApiDeps(db, key, { now: () => NOW, apiUrl: BASE }));
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

const TEXT = 'Przypominamy o płatności faktury dla {Kontrahent} na kwotę {Kwota} do {Termin}.';
const ROWS = [
  { line: 2, cells: VALUES },
  { line: 3, cells: ['48601000012', 'Serwis Nowak', '99,00 zł', '01.12.2026'] },
  { line: 4, cells: ['brak numeru', 'Biuro Zielińska', '10,00 zł', '02.12.2026'] },
];
type Session = Awaited<ReturnType<typeof mcpSession>>;
const loaded = async (mcp: Session) => mcp.call('upload_file_rows', { ...header, offset: 0, rows: ROWS, done: true });

describe('file_summary, prepare_file_sms i send_file_sms', () => {
  it('file_summary: nazwy kolumn, kolumna numeru, liczba wierszy i składnia pól {Nazwa kolumny} dla agenta', async () => {
    setup();
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    await loaded(mcp);
    const result = await mcp.call('file_summary');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ columns: COLUMNS, phoneColumn: 'Numer', rows: 3, invalidPhones: 1, notice: FILE_COLUMNS_NOTICE });
    const text = textOf(result);
    expect(text).toContain(`${FILE_COLUMNS_NOTICE} „Numer”, „Kontrahent”, „Kwota”, „Termin”`);
    expect(text).toContain('{Nazwa kolumny}');
    expect(text).toContain('prepare_file_sms');
    expect(text).toContain(`Kolumna numeru telefonu: ${FILE_COLUMNS_NOTICE} „Numer”.`);
  });

  it('file_summary bez pliku: file_missing z prośbą o wybór pliku w widoku', async () => {
    setup();
    const result = await (await mcpSession(app, seed.secret, { apps: true })).call('file_summary');
    expect(result).toMatchObject({ isError: true, structuredContent: { error: 'file_missing' } });
  });

  it('prepare_file_sms i send_file_sms przez MCP: podgląd z kluczem w _meta, wysyłka przyciskiem widoku', async () => {
    setup();
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    await loaded(mcp);
    const prepared = await mcp.call('prepare_file_sms', { text: TEXT });
    expect(prepared.isError).toBeUndefined();
    expect(prepared.structuredContent).toMatchObject({ recipients: 2, fields: ['Kontrahent', 'Kwota', 'Termin'], excluded: { invalid_phone: 1 }, blocked: null });
    expect(prepared._meta!.confirm).toMatch(/^mig_cf_/);
    expect(prepared._meta!.samples.map((s: { line: number }) => s.line)).toEqual([2, 3]);
    expect(prepared._meta!.excludedRows).toEqual([{ line: 4, reason: 'invalid_phone', phone: 'brak numeru' }]);
    // Próba B (B6): liczba wierszy po myślniku z rzeczownikiem, a nie doklejona do przyczyny.
    expect(textOf(prepared)).toContain('Wiersze wyłączone z wysyłki: 1. Przyczyny: błędny numer telefonu - 1 wiersz.');
    expect(textOf(prepared)).toContain('Wysyłkę zatwierdza człowiek przyciskiem „Wyślij” w podglądzie bramki.');
    const draftId = prepared.structuredContent!.draftId as string;
    const sent = await mcp.call('send_file_sms', { draftId, confirm: prepared._meta!.confirm });
    expect(sent.isError).toBeUndefined();
    expect(sent.structuredContent).toMatchObject({ draftId, kind: 'file', recipients: 2, repeated: false });
    expect(textOf(sent)).toMatch(/^Przyjęto wysyłkę z pliku fsd_\S+ do 2 odbiorców w 1 rozsyłce\./);
  });

  it('prepare_file_sms i send_file_sms bez widoków: views_required', async () => {
    setup();
    const mcp = await mcpSession(app, seed.secret);
    for (const [name, args] of [['prepare_file_sms', { text: TEXT }], ['send_file_sms', { draftId: 'drf_obcy' }]] as const) {
      const result = await mcp.call(name, args);
      expect(result).toMatchObject({ isError: true, structuredContent: { error: 'views_required' } });
    }
  });

  it('send_prepared ze szkicem pliku i send_file_sms ze szkicem SMS-a: draft_kind', async () => {
    setup();
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    await loaded(mcp);
    const file = await mcp.call('prepare_file_sms', { text: TEXT });
    const viaPrepared = await mcp.call('send_prepared', { draftId: file.structuredContent!.draftId, confirm: file._meta!.confirm });
    expect(viaPrepared).toMatchObject({ isError: true, structuredContent: { error: 'draft_kind' } });
    const sms = await mcp.call('prepare_sms', { to: ['48601000011'], text: 'Serwis zaprasza na przeglad floty w czwartek.' });
    const viaFile = await mcp.call('send_file_sms', { draftId: sms.structuredContent!.draftId, confirm: sms._meta!.confirm });
    expect(viaFile).toMatchObject({ isError: true, structuredContent: { error: 'draft_kind' } });
    expect((db.prepare('SELECT COUNT(*) AS n FROM packages').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(0);
  });

  it('tools/list z widokami: file_summary, prepare_file_sms z widokiem plik, send_file_sms tylko dla widoku', async () => {
    setup();
    const tools = await (await mcpSession(app, seed.secret, { apps: true })).tools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('file_summary')!._meta).toBeUndefined();
    expect(byName.get('file_summary')!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get('prepare_file_sms')!._meta).toEqual({ ui: { resourceUri: 'ui://multiinfo-gate/plik' } });
    expect(byName.get('send_file_sms')!._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(byName.get('send_file_sms')!.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
    // Znak „-” w identyfikatorze klienta nazywa się łącznikiem, jak w dokumentacji i w konektorze.
    const clientId = JSON.stringify((byName.get('prepare_file_sms')!.inputSchema as { properties: Record<string, unknown> }).properties.clientIdColumn);
    expect(clientId).toContain('kropki, podkreślenia i łączniki');
    expect(clientId).not.toContain('myślnik');
  });
});

/** Dwa wiersze: pierwszy w GSM, drugi z „Ł” w nazwie kontrahenta, dlatego wysyłka powstaje w dwóch rozsyłkach. */
const MIXED = [
  { line: 2, cells: ['48601000011', 'Hurtownia Kowalski', '1 234,50 zł', '30.11.2026'] },
  { line: 3, cells: ['48601000012', 'Serwis Łódź', '99,00 zł', '01.12.2026'] },
];
const GSM_TEXT = 'Przypominamy o fakturze dla {Kontrahent} z terminem {Termin}.';
const START = '2026-11-20 08:00';

/** Wysyłka z pliku z dwóch rozsyłek przez MCP; z `startAt` zaplanowana. */
async function fileSend(mcp: Session, startAt?: string): Promise<{ id: string; packages: string[] }> {
  await mcp.call('upload_file_rows', { ...header, totalRows: 2, offset: 0, rows: MIXED, done: true });
  const prepared = await mcp.call('prepare_file_sms', { text: GSM_TEXT, ...(startAt === undefined ? {} : { startAt }) });
  const sent = await mcp.call('send_file_sms', { draftId: prepared.structuredContent!.draftId, confirm: prepared._meta!.confirm });
  expect(sent.isError).toBeUndefined();
  return { id: sent.structuredContent!.id as string, packages: sent.structuredContent!.packages as string[] };
}

/** Rozsyłka zakończona z gotowym raportem: odbiorca 48601000011 doręczony, pozostali niedoręczeni. */
function reported(packageId: string, at: string): void {
  const repo = new PackagesRepo(db);
  repo.setCreated(packageId, `mi-${packageId}`);
  repo.setCompleted(packageId, NOW);
  repo.applyReport(packageId, repo.recipients(packageId).map((r, i) => ({
    miId: `${9001 + i}${r.dest.slice(-1)}`, dest: r.dest, miStatus: r.dest === '48601000011' ? 21 : 11,
    status: r.dest === '48601000011' ? 'delivered' as const : 'failed' as const, rawStatus: '', changedAt: at, clientId: null,
  })));
  repo.setReport(packageId, { status: 'ready' });
}

describe('postęp, anulowanie i raport wysyłki z pliku', () => {
  it('file_send_status: liczby według stanów, nazwa pliku tylko w _meta, wysyłka innego klucza nieznana', async () => {
    setup(['send', 'read_sent']);
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    const { id } = await fileSend(mcp, START);
    const result = await mcp.call('file_send_status', { id });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      id, created: { at: NOW.toISOString() }, recipients: 2, packages: 2, byStatus: { scheduled: 2 },
      delivered: 0, failed: 0, other: 0, notSent: 0, cancellable: 2, reportReady: false, final: false,
      schedule: { startAt: { at: '2026-11-20T07:00:00.000Z' }, handoverAt: { at: '2026-11-20T06:50:00.000Z' } },
      statusLabels: { scheduled: 'zaplanowana' },
    });
    expect(result._meta).toEqual({ name: NAME });
    const forAgent = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
    for (const value of [NAME, 'Hurtownia', 'Łódź', '1 234,50']) expect(forAgent).not.toContain(value);
    const text = textOf(result);
    expect(text).toContain(`Wysyłka z pliku ${id} do 2 odbiorców w 2 rozsyłkach, przyjęta`);
    expect(text).toContain('Rozsyłki według stanu: zaplanowana 2.');
    expect(text).toContain('cancel_package');

    // Wysyłka innego klucza jest dla agenta nieznana, tak jak cudza rozsyłka.
    const other = new ApiKeysRepo(db, key).insert({
      accountId: seed.accountId, name: 'inny', keyHash: 'h2', keyPrefix: 'p2', defaultServiceId: '24138', defaultOrig: null,
      maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
    });
    const foreign = new FileSendsRepo(db).insert({
      apiKeyId: other, integrationId: null, connectionId: null, requestedBy: null, name: 'obcy.csv', recipients: 1, startAt: null, createdAt: NOW.toISOString(),
    });
    for (const unknown of [foreign, 'fsd_nieznana']) {
      const refused = await mcp.call('file_send_status', { id: unknown });
      expect(refused).toMatchObject({ isError: true, structuredContent: { error: 'file_send_unknown' } });
      expect(JSON.stringify(refused)).not.toContain('obcy.csv');
    }
  });

  it('file_send_status: widok plik, zakres read_sent', async () => {
    setup(['send', 'read_sent']);
    const tools = await (await mcpSession(app, seed.secret, { apps: true })).tools();
    expect(tools.find((t) => t.name === 'file_send_status')!._meta).toEqual({ ui: { resourceUri: 'ui://multiinfo-gate/plik' } });
    db = openDatabase(':memory:');
    setup(['send']);
    const names = (await (await mcpSession(app, seed.secret, { apps: true })).tools()).map((t) => t.name);
    expect(names).not.toContain('file_send_status');
  });

  it('cancel_package z identyfikatorem wysyłki z pliku: wynik z liczbą anulowanych i przekazanych', async () => {
    setup(['send', 'read_sent']);
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    const { id, packages } = await fileSend(mcp, START);
    // Pierwsza rozsyłka jest właśnie przekazywana do Multiinfo.
    expect(new PackagesRepo(db).beginHandover(packages[0]!)).toBe(true);
    const result = await mcp.call('cancel_package', { id });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ id, cancelled: 1, handedOver: 1 });
    expect(textOf(result)).toBe(`Anulowano 1 z 2 rozsyłek wysyłki z pliku ${id}. `
      + 'Rozsyłki przekazane wcześniej do Multiinfo: 1. Multiinfo nie pozwala ich anulować.');
    expect(new PackagesRepo(db).get(packages[1]!)!.status).toBe('cancelled');
    // Ponowne anulowanie podaje ten sam wynik bez zmian.
    expect((await mcp.call('cancel_package', { id })).structuredContent).toEqual({ id, cancelled: 1, handedOver: 1 });
    const status = await mcp.call('file_send_status', { id });
    expect(status.structuredContent).toMatchObject({ byStatus: { queued: 1, cancelled: 1 }, cancellable: 0, notSent: 1 });

    // Wysyłkę z pliku spoza integracji agenta anuluje wyłącznie administrator.
    const foreign = new FileSendsRepo(db).insert({
      apiKeyId: seed.keyId, integrationId: null, connectionId: null, requestedBy: null, name: 'api.csv', recipients: 1, startAt: null, createdAt: NOW.toISOString(),
    });
    expect(await mcp.call('cancel_package', { id: foreign })).toMatchObject({ isError: true, structuredContent: { error: 'not_own' } });
  });

  it('wysyłka z pliku anulowana w całości: package_report wyjaśnia, że raport nie powstanie, a stan kończy odświeżanie', async () => {
    setup(['send', 'read_sent']);
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    const { id } = await fileSend(mcp, START);
    expect((await mcp.call('cancel_package', { id })).structuredContent).toEqual({ id, cancelled: 2, handedOver: 0 });
    const report = await mcp.call('package_report', { packageId: id, file: 'report' });
    expect(report).toMatchObject({ isError: true, structuredContent: { error: 'package_cancelled' } });
    expect(textOf(report)).toBe(`Wysyłka z pliku ${id} została anulowana, dlatego raport doręczeń nie powstanie.`);
    const status = await mcp.call('file_send_status', { id });
    expect(status.structuredContent).toMatchObject({ cancelled: true, reportReady: false, final: true });
    expect(textOf(status)).toContain('Wysyłka z pliku została anulowana, dlatego raport doręczeń nie powstanie.');
  });

  it('package_report z identyfikatorem wysyłki z pliku: jeden CSV z kolumną wiersz_pliku; przed zakończeniem report_not_ready', async () => {
    setup(['send', 'read_sent']);
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    const { id, packages } = await fileSend(mcp);
    const early = await mcp.call('package_report', { packageId: id, file: 'report' });
    expect(early).toMatchObject({ isError: true, structuredContent: { error: 'report_not_ready' } });
    expect(textOf(early)).toContain('file_send_status');
    // Raport jednej z dwóch rozsyłek nie wystarcza (P10).
    reported(packages[0]!, '2026-11-15 10:30:00');
    expect(await mcp.call('package_report', { packageId: id, file: 'report' })).toMatchObject({ isError: true, structuredContent: { error: 'report_not_ready' } });
    reported(packages[1]!, '2026-11-15 10:31:00');
    expect((await mcp.call('file_send_status', { id })).structuredContent).toMatchObject({ delivered: 1, failed: 1, reportReady: true, final: true });

    const link = await mcp.call('package_report', { packageId: id, file: 'report' });
    expect(link.isError).toBeUndefined();
    const url = link.structuredContent!.url as string;
    expect(link.structuredContent).toMatchObject({ packageId: id, file: 'report' });
    expect(textOf(link)).toContain(`raportu wysyłki z pliku ${id}`);
    const file = await app.inject({ method: 'GET', url: url.slice(BASE.length) });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toBe(`attachment; filename="raport-${id}.csv"`);
    expect(file.body.split('\r\n')).toEqual([
      'wiersz_pliku;numer;identyfikator_klienta;id_multiinfo;status;status_multiinfo;czas',
      '2;48601000011;;90011;delivered;21;2026-11-15 10:30:00',
      '3;48601000012;;90012;failed;11;2026-11-15 10:31:00',
      '',
    ]);
    const failed = await mcp.call('package_report', { packageId: id, file: 'failed' });
    const body = (await app.inject({ method: 'GET', url: (failed.structuredContent!.url as string).slice(BASE.length) })).body;
    expect(body.split('\r\n').slice(1)).toEqual(['3;48601000012;;90012;failed;11;2026-11-15 10:31:00', '']);
  });

  it('Co mogę?: rozsyłka z pliku przy zakresie send', async () => {
    setup(['send', 'read_sent']);
    const status = await (await mcpSession(app, seed.secret, { apps: true })).call('connection_status');
    expect(status.structuredContent).toMatchObject({ file: { rows: 50_000, megabytes: 20 } });
    expect(textOf(status)).toContain(`Rozsyłkę z pliku CSV, TXT albo XLSX do ${formatCount(50_000)} wierszy danych i 20 MB otwiera narzędzie open_file_send.`);
    db = openDatabase(':memory:');
    setup(['send_group', 'read_sent']);
    const group = await (await mcpSession(app, seed.secret, { apps: true })).call('connection_status');
    expect(group.structuredContent).toMatchObject({ file: null });
    expect(textOf(group)).not.toContain('open_file_send');
  });

  it('instrukcje serwera: postęp, raport i anulowanie wysyłki z pliku z jej identyfikatorem', () => {
    expect(SERVER_INSTRUCTIONS).toContain('Postęp wysyłki z pliku pokazuje narzędzie file_send_status, raport CSV wszystkich jej rozsyłek narzędzie package_report, '
      + 'a zaplanowaną wysyłkę anuluje narzędzie cancel_package. Każde z nich przyjmuje identyfikator wysyłki z pliku, który zaczyna się od fsd_.');
  });
});

describe('odczyty rozsyłek wysyłki z pliku', () => {
  const FILE_COLUMNS = ['Numer', 'Kontrahent', 'Kwota', 'Faktura', 'Kod'];
  const FILE_ROWS = [
    { line: 2, cells: ['48601000011', 'Hurtownia Kowalski', '1 234,50 zł', 'https://serwis.pl/f/FV-2026-0011', 'KLI-0011'] },
    { line: 3, cells: ['48601000012', 'Serwis Nowak', '99,00 zł', 'https://serwis.pl/f/FV-2026-0012', 'KLI-0012'] },
  ];
  const SECRET = ['48601000011', '48601000012', 'KLI-0011', 'KLI-0012', 'FV-2026-0011', 'FV-2026-0012', 'Hurtownia', '1 234,50'];
  /** To, co widzi agent: content i structuredContent, bez _meta. */
  const forAgent = (r: { content: unknown; structuredContent?: unknown }): string => JSON.stringify({ content: r.content, structuredContent: r.structuredContent });

  async function sentFromFile() {
    seed = seedAgent(db, key, { scopes: ['send', 'read_sent', 'campaigns'] });
    const deps = agentApiDeps(db, key, { now: () => NOW, apiUrl: BASE });
    const domainId = deps.linkDomains.create({ domain: 'l.serwis.pl', displayName: 'Serwis', homeUrl: null, bareLinks: false }, NOW);
    deps.apiKeys.setLinkSettings(seed.keyId, { mode: 'always', domainIds: [domainId], defaultDomainId: domainId, targets: ['serwis.pl'], validityDays: 30, utm: false });
    app = buildApiServer(deps);
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    await mcp.call('upload_file_rows', { name: NAME, columns: FILE_COLUMNS, phoneColumn: 0, totalRows: 2, offset: 0, rows: FILE_ROWS, done: true });
    const prepared = await mcp.call('prepare_file_sms', { text: 'Przypominamy o fakturze dla {Kontrahent} na kwote {Kwota}: {Faktura}', clientIdColumn: 'Kod' });
    const sent = await mcp.call('send_file_sms', { draftId: prepared.structuredContent!.draftId, confirm: prepared._meta!.confirm });
    expect(sent.isError).toBeUndefined();
    return mcp;
  }

  it('package_status rozsyłki z pliku: numery i identyfikatory klientów tylko w _meta dla widoku', async () => {
    const mcp = await sentFromFile();
    const packageId = ((await mcp.call('list_packages', {})).structuredContent!.items as Array<{ id: string }>)[0]!.id;
    const status = await mcp.call('package_status', { packageId });
    expect(status.isError).toBeUndefined();
    for (const value of SECRET) expect(forAgent(status), value).not.toContain(value);
    expect(status.structuredContent).toMatchObject({ items: [], hiddenItems: true });
    expect(textOf(status)).toContain('Rozsyłka pochodzi z wysyłki z pliku, dlatego numery odbiorców widzi wyłącznie pracownik w widoku bramki.');
    expect(status._meta).toMatchObject({ items: [{ to: '48601000011', clientId: 'KLI-0011' }, { to: '48601000012', clientId: 'KLI-0012' }] });
  });

  it('list_packages i package_status podają agentowi identyfikator wysyłki z pliku dla file_send_status i cancel_package', async () => {
    const mcp = await sentFromFile();
    const fileSendId = (db.prepare('SELECT id FROM file_sends').get() as { id: string }).id;
    const list = await mcp.call('list_packages', {});
    expect(list.structuredContent!.items[0]).toMatchObject({ fileSendId });
    expect(textOf(list)).toContain(`, wysyłka z pliku ${fileSendId}.`);
    const packageId = (list.structuredContent!.items as Array<{ id: string }>)[0]!.id;
    const status = await mcp.call('package_status', { packageId });
    expect(status.structuredContent).toMatchObject({ fileSendId });
    expect(textOf(status)).toContain(`Rozsyłka należy do wysyłki z pliku ${fileSendId}. Stan całej wysyłki podaje narzędzie file_send_status.`);
  });

  it('campaign_results kampanii z wysyłki z pliku: odbiorcy bez otwarcia i cele linków tylko w _meta dla widoku', async () => {
    const mcp = await sentFromFile();
    const name = ((await mcp.call('list_campaigns', {})).structuredContent!.items as Array<{ name: string }>)[0]!.name;
    const results = await mcp.call('campaign_results', { name });
    expect(results.isError).toBeUndefined();
    for (const value of SECRET) expect(forAgent(results), value).not.toContain(value);
    expect(results.structuredContent).toMatchObject({ unopened: { total: 2, items: [] }, targets: [], hiddenItems: true });
    expect(textOf(results)).toContain('Kampania obejmuje wysyłkę z pliku, dlatego numery odbiorców i adresy linków widzi wyłącznie pracownik w widoku bramki.');
    expect(results._meta).toMatchObject({ unopened: [{ to: '48601000011' }, { to: '48601000012' }], targets: [expect.objectContaining({ kind: 'individual' })] });
  });
});
