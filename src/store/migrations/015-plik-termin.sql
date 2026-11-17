PRAGMA foreign_keys = ON;

-- 1.13: rozsyłka z terminem przechowywana przez bramkę do chwili przekazania do Multiinfo.
-- Kolumna packages.status jest typu TEXT bez CHECK (002-etap-2.sql), dlatego nowe stany scheduled
-- (Zaplanowana) i overdue (Termin minął) nie wymagają przebudowy tabeli.

-- Przegląd spóźnionych rozsyłek co minutę i liczniki stanów w panelu. Indeks obejmuje wszystkie stany,
-- ponieważ SQLite nie użyje indeksu częściowego WHERE status IN (...) dla warunku status = 'scheduled'.
CREATE INDEX packages_pending ON packages(status, start_at);

-- Nadpis nadawcy podany jawnie przez klienta (1) albo domyślny klucza lub konta (0). Bramka sprawdza
-- w chwili przekazania wyłącznie nadpis jawny, tak jak przy przyjęciu rozsyłki.
ALTER TABLE packages ADD COLUMN orig_explicit INTEGER NOT NULL DEFAULT 0;

-- Szkic pliku agenta: wiersze przekazane przez widok, jeden szkic na połączenie, ważny 24 godziny.
-- Wartości z pliku trafiają wyłącznie do tej tabeli i do widoku, nigdy do agenta.
CREATE TABLE agent_files (
  id              TEXT    PRIMARY KEY,
  connection_id   INTEGER NOT NULL UNIQUE REFERENCES agent_connections(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  columns         TEXT    NOT NULL,
  phone_column    INTEGER NOT NULL,
  total_rows      INTEGER NOT NULL,
  received_rows   INTEGER NOT NULL DEFAULT 0,
  complete        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  expires_at      TEXT    NOT NULL
);

-- Wiersz pliku w kolejności przesłania. Wiersz z inną liczbą komórek niż kolumn zostaje bez komórek
-- z powodem 'columns' i trafia do listy wierszy wyłączonych.
CREATE TABLE agent_file_rows (
  file_id  TEXT    NOT NULL REFERENCES agent_files(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  line     INTEGER NOT NULL,
  cells    TEXT,
  problem  TEXT    CHECK (problem IN ('columns')),
  PRIMARY KEY (file_id, seq)
) WITHOUT ROWID;

-- Wysyłka z pliku: jedna albo kilka rozsyłek po 5000 odbiorców.
CREATE TABLE file_sends (
  id              TEXT    PRIMARY KEY,
  api_key_id      INTEGER NOT NULL REFERENCES api_keys(id),
  integration_id  INTEGER REFERENCES integrations(id) ON DELETE SET NULL,
  connection_id   INTEGER REFERENCES agent_connections(id) ON DELETE SET NULL,
  requested_by    TEXT,
  name            TEXT    NOT NULL,
  recipients      INTEGER NOT NULL,
  start_at        TEXT,
  created_at      TEXT    NOT NULL
);

ALTER TABLE packages ADD COLUMN file_send_id TEXT REFERENCES file_sends(id) ON DELETE SET NULL;
CREATE INDEX packages_file_send ON packages(file_send_id) WHERE file_send_id IS NOT NULL;

-- Numer wiersza w pliku dla raportu wysyłki z pliku.
ALTER TABLE package_recipients ADD COLUMN file_line INTEGER;

-- Szkic wysyłki z pliku: ograniczenie CHECK listy rodzajów wymaga przebudowy tabeli. Nic nie odwołuje się
-- do agent_drafts, dlatego usunięcie starej tabeli nie narusza kluczy obcych.
CREATE TABLE agent_drafts_015 (
  id             TEXT    PRIMARY KEY,
  connection_id  INTEGER NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('sms', 'group', 'reply', 'file')),
  payload        TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  expires_at     TEXT    NOT NULL,
  sent_at        TEXT,
  result         TEXT,
  -- Skrót jednorazowego klucza potwierdzenia: szkic z sesji z widokami wysyła wyłącznie przycisk w widoku.
  confirm_hash   TEXT
);
INSERT INTO agent_drafts_015 (id, connection_id, kind, payload, created_at, expires_at, sent_at, result, confirm_hash)
  SELECT id, connection_id, kind, payload, created_at, expires_at, sent_at, result, confirm_hash FROM agent_drafts;
DROP TABLE agent_drafts;
ALTER TABLE agent_drafts_015 RENAME TO agent_drafts;
CREATE INDEX idx_agent_drafts_expires ON agent_drafts(expires_at);
