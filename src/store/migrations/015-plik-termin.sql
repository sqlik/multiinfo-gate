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
