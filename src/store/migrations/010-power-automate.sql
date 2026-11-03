PRAGMA foreign_keys = ON;

-- Zlecający wysyłkę z przepływu Power Automate (na przykład adres e-mail autora wpisu); pusty dla pozostałych źródeł.
-- Dziennik integracji ma stały rozmiar, więc zlecający przy wiadomości i rozsyłce jest jedynym trwałym śladem.
ALTER TABLE messages ADD COLUMN requested_by TEXT;

-- Rozsyłka zlecona przez integrację Power Automate; usunięcie integracji zostawia rozsyłkę bez powiązania.
ALTER TABLE packages ADD COLUMN integration_id INTEGER REFERENCES integrations(id) ON DELETE SET NULL;
ALTER TABLE packages ADD COLUMN requested_by TEXT;

-- Klucz idempotencji rozsyłki: ponowienie po zerwanym połączeniu zwraca pierwotną rozsyłkę zamiast
-- tworzyć drugą. Skrót żądania odróżnia powtórzenie od innej rozsyłki z tym samym kluczem.
ALTER TABLE packages ADD COLUMN idempotency_key TEXT;
ALTER TABLE packages ADD COLUMN request_hash TEXT;
CREATE UNIQUE INDEX packages_idempotency ON packages(api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Wpis dziennika integracji wskazuje rozsyłkę, tak jak dziś wskazuje wiadomość.
ALTER TABLE integration_events ADD COLUMN package_id TEXT;

-- Klucz wyłącznie dla integracji: odrzuca POST /v1/messages i POST /v1/packages, więc klucz
-- wklejony w Power Automate nie pozwala wysyłać z pominięciem mechanizmów ochronnych integracji.
ALTER TABLE api_keys ADD COLUMN integrations_only INTEGER NOT NULL DEFAULT 0;

-- Ochrona przed burzą integracji Power Automate liczy w oknie także odbiorców: jedna rozsyłka
-- może objąć 5000 numerów, więc sam limit wywołań nie chroni konta przed zapętlonym przepływem.
ALTER TABLE integration_throttle ADD COLUMN recipients INTEGER NOT NULL DEFAULT 0;
