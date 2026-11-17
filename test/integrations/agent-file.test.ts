import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionContext } from '../../src/agents/connections.ts';
import { AgentError } from '../../src/integrations/agent.ts';
import {
  fileSendStatus, fileSummary, prepareFileSms, renderTemplate, sendFileDraft, type AgentFileDeps, type FileSmsInput,
} from '../../src/integrations/agent-file.ts';
import type { AgentConfig } from '../../src/integrations/config.ts';
import { openDatabase } from '../../src/store/db.ts';
import { formatCount } from '../../src/text/numbers.ts';
import { AGENT_SEED_AT, agentToolDeps, seedAgent } from '../helpers/agent.ts';

const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);
const MIN = 60_000;
const COLUMNS = ['Numer', 'Kontrahent', 'Kwota', 'Termin'];
const NAME = 'przypomnienia-listopad.xlsx';
const TEXT = 'Przypominamy o płatności faktury dla {Kontrahent} na kwotę {Kwota} do {Termin}.';
/** Treść w alfabecie GSM, dzięki czemu kodowanie zależy wyłącznie od wartości z pliku. */
const GSM_TEXT = 'Serwis {Kontrahent}: przeglad floty do {Termin}.';

let db: Database;
let key: Buffer;
let seed: ReturnType<typeof seedAgent>;
let deps: AgentFileDeps;
let notify: ReturnType<typeof vi.fn>;

function setup(opts: Parameters<typeof seedAgent>[2] = {}): void {
  db = openDatabase(':memory:');
  key = randomBytes(32);
  seed = seedAgent(db, key, { scopes: ['send', 'read_sent'], ...opts });
  notify = vi.fn();
  deps = { ...agentToolDeps(db, key, { now: () => NOW }), notifier: { notify } as never };
}

beforeEach(() => setup());

function ctx(at: Date = NOW): ConnectionContext {
  const resolved = deps.connections.resolve(seed.connectionId, at);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.ctx;
}

const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const phone = (i: number): string => `48601${String(i).padStart(6, '0')}`;
const row = (i: number, company = `Hurtownia Kowalski ${i}`): string[] => [phone(i), company, '1 234,50 zł', '30.11.2026'];

/** Szkic pliku połączenia tak, jak przekazuje go widok: wiersze od drugiego wiersza arkusza, porcjami po 5000. */
function upload(rows: string[][], opts: { columns?: string[]; phoneColumn?: number; name?: string; at?: Date } = {}): string {
  const columns = opts.columns ?? COLUMNS;
  const id = deps.files.create({
    connectionId: seed.connectionId, name: opts.name ?? NAME, columns, phoneColumn: opts.phoneColumn ?? 0, totalRows: rows.length, now: opts.at ?? NOW,
  });
  for (let i = 0; i < rows.length; i += 5000) {
    deps.files.append(id, i, rows.slice(i, i + 5000).map((cells, j) => ({ line: i + j + 2, cells })));
  }
  deps.files.complete(id);
  return id;
}

const prepare = (input: Partial<FileSmsInput> = {}, at = NOW) => prepareFileSms(deps, ctx(at), { text: TEXT, ...input }, at, { apps: true });

function agentError(fn: () => unknown): AgentError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  throw new Error('oczekiwano AgentError');
}

function setConfig(patch: Partial<AgentConfig>): void {
  const current = deps.integrations.get(seed.integrationId)!;
  deps.integrations.update(seed.integrationId, {
    name: current.name, serviceId: current.serviceId, orig: current.orig, preset: current.preset, enabled: current.enabled,
    config: { ...(current.config as object), ...patch }, storePayloads: current.storePayloads,
  }, NOW);
}

function shortener(): void {
  const domainId = deps.linkDomains.create({ domain: 'l.serwis.pl', displayName: 'Serwis', homeUrl: null, bareLinks: false }, NOW);
  deps.apiKeys.setLinkSettings(seed.keyId, { mode: 'always', domainIds: [domainId], defaultDomainId: domainId, targets: ['serwis.pl'], validityDays: 30, utm: false });
}

describe('fileSummary', () => {
  it('file_summary: kolumny, kolumna numeru, liczba wierszy i błędnych numerów; bez nazwy pliku i bez wartości', () => {
    upload([row(1), ['601 000 002', 'Serwis Nowak', '99,00 zł', '01.12.2026'], ['brak numeru', 'Biuro Zielińska', '10,00 zł', '02.12.2026']]);
    const summary = fileSummary(deps, ctx(), NOW);
    expect(summary).toEqual({ columns: COLUMNS, phoneColumn: 'Numer', rows: 3, invalidPhones: 1 });
    const json = JSON.stringify(summary);
    for (const value of [NAME, 'Hurtownia', 'Nowak', 'Zielińska', '1 234,50', phone(1), 'brak numeru']) expect(json).not.toContain(value);
  });

  it('file_summary bez kompletnego pliku: file_missing z prośbą o wybór pliku w widoku', () => {
    expect(agentError(() => fileSummary(deps, ctx(), NOW)).code).toBe('file_missing');
    const id = deps.files.create({ connectionId: seed.connectionId, name: NAME, columns: COLUMNS, phoneColumn: 0, totalRows: 2, now: NOW });
    deps.files.append(id, 0, [{ line: 2, cells: row(1) }]);
    const e = agentError(() => fileSummary(deps, ctx(), NOW));
    expect(e.code).toBe('file_missing');
    expect(e.message).toContain('open_file_send');
    expect(e.message).toContain('widoku bramki');
    expect(agentError(() => prepare()).code).toBe('file_missing');
  });
});

describe('renderTemplate', () => {
  it('pole {kwota} pasuje do kolumny Kwota; pole {Rabat}: field_unknown z listą kolumn', () => {
    expect(renderTemplate('Kwota: {kwota}, termin {TERMIN}.', COLUMNS)(row(1))).toEqual({ text: 'Kwota: 1 234,50 zł, termin 30.11.2026.', emptyField: false });
    const e = agentError(() => renderTemplate('Rabat {Rabat} dla {Kontrahent}', COLUMNS));
    expect(e.code).toBe('field_unknown');
    expect(e.message).toContain('„Rabat”');
    expect(e.message).toContain('„Numer”, „Kontrahent”, „Kwota”, „Termin”');
    upload([row(1)]);
    expect(agentError(() => prepare({ text: 'Rabat {Rabat}' })).code).toBe('field_unknown');
  });

  it('wartość po obcięciu spacji; pusta wartość pola użytego w treści oznacza emptyField', () => {
    const render = renderTemplate('Dla {Kontrahent}.', COLUMNS);
    expect(render([phone(1), '  Serwis Nowak  ', '', ''])).toEqual({ text: 'Dla Serwis Nowak.', emptyField: false });
    expect(render([phone(1), '   ', '1,00 zł', ''])).toEqual({ text: 'Dla .', emptyField: true });
  });
});

describe('prepareFileSms', () => {
  it('treść bez pól: ta sama treść do numerów z pliku', () => {
    upload([row(1), row(2), row(3)]);
    const { preview, meta } = prepare({ text: 'Serwis zaprasza na przeglad floty w czwartek.' });
    expect(preview.recipients).toBe(3);
    expect(preview.fields).toEqual([]);
    expect(new Set(meta.samples.map((s) => s.text))).toEqual(new Set(['Serwis zaprasza na przeglad floty w czwartek.']));
    expect(meta.samples.map((s) => s.to)).toEqual([phone(1), phone(2), phone(3)]);
  });

  it('prepare_file_sms 31 min po poprzednim podglądzie: nowy szkic bez ponownego przesłania pliku', () => {
    upload([row(1), row(2)]);
    const first = prepare();
    const later = new Date(NOW.getTime() + 31 * MIN);
    const second = prepare({}, later);
    expect(second.preview.draftId).not.toBe(first.preview.draftId);
    expect(second.preview.recipients).toBe(2);
    expect(agentError(() => sendFileDraft(deps, ctx(later), first.preview.draftId, later, first.confirm!)).code).toBe('draft_expired');
    expect(sendFileDraft(deps, ctx(later), second.preview.draftId, later, second.confirm!).recipients).toBe(2);
  });

  it('wartość z {Termin} w kolumnie Kontrahent wstawiona dosłownie, bez ponownego podstawienia', () => {
    upload([[phone(1), 'Firma {Termin} sp. z o.o.', '5,00 zł', '30.11.2026']]);
    const { meta } = prepare({ text: 'Dla {Kontrahent} do {Termin}.' });
    expect(meta.samples[0]!.text).toBe('Dla Firma {Termin} sp. z o.o. do 30.11.2026.');
  });

  it('wyłączenia z numerem wiersza w _meta: columns, invalid_phone, invalid_client_id, empty_field, too_many_parts przy reject', () => {
    const columns = [...COLUMNS, 'Klient'];
    const id = deps.files.create({ connectionId: seed.connectionId, name: NAME, columns, phoneColumn: 0, totalRows: 7, now: NOW });
    deps.files.append(id, 0, [
      { line: 2, cells: [...row(1), 'K-001'] },
      { line: 3, cells: [phone(2), 'Serwis Nowak', '5,00 zł'] },
      { line: 4, cells: ['brak numeru', 'Serwis Nowak', '5,00 zł', '30.11.2026', 'K-003'] },
      { line: 5, cells: [...row(4), 'K 004'] },
      { line: 6, cells: [phone(5), '', '5,00 zł', '30.11.2026', 'K-005'] },
      { line: 7, cells: [phone(6), 'a'.repeat(600), '5,00 zł', '30.11.2026', 'K-006'] },
      { line: 8, cells: [...row(7), ''] },
    ]);
    deps.files.complete(id);
    const { preview, meta } = prepare({ clientIdColumn: 'klient' });
    expect(preview.recipients).toBe(2);
    expect(preview.excluded).toEqual({ columns: 1, invalid_phone: 1, invalid_client_id: 1, empty_field: 1, too_many_parts: 1 });
    // Próba B (B7): wartość z kolumny numeru dla człowieka w podglądzie, null dla wiersza niezgodnego z nagłówkiem.
    expect(meta.excludedRows).toEqual([
      { line: 3, reason: 'columns', phone: null }, { line: 4, reason: 'invalid_phone', phone: 'brak numeru' },
      { line: 5, reason: 'invalid_client_id', phone: phone(4) }, { line: 6, reason: 'empty_field', phone: phone(5) },
      { line: 7, reason: 'too_many_parts', phone: phone(6) },
    ]);
    expect(meta.excludedMore).toBe(0);
    expect(fileSummary(deps, ctx(), NOW).invalidPhones).toBe(1);
    expect(agentError(() => prepare({ clientIdColumn: 'Identyfikator' })).code).toBe('field_unknown');
  });

  it('overflow truncate: wiersz skrócony i policzony w truncated, nie wyłączony', () => {
    setConfig({ overflow: 'truncate' });
    upload([row(1), [phone(2), 'a'.repeat(600), '5,00 zł', '30.11.2026']]);
    const { preview, meta } = prepare();
    expect(preview.recipients).toBe(2);
    expect(preview.truncated).toBe(1);
    expect(preview.excluded.too_many_parts).toBe(0);
    const long = meta.samples.find((s) => s.to === phone(2))!;
    expect(long.parts).toBe(3);
    expect(long.text.endsWith('…')).toBe(true);
  });

  it('powtórzenia: numer i treść identyczne raz; ten sam numer z inną treścią: oba SMS-y i numer w ostrzeżeniu', () => {
    upload([
      row(1, 'Serwis Nowak'), ['+48 601 000 001', 'Serwis Nowak', '1 234,50 zł', '30.11.2026'],
      row(2, 'Flota Zachód'), row(2, 'Flota Wschód'), row(3),
    ]);
    const { preview, meta } = prepare();
    expect(preview.recipients).toBe(4);
    expect(preview.duplicates).toBe(1);
    expect(preview.sameNumberDifferentText).toBe(1);
    expect(meta.repeatedNumbers).toEqual([phone(2)]);
  });

  it('ten sam numer z inną treścią: powtórzenie w osobnej rozsyłce, każda rozsyłka zawiera numer najwyżej raz', () => {
    upload([row(1, 'Serwis Nowak'), row(2, 'Flota Zachód'), row(1, 'Serwis Nowak FV 12'), row(1, 'Serwis Nowak FV 13'), row(3)]);
    const { preview, confirm } = prepare();
    expect(preview).toMatchObject({ recipients: 5, packages: 3 });
    const outcome = sendFileDraft(deps, ctx(), preview.draftId, NOW, confirm!);
    const packages = deps.packages.listByFileSend(outcome.id);
    expect(packages.map((p) => deps.packages.recipients(p.id).map((r) => r.fileLine))).toEqual([[2, 3, 6], [4], [5]]);
  });

  it('ten sam numer w dwóch wierszach: raport doręczeń przypisuje każdemu wierszowi własny SMS', () => {
    upload([['48601000011', 'Serwis Nowak', 'FV 11/2026', '30.11.2026'], ['48601000011', 'Serwis Nowak', 'FV 12/2026', '30.11.2026']]);
    const { preview, confirm } = prepare({ text: 'Przypominamy o fakturze {Kwota} dla {Kontrahent}.' });
    const outcome = sendFileDraft(deps, ctx(), preview.draftId, NOW, confirm!);
    let mi = 90000;
    for (const pkg of deps.packages.listByFileSend(outcome.id)) {
      deps.packages.setCreated(pkg.id, `mi-${pkg.id}`);
      deps.packages.setCompleted(pkg.id, NOW);
      deps.packages.applyReport(pkg.id, deps.packages.recipients(pkg.id).map((r) => {
        const delivered = r.fileLine === 3;
        return {
          miId: String(++mi), dest: r.dest, miStatus: delivered ? 21 : 11, status: delivered ? 'delivered' as const : 'failed' as const,
          rawStatus: delivered ? '21' : '11', changedAt: '2026-11-15 10:30:00', clientId: null,
        };
      }));
      deps.packages.setReport(pkg.id, { status: 'ready' });
    }
    const byLine = new Map(deps.packages.listByFileSend(outcome.id).flatMap((p) => deps.packages.recipients(p.id)).map((r) => [r.fileLine, r]));
    expect(byLine.get(2)!.status).toBe('failed');
    expect(byLine.get(3)!.status).toBe('delivered');
    expect(byLine.get(2)!.miId).not.toBe(byLine.get(3)!.miId);
    expect(fileSendStatus(deps, ctx(), outcome.id)).toMatchObject({ delivered: 1, failed: 1 });
  });

  it('6000 wierszy GSM i 1200 z ł: rozsyłki 5000 GSM, 1000 GSM, 1200 Unicode w kolejności pliku', () => {
    setup({ throttle: { recipients: 50_000 } });
    const rows = [
      ...Array.from({ length: 6000 }, (_, i) => row(i, `Kowalski ${i}`)),
      ...Array.from({ length: 1200 }, (_, i) => row(6000 + i, `Łódź ${i}`)),
    ];
    upload(rows);
    const { preview, confirm } = prepare({ text: GSM_TEXT });
    expect(preview.recipients).toBe(7200);
    expect(preview.encodings).toEqual({ gsm: 6000, ucs2: 1200 });
    expect(preview.packages).toBe(3);
    const outcome = sendFileDraft(deps, ctx(), preview.draftId, NOW, confirm!);
    const packages = deps.packages.listByFileSend(outcome.id);
    expect(packages.map((p) => p.id)).toEqual(outcome.packages);
    expect(packages.map((p) => [p.recipientsCount, p.encoding])).toEqual([[5000, 'gsm'], [1000, 'gsm'], [1200, 'ucs2']]);
    expect(packages.map((p) => deps.packages.recipients(p.id, 1)[0]!.fileLine)).toEqual([2, 5002, 6002]);
    expect(packages.every((p) => p.fileSendId === outcome.id)).toBe(true);
  });

  it('link w wartości skrócony według ustawień klucza; jedna kampania dla wszystkich rozsyłek', () => {
    shortener();
    const columns = ['Numer', 'Kontrahent', 'Faktura'];
    upload([
      [phone(1), 'Kowalski', 'https://serwis.pl/f/1'], [phone(2), 'Nowak', 'https://serwis.pl/f/2'], [phone(3), 'Łódź', 'https://serwis.pl/f/3'],
    ], { columns });
    const { preview, meta, confirm } = prepare({ text: 'Faktura dla {Kontrahent}: {Faktura}' });
    expect(meta.samples[0]!.text).toBe('Faktura dla Kowalski: https://l.serwis.pl/0000000');
    expect(preview.packages).toBe(2);
    const outcome = sendFileDraft(deps, ctx(), preview.draftId, NOW, confirm!);
    const packages = deps.packages.listByFileSend(outcome.id);
    expect(packages).toHaveLength(2);
    expect(count('campaigns')).toBe(1);
    expect(new Set(packages.map((p) => p.campaignId)).size).toBe(1);
    expect(packages[0]!.campaignId).not.toBeNull();
    expect(count('short_links')).toBe(3);
  });

  it('podgląd: 3 przykłady z początku, środka i końca w _meta; content i structuredContent bez wartości z pliku', () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(i + 1, `Hurtownia Kowalski ${i + 1}`));
    upload(rows);
    const { preview, meta } = prepare();
    expect(meta.samples.map((s) => s.line)).toEqual([2, 6, 10]);
    expect(meta.samples[0]).toEqual({
      line: 2, to: phone(1), parts: 2,
      text: 'Przypominamy o płatności faktury dla Hurtownia Kowalski 1 na kwotę 1 234,50 zł do 30.11.2026.',
    });
    expect(preview.fields).toEqual(['Kontrahent', 'Kwota', 'Termin']);
    expect(preview.partsHistogram).toEqual({ 2: 9 });
    expect(preview.parts).toBe(18);
    const json = JSON.stringify(preview);
    for (const value of [NAME, 'Hurtownia', '1 234,50', '30.11.2026', phone(1), 'Przypominamy']) expect(json).not.toContain(value);
  });

  it('limit odbiorców integracji 1000 przy 10 000 odbiorcach: blocked z tekstem ze spec 5.6, bez wpisu w dzienniku i bez powiadomienia', () => {
    upload(Array.from({ length: 10_000 }, (_, i) => row(i, `Kowalski ${i}`)));
    const { preview } = prepare({ text: GSM_TEXT });
    expect(preview.recipients).toBe(10_000);
    expect(preview.blocked).toBe(`Integracja Agent AI - dyspozytornia pozwala wysłać 1000 odbiorców w ciągu 60 minut. Plik zawiera ${formatCount(10_000)} odbiorców. `
      + 'Poproś administratora bramki o zmianę ochrony przed burzą w integracji.');
    expect(count('integration_events')).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('ochrona przed burzą z wyczerpanym limitem wysyłek: blocked z godziną końca okna', () => {
    setup({ throttle: { limit: 1 } });
    upload([row(1)]);
    const first = prepare();
    sendFileDraft(deps, ctx(), first.preview.draftId, NOW, first.confirm!);
    upload([row(2)]);
    const { preview } = prepare();
    expect(preview.blocked).toBe('Integracja Agent AI - dyspozytornia wykorzystała limit 1 wysyłki w ciągu 60 minut. Wysyłka z pliku będzie możliwa po 15.11.2026 11:00.');
    expect(preview.guard.calls).toBe(0);
  });
});

describe('sendFileDraft', () => {
  it('send_file_sms: jedno wywołanie burzy z liczbą SMS-ów, rozsyłki z file_send_id i file_line, szkic pliku usunięty', () => {
    upload([row(1), row(2), row(3)]);
    const { preview, confirm } = prepare();
    const outcome = sendFileDraft(deps, ctx(), preview.draftId, NOW, confirm!);
    expect(outcome).toMatchObject({ kind: 'file', recipients: 3, schedule: null, repeated: false });
    expect(outcome.packages).toHaveLength(1);
    expect(deps.guards.peek(seed.integrationId, 60, NOW)).toMatchObject({ count: 1, recipients: 3 });
    const pkg = deps.packages.get(outcome.packages[0]!)!;
    expect(pkg).toMatchObject({ fileSendId: outcome.id, integrationId: seed.integrationId, agentConnectionId: seed.connectionId, requestedBy: 'Ewa Nowak' });
    expect(deps.packages.recipients(pkg.id).map((r) => [r.fileLine, r.dest])).toEqual([[2, phone(1)], [3, phone(2)], [4, phone(3)]]);
    expect(deps.fileSends.get(outcome.id)).toMatchObject({ name: NAME, recipients: 3, connectionId: seed.connectionId, startAt: null });
    expect(deps.files.current(seed.connectionId, NOW)).toBeUndefined();
    const event = db.prepare("SELECT reason, package_id FROM integration_events WHERE result = 'sent'").get() as { reason: string; package_id: string };
    expect(event).toEqual({ reason: 'Rozsyłka z pliku, 3 odbiorców, 1 rozsyłka', package_id: pkg.id });
  });

  it('send_file_sms dwa razy: drugi wynik repeated bez nowych rozsyłek', () => {
    upload([row(1), row(2)]);
    const { preview, confirm } = prepare();
    const first = sendFileDraft(deps, ctx(), preview.draftId, NOW, confirm!);
    const second = sendFileDraft(deps, ctx(), preview.draftId, NOW, confirm!);
    expect(second).toEqual({ ...first, repeated: true });
    expect(count('packages')).toBe(1);
    expect(count('file_sends')).toBe(1);
  });

  it('send_file_sms z terminem: każda rozsyłka scheduled z tym samym terminem', () => {
    upload([row(1, 'Kowalski'), row(2, 'Łódź')]);
    const { preview, confirm } = prepare({ text: GSM_TEXT, startAt: '2026-11-20 08:00' });
    expect(preview.schedule?.startAt).toBe('2026-11-20T07:00:00.000Z');
    const outcome = sendFileDraft(deps, ctx(), preview.draftId, NOW, confirm!);
    expect(outcome.schedule?.startAt).toBe('2026-11-20T07:00:00.000Z');
    const packages = deps.packages.listByFileSend(outcome.id);
    expect(packages).toHaveLength(2);
    expect(packages.map((p) => [p.status, p.startAt])).toEqual([['scheduled', '2026-11-20T07:00:00.000Z'], ['scheduled', '2026-11-20T07:00:00.000Z']]);
    expect(deps.fileSends.get(outcome.id)!.startAt).toBe('2026-11-20T07:00:00.000Z');
  });

  it('send_file_sms po zmianie ustawień skracania od podglądu albo po zastąpieniu pliku: draft_stale', () => {
    shortener();
    const columns = ['Numer', 'Faktura'];
    upload([[phone(1), 'https://serwis.pl/f/1']], { columns });
    const linked = prepare({ text: 'Faktura: {Faktura}' });
    const settings = deps.apiKeys.linkSettings(seed.keyId);
    deps.apiKeys.setLinkSettings(seed.keyId, { ...settings, mode: 'off' });
    expect(agentError(() => sendFileDraft(deps, ctx(), linked.preview.draftId, NOW, linked.confirm!)).code).toBe('draft_stale');

    const replaced = prepare({ text: 'Faktura: {Faktura}' });
    upload([[phone(2), 'https://serwis.pl/f/2']], { columns });
    const e = agentError(() => sendFileDraft(deps, ctx(), replaced.preview.draftId, NOW, replaced.confirm!));
    expect(e.code).toBe('draft_stale');
    expect(e.message).toContain('Przygotuj');
    expect(count('packages')).toBe(0);
    expect(deps.guards.peek(seed.integrationId, 60, NOW).count).toBe(0);
  });

  it('send_file_sms bez klucza potwierdzenia: confirm_required', () => {
    upload([row(1)]);
    const { preview } = prepare();
    expect(agentError(() => sendFileDraft(deps, ctx(), preview.draftId, NOW)).code).toBe('confirm_required');
    expect(agentError(() => sendFileDraft(deps, ctx(), preview.draftId, NOW, 'mig_cf_obcy')).code).toBe('confirm_required');
    expect(count('packages')).toBe(0);
  });
});
