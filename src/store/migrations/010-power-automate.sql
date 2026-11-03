PRAGMA foreign_keys = ON;

-- Zlecający wysyłkę z przepływu Power Automate (na przykład adres e-mail autora wpisu); pusty dla pozostałych źródeł.
-- Dziennik integracji ma stały rozmiar, więc zlecający przy wiadomości i rozsyłce jest jedynym trwałym śladem.
ALTER TABLE messages ADD COLUMN requested_by TEXT;

-- Rozsyłka zlecona przez integrację Power Automate; usunięcie integracji zostawia rozsyłkę bez powiązania.
ALTER TABLE packages ADD COLUMN integration_id INTEGER REFERENCES integrations(id) ON DELETE SET NULL;
ALTER TABLE packages ADD COLUMN requested_by TEXT;

-- Wpis dziennika integracji wskazuje rozsyłkę, tak jak dziś wskazuje wiadomość.
ALTER TABLE integration_events ADD COLUMN package_id TEXT;
