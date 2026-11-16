import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentError } from '../../src/agents/errors.ts';
import { PA_RECIPIENT_LIMIT_MAX } from '../../src/integrations/config.ts';
import {
  AgentFilesRepo, CELL_CHARS_MAX, COLUMN_NAME_MAX, COLUMNS_MAX, FILE_NAME_MAX, FILE_ROWS_MAX, FILE_TTL_MS, UPLOAD_ROWS_MAX,
} from '../../src/store/agent-files.ts';
import { AgentConnectionsRepo } from '../../src/store/agent-connections.ts';
import { openDatabase } from '../../src/store/db.ts';
import { FileSendsRepo } from '../../src/store/file-sends.ts';
import { seedAgentIntegration } from './helpers.ts';

const NOW = new Date('2026-11-16T09:00:00Z');
const COLUMNS = ['Numer', 'Kontrahent', 'Kwota', 'Termin'];
let db: Database;
let files: AgentFilesRepo;
let ewa: number;
let marek: number;
let apiKeyId: number;
let integrationId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  ({ apiKeyId, integrationId } = seedAgentIntegration(db, randomBytes(32)));
  const connections = new AgentConnectionsRepo(db);
  ewa = connections.insert({ integrationId, name: 'Ewa Nowak', method: 'oauth', expiresAt: null, createdBy: 'admin', createdAt: NOW });
  marek = connections.insert({ integrationId, name: 'Marek Kowalski', method: 'oauth', expiresAt: null, createdBy: 'admin', createdAt: NOW });
  files = new AgentFilesRepo(db);
});

const row = (line: number, cells = ['48601000011', `Hurtownia ${line}`, '1 234,50 zł', '30.11.2026']) => ({ line, cells });
const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => row(from + i));
const create = (over: Partial<Parameters<AgentFilesRepo['create']>[0]> = {}) =>
  files.create({ connectionId: ewa, name: 'przypomnienia-listopad.xlsx', columns: COLUMNS, phoneColumn: 0, totalRows: 3, now: NOW, ...over });
const fileRows = () => (db.prepare('SELECT COUNT(*) AS n FROM agent_file_rows').get() as { n: number }).n;

/** Błąd limitu z kodem i komunikatem, który wymienia limit. */
function limitError(fn: () => unknown, fragment: string): void {
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AgentError);
  expect((caught as AgentError).code).toBe('file_limit');
  expect((caught as AgentError).message).toContain(fragment);
}

describe('AgentFilesRepo', () => {
  it('create zwraca fil_, get i current zwracają szkic połączenia ważny 24 godziny, innego połączenia nie', () => {
    const id = create();
    expect(id).toMatch(/^fil_[0-9a-f]{20}$/);
    const expected = {
      id, connectionId: ewa, name: 'przypomnienia-listopad.xlsx', columns: COLUMNS, phoneColumn: 0, totalRows: 3, receivedRows: 0, complete: false,
      createdAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + FILE_TTL_MS).toISOString(),
    };
    expect(files.get(id, ewa)).toEqual(expected);
    expect(files.get(id, marek)).toBeUndefined();
    expect(files.current(ewa, NOW)).toEqual(expected);
    expect(files.current(marek, NOW)).toBeUndefined();
    expect(files.current(ewa, new Date(NOW.getTime() + FILE_TTL_MS + 1))).toBeUndefined();
    expect(FILE_TTL_MS).toBe(24 * 3_600_000);
  });

  it('create zastępuje poprzedni szkic pliku połączenia razem z wierszami', () => {
    const first = create();
    files.append(first, 0, rows(2, 3));
    const other = files.create({ connectionId: marek, name: 'flota.csv', columns: ['Telefon'], phoneColumn: 0, totalRows: 1, now: NOW });
    files.append(other, 0, [{ line: 2, cells: ['48601000021'] }]);
    expect(fileRows()).toBe(4);

    const second = create({ name: 'przypomnienia-grudzien.xlsx', totalRows: 2 });
    expect(second).not.toBe(first);
    expect(files.get(first, ewa)).toBeUndefined();
    expect(files.current(ewa, NOW)!.id).toBe(second);
    expect(fileRows()).toBe(1);
    expect(files.get(other, marek)!.receivedRows).toBe(1);
  });

  it('append: offset równy przyjętym dopisuje, mniejszy zwraca stan bez zmian, większy daje upload_gap', () => {
    const id = create({ totalRows: 5 });
    expect(files.append(id, 0, rows(2, 2))).toEqual({ received: 2 });
    // Ponowienie tej samej porcji przez aplikację: bramka niczego nie dopisuje.
    expect(files.append(id, 0, rows(2, 2))).toEqual({ received: 2 });
    expect(() => files.append(id, 3, rows(5, 1))).toThrow(expect.objectContaining({ code: 'upload_gap' }));
    expect(files.append(id, 2, rows(4, 3))).toEqual({ received: 5 });
    expect(files.rows(id).map((r) => [r.seq, r.line])).toEqual([[0, 2], [1, 3], [2, 4], [3, 5], [4, 6]]);
    expect(files.rows(id)[0]).toEqual({ seq: 0, line: 2, cells: ['48601000011', 'Hurtownia 2', '1 234,50 zł', '30.11.2026'], problem: null });
    // Wiersze ponad liczbę zapowiedzianą w pierwszej porcji.
    expect(() => files.append(id, 5, rows(7, 1))).toThrow(expect.objectContaining({ code: 'upload_overflow' }));
  });

  it('complete wymaga kompletu wierszy', () => {
    const id = create();
    files.append(id, 0, rows(2, 2));
    expect(() => files.complete(id)).toThrow(expect.objectContaining({ code: 'upload_incomplete' }));
    expect(files.get(id, ewa)!.complete).toBe(false);
    files.append(id, 2, rows(4, 1));
    files.complete(id);
    expect(files.get(id, ewa)!.complete).toBe(true);
  });

  it('wiersz z inną liczbą komórek zapisany z problem columns', () => {
    const id = create();
    files.append(id, 0, [row(2), { line: 3, cells: ['48601000012', 'Serwis Południe'] }, { line: 4, cells: [...row(4).cells, 'uwagi'] }]);
    expect(files.rows(id)).toEqual([
      { seq: 0, line: 2, cells: row(2).cells, problem: null },
      { seq: 1, line: 3, cells: null, problem: 'columns' },
      { seq: 2, line: 4, cells: null, problem: 'columns' },
    ]);
  });

  it('limity: 50 001 wierszy, 5001 w porcji, komórka 1001 znaków, 51 kolumn: file_limit z wyjaśnieniem', () => {
    expect([FILE_ROWS_MAX, UPLOAD_ROWS_MAX, CELL_CHARS_MAX, COLUMNS_MAX, COLUMN_NAME_MAX, FILE_NAME_MAX]).toEqual([PA_RECIPIENT_LIMIT_MAX, 5000, 1000, 50, 100, 200]);
    limitError(() => create({ totalRows: 50_001 }), 'najwyżej 50\u00a0000 wierszy');
    limitError(() => create({ totalRows: 0 }), 'wiersza danych');
    limitError(() => create({ columns: Array.from({ length: 51 }, (_, i) => `Kolumna ${i + 1}`) }), '50 kolumn');
    limitError(() => create({ columns: ['Numer', 'K'.repeat(101)] }), '100 znaków');
    limitError(() => create({ name: `${'p'.repeat(197)}.csv` }), '200 znaków');
    limitError(() => create({ phoneColumn: 4 }), 'kolumna numeru');
    expect(() => create({ totalRows: 50_000, columns: Array.from({ length: 50 }, (_, i) => `Kolumna ${i + 1}`) })).not.toThrow();

    const id = create({ totalRows: 50_000 });
    limitError(() => files.append(id, 0, rows(2, 5001)), '5000 wierszy');
    limitError(() => files.append(id, 0, [row(2, ['48601000011', 'x'.repeat(1001), '', ''])]), '1000 znaków');
    expect(files.get(id, ewa)!.receivedRows).toBe(0);
    expect(files.append(id, 0, [row(2, ['48601000011', 'x'.repeat(1000), '', ''])])).toEqual({ received: 1 });
  });

  it('pruneBefore usuwa szkic pliku po 24 h razem z wierszami', () => {
    const old = create();
    files.append(old, 0, rows(2, 3));
    const fresh = files.create({ connectionId: marek, name: 'flota.csv', columns: ['Telefon'], phoneColumn: 0, totalRows: 1, now: new Date(NOW.getTime() + 3_600_000) });
    files.append(fresh, 0, [{ line: 2, cells: ['48601000021'] }]);
    expect(files.pruneBefore(new Date(NOW.getTime() + FILE_TTL_MS))).toBe(0);
    expect(files.pruneBefore(new Date(NOW.getTime() + FILE_TTL_MS + 1))).toBe(1);
    expect(files.get(old, ewa)).toBeUndefined();
    expect(files.get(fresh, marek)).toBeDefined();
    expect(fileRows()).toBe(1);
  });

  it('remove usuwa szkic z wierszami, a usunięcie połączenia usuwa jego szkic', () => {
    const id = create();
    files.append(id, 0, rows(2, 3));
    files.remove(id);
    expect(files.get(id, ewa)).toBeUndefined();
    expect(fileRows()).toBe(0);
    const again = create();
    files.append(again, 0, rows(2, 1));
    db.prepare('DELETE FROM agent_connections WHERE id = ?').run(ewa);
    expect(fileRows()).toBe(0);
  });
});

describe('FileSendsRepo', () => {
  it('insert zwraca fsd_, a get zwraca wysyłkę z pliku', () => {
    const sends = new FileSendsRepo(db);
    const input = {
      apiKeyId, integrationId, connectionId: ewa, requestedBy: 'Ewa Nowak', name: 'przypomnienia-listopad.xlsx', recipients: 3,
      startAt: '2026-11-20T07:00:00.000Z', createdAt: NOW.toISOString(),
    };
    const id = sends.insert(input);
    expect(id).toMatch(/^fsd_[0-9a-f]{20}$/);
    expect(sends.get(id)).toEqual({ id, ...input });
    expect(sends.insert({ ...input, id: 'fsd_staly', startAt: null })).toBe('fsd_staly');
    expect(sends.get('fsd_staly')!.startAt).toBeNull();
    expect(sends.get('fsd_brak')).toBeUndefined();
  });
});
