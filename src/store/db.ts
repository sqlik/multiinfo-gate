import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type { Database } from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Kolejne migracje w kolejności stosowania. Indeks + 1 to docelowy `user_version`. */
const MIGRATIONS = ['001-initial.sql', '002-etap-2.sql', '003-etap-3.sql', '004-etap-3b.sql', '005-odbior.sql', '006-integracje.sql', '007-adres-bramki.sql'];

export interface OpenOptions {
  /** Katalog z plikami migracji; domyślnie ten obok modułu. Do testów. */
  migrationsDir?: string;
  /** Lista migracji do zastosowania; domyślnie wbudowana. Do testów. */
  migrations?: string[];
}

/**
 * Otwiera bazę, włącza tryb WAL i klucze obce, po czym stosuje brakujące migracje.
 * Wywołanie na istniejącej bazie jest bezpieczne - pomija już zastosowane kroki.
 */
export function openDatabase(path: string, options: OpenOptions = {}): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const dir = options.migrationsDir ?? join(HERE, 'migrations');
  const migrations = options.migrations ?? MIGRATIONS;
  const current = db.pragma('user_version', { simple: true }) as number;
  // Każda migracja razem z podbiciem wersji w jednej transakcji: przerwana w połowie
  // nie zostawia części tabel, po których kolejny start wywróciłby się na CREATE TABLE.
  // PRAGMA foreign_keys w plikach jest w transakcji bez skutku - włączamy je wyżej.
  const apply = db.transaction((sql: string, version: number) => {
    db.exec(sql);
    db.pragma(`user_version = ${version}`);
  });
  for (let i = current; i < migrations.length; i += 1) {
    apply(readFileSync(join(dir, migrations[i]!), 'utf8'), i + 1);
  }
  return db;
}
