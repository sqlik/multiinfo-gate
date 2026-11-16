import type { Database } from 'better-sqlite3';
import { AgentError } from '../agents/errors.ts';
import { shortId } from '../ids.ts';
import { PA_RECIPIENT_LIMIT_MAX } from '../integrations/config.ts';
import { formatCount } from '../text/numbers.ts';
import { plural } from '../text/plural.ts';

/** Najwięcej wierszy danych w pliku, tyle co odbiorców wysyłki z Power Automate. */
export const FILE_ROWS_MAX = PA_RECIPIENT_LIMIT_MAX;
/** Najwięcej wierszy w jednej porcji przesłania. */
export const UPLOAD_ROWS_MAX = 5000;
/** Najdłuższa wartość komórki w znakach. */
export const CELL_CHARS_MAX = 1000;
export const COLUMNS_MAX = 50;
export const COLUMN_NAME_MAX = 100;
export const FILE_NAME_MAX = 200;
/** Największy plik, który czyta widok. */
export const FILE_MEGABYTES_MAX = 20;
/** Ważność szkicu pliku. */
export const FILE_TTL_MS = 24 * 3_600_000;

/** Szkic pliku połączenia: nagłówek pliku i stan przesłania wierszy. */
export interface AgentFileRow {
  id: string;
  connectionId: number;
  name: string;
  columns: string[];
  phoneColumn: number;
  totalRows: number;
  receivedRows: number;
  complete: boolean;
  createdAt: string;
  expiresAt: string;
}

/** Wiersz z widoku: numer wiersza w pliku i wartości sformatowane przez widok. */
export interface FileRowInput { line: number; cells: string[] }

/** Wiersz zapisany: wiersz z inną liczbą komórek niż kolumn nie ma komórek, ma za to powód wyłączenia. */
export interface StoredFileRow { seq: number; line: number; cells: string[] | null; problem: 'columns' | null }

interface RawFile {
  id: string; connection_id: number; name: string; columns: string; phone_column: number; total_rows: number; received_rows: number;
  complete: number; created_at: string; expires_at: string;
}

const limit = (message: string): AgentError => new AgentError('file_limit', message);
const chars = (n: number): string => plural(n, 'znak', 'znaki', 'znaków');
const lines = (n: number): string => plural(n, 'wiersz', 'wiersze', 'wierszy').replace(/^\d+/, formatCount(n));

function fileOf(row: RawFile): AgentFileRow {
  return {
    id: row.id, connectionId: row.connection_id, name: row.name, columns: JSON.parse(row.columns) as string[], phoneColumn: row.phone_column,
    totalRows: row.total_rows, receivedRows: row.received_rows, complete: row.complete === 1, createdAt: row.created_at, expiresAt: row.expires_at,
  };
}

/** Nagłówek pliku w granicach limitów; przekroczenie daje `file_limit` z nazwą limitu i jego wartością. */
function checkHeader(input: { name: string; columns: string[]; phoneColumn: number; totalRows: number }): void {
  if (input.name.length > FILE_NAME_MAX) throw limit(`Nazwa pliku ma ${chars(input.name.length)}, a bramka przyjmuje nazwę do ${FILE_NAME_MAX} znaków.`);
  if (input.columns.length === 0) throw limit('Plik nie zawiera żadnej kolumny.');
  if (input.columns.length > COLUMNS_MAX) throw limit(`Plik zawiera ${plural(input.columns.length, 'kolumnę', 'kolumny', 'kolumn')}, a bramka przyjmuje najwyżej ${COLUMNS_MAX} kolumn.`);
  const long = input.columns.findIndex((c) => c.length > COLUMN_NAME_MAX);
  if (long >= 0) throw limit(`Nazwa kolumny ${long + 1} ma ${chars(input.columns[long]!.length)}, a bramka przyjmuje nazwę kolumny do ${COLUMN_NAME_MAX} znaków.`);
  if (!Number.isInteger(input.phoneColumn) || input.phoneColumn < 0 || input.phoneColumn >= input.columns.length) {
    throw limit(`Wskazana kolumna numeru nie istnieje, ponieważ plik zawiera ${plural(input.columns.length, 'kolumnę', 'kolumny', 'kolumn')}.`);
  }
  if (input.totalRows < 1) throw limit('Plik nie zawiera żadnego wiersza danych.');
  if (input.totalRows > FILE_ROWS_MAX) {
    throw limit(`Plik zawiera ${lines(input.totalRows)} danych, a bramka przyjmuje najwyżej ${formatCount(FILE_ROWS_MAX)} wierszy.`);
  }
}

/** Porcja w granicach limitów: liczba wierszy i długość każdej wartości. */
function checkRows(rows: FileRowInput[]): void {
  if (rows.length > UPLOAD_ROWS_MAX) throw limit(`Porcja zawiera ${lines(rows.length)}, a bramka przyjmuje najwyżej ${UPLOAD_ROWS_MAX} wierszy w jednej porcji.`);
  for (const row of rows) {
    const long = row.cells.find((c) => c.length > CELL_CHARS_MAX);
    if (long !== undefined) {
      throw limit(`Wiersz ${row.line} pliku zawiera wartość o długości ${chars(long.length)}, a bramka przyjmuje wartość do ${CELL_CHARS_MAX} znaków.`);
    }
  }
}

/**
 * Szkice plików agentów. Połączenie ma najwyżej jeden szkic: nowy plik zastępuje poprzedni razem z wierszami.
 * Wartości z pliku zapisuje wyłącznie ta tabela, a narzędzia agenta podają z niej tylko nazwy kolumn i liczby.
 */
export class AgentFilesRepo {
  constructor(private readonly db: Database) {}

  /** Nowy szkic pliku połączenia; zwraca identyfikator `fil_…`. */
  create(input: { connectionId: number; name: string; columns: string[]; phoneColumn: number; totalRows: number; now: Date }): string {
    checkHeader(input);
    const id = shortId('fil');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM agent_files WHERE connection_id = ?').run(input.connectionId);
      this.db.prepare(`INSERT INTO agent_files (id, connection_id, name, columns, phone_column, total_rows, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.connectionId, input.name, JSON.stringify(input.columns), input.phoneColumn, input.totalRows,
        input.now.toISOString(), new Date(input.now.getTime() + FILE_TTL_MS).toISOString());
    })();
    return id;
  }

  /** Szkic innego połączenia daje undefined. Szkic po terminie wraca, żeby narzędzie podało czytelny powód odmowy. */
  get(id: string, connectionId: number): AgentFileRow | undefined {
    const row = this.db.prepare('SELECT * FROM agent_files WHERE id = ? AND connection_id = ?').get(id, connectionId) as RawFile | undefined;
    return row ? fileOf(row) : undefined;
  }

  /** Ważny szkic pliku połączenia. */
  current(connectionId: number, now: Date): AgentFileRow | undefined {
    const row = this.db.prepare('SELECT * FROM agent_files WHERE connection_id = ? AND expires_at >= ?').get(connectionId, now.toISOString()) as RawFile | undefined;
    return row ? fileOf(row) : undefined;
  }

  /**
   * Porcja wierszy od miejsca `offset`. Offset równy liczbie przyjętych wierszy dopisuje porcję, a mniejszy
   * oznacza ponowienie porcji przez aplikację i niczego nie zmienia. Większy daje `upload_gap`.
   */
  append(id: string, offset: number, rows: FileRowInput[]): { received: number } {
    checkRows(rows);
    return this.db.transaction(() => {
      const file = this.db.prepare('SELECT columns, total_rows, received_rows FROM agent_files WHERE id = ?').get(id) as
        Pick<RawFile, 'columns' | 'total_rows' | 'received_rows'> | undefined;
      if (!file) throw new AgentError('file_unknown', 'Szkic pliku nie istnieje. Wybierz plik w widoku bramki ponownie.');
      if (offset < file.received_rows) return { received: file.received_rows };
      if (offset > file.received_rows) {
        throw new AgentError('upload_gap', `Bramka przyjęła ${lines(file.received_rows)} pliku, dlatego następna porcja musi zaczynać się od tego miejsca.`);
      }
      if (offset + rows.length > file.total_rows) {
        throw new AgentError('upload_overflow', `Porcja przekracza liczbę wierszy zapowiedzianą w pierwszej porcji pliku, czyli ${formatCount(file.total_rows)}.`);
      }
      const width = (JSON.parse(file.columns) as string[]).length;
      const insert = this.db.prepare('INSERT INTO agent_file_rows (file_id, seq, line, cells, problem) VALUES (?, ?, ?, ?, ?)');
      rows.forEach((row, i) => {
        const fits = row.cells.length === width;
        insert.run(id, offset + i, row.line, fits ? JSON.stringify(row.cells) : null, fits ? null : 'columns');
      });
      const received = offset + rows.length;
      this.db.prepare('UPDATE agent_files SET received_rows = ? WHERE id = ?').run(received, id);
      return { received };
    })();
  }

  /** Oznacza plik jako gotowy; plik bez kompletu wierszy daje `upload_incomplete`. */
  complete(id: string): void {
    const done = this.db.prepare('UPDATE agent_files SET complete = 1 WHERE id = ? AND received_rows = total_rows').run(id).changes;
    if (done === 0) throw new AgentError('upload_incomplete', 'Bramka nie przyjęła jeszcze wszystkich wierszy pliku, dlatego plik nie jest gotowy.');
  }

  rows(id: string): StoredFileRow[] {
    const rows = this.db.prepare('SELECT seq, line, cells, problem FROM agent_file_rows WHERE file_id = ? ORDER BY seq').all(id) as
      Array<{ seq: number; line: number; cells: string | null; problem: 'columns' | null }>;
    return rows.map((r) => ({ seq: r.seq, line: r.line, cells: r.cells === null ? null : JSON.parse(r.cells) as string[], problem: r.problem }));
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM agent_files WHERE id = ?').run(id);
  }

  /** Usuwa szkice, których termin minął przed `now`, razem z wierszami. */
  pruneBefore(now: Date): number {
    return this.db.prepare('DELETE FROM agent_files WHERE expires_at < ?').run(now.toISOString()).changes;
  }
}
