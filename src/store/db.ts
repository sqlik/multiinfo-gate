import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type { Database } from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Kolejne migracje w kolejności stosowania. Indeks + 1 to docelowy `user_version`. */
const MIGRATIONS = ['001-initial.sql', '002-etap-2.sql', '003-etap-3.sql', '004-etap-3b.sql', '005-odbior.sql', '006-integracje.sql', '007-adres-bramki.sql', '008-poczta.sql', '009-nadawca-maila.sql'];

export interface OpenOptions {
  /** Katalog z plikami migracji; domyślnie ten obok modułu. Do testów. */
  migrationsDir?: string;
  /** Lista migracji do zastosowania; domyślnie wbudowana. Do testów. */
  migrations?: string[];
}

/** Baza ma schemat nowszy, niż zna to wydanie - typowo po cofnięciu wersji bez przywrócenia kopii. */
export class NewerDatabaseError extends Error {
  constructor(readonly current: number, readonly target: number) {
    super(`Baza ma wersję schematu ${current}, a to wydanie zna wersje do ${target}`);
    this.name = 'NewerDatabaseError';
  }
}

/** Migracja nie powiodła się; schemat został w poprzedniej wersji dzięki transakcji. */
export class MigrationError extends Error {
  constructor(readonly file: string, cause: unknown) {
    super(`Migracja ${file} nie powiodła się: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'MigrationError';
  }
}

/** Otwiera bazę z trybem WAL i kluczami obcymi, bez migracji. */
export function openDatabaseRaw(path: string): Database.Database {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Wersja schematu zapisana w bazie i wersja, do której prowadzą znane migracje. */
export function migrationState(db: Database.Database, migrations: string[] = MIGRATIONS): { current: number; target: number } {
  return { current: db.pragma('user_version', { simple: true }) as number, target: migrations.length };
}

/**
 * Stosuje brakujące migracje. Wywołanie na aktualnej bazie niczego nie zmienia.
 * Każda migracja razem z podbiciem wersji w jednej transakcji: przerwana w połowie
 * nie zostawia części tabel, po których kolejny start wywróciłby się na CREATE TABLE.
 * PRAGMA foreign_keys w plikach jest w transakcji bez skutku - włącza je openDatabaseRaw.
 */
export function applyMigrations(db: Database.Database, options: OpenOptions = {}): void {
  const dir = options.migrationsDir ?? join(HERE, 'migrations');
  const migrations = options.migrations ?? MIGRATIONS;
  const { current } = migrationState(db, migrations);
  const apply = db.transaction((sql: string, version: number) => {
    db.exec(sql);
    db.pragma(`user_version = ${version}`);
  });
  for (let i = current; i < migrations.length; i += 1) {
    const file = migrations[i]!;
    try {
      apply(readFileSync(join(dir, file), 'utf8'), i + 1);
    } catch (error) {
      throw new MigrationError(file, error);
    }
  }
}

/**
 * Otwiera bazę i stosuje brakujące migracje. Baza z nowszego wydania kończy się
 * błędem NewerDatabaseError bez żadnej zmiany w pliku.
 */
export function openDatabase(path: string, options: OpenOptions = {}): Database.Database {
  const db = openDatabaseRaw(path);
  try {
    const { current, target } = migrationState(db, options.migrations ?? MIGRATIONS);
    if (current > target) throw new NewerDatabaseError(current, target);
    applyMigrations(db, options);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
