PRAGMA foreign_keys = ON;

-- Ustawienia instancji, po jednym wierszu na klucz. Pierwszy: adres bramki widziany przez aplikacje
-- (api_url) - panel dokleja do niego adresy wejściowe integracji i przykłady wywołań API.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
