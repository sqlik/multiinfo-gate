PRAGMA foreign_keys = ON;

-- 1.12: integracja „Agent AI”. Pracownik łączy aplikację AI z bramką jednorazowym kodem z panelu (OAuth)
-- albo tokenem połączenia. Kolumna integrations.kind nie ma CHECK, więc nowy rodzaj nie wymaga przebudowy tabeli.

-- Aplikacje zarejestrowane dynamicznie (RFC 7591) albo opisane dokumentem metadanych klienta.
CREATE TABLE oauth_clients (
  -- Losowy identyfikator rejestracji albo adres HTTPS dokumentu metadanych.
  client_id      TEXT    PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('dynamic', 'metadata')),
  name           TEXT    NOT NULL,
  -- Tablica JSON adresów powrotu.
  redirect_uris  TEXT    NOT NULL,
  source_ip      TEXT,
  created_at     TEXT    NOT NULL,
  -- Ostatnie pobranie dokumentu metadanych; NULL dla rejestracji dynamicznej.
  fetched_at     TEXT,
  -- Pierwsze dokończone połączenie; klient dynamiczny bez połączenia znika po dobie.
  connected_at   TEXT
);

-- Połączenie osoby z integracją. Bramka przechowuje wyłącznie skróty SHA-256 kodu i tokenu.
CREATE TABLE agent_connections (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id   INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  method           TEXT    NOT NULL CHECK (method IN ('oauth', 'token')),
  code_hash        TEXT,
  code_expires_at  TEXT,
  code_used_at     TEXT,
  token_hash       TEXT,
  client_id        TEXT    REFERENCES oauth_clients(client_id) ON DELETE SET NULL,
  client_name      TEXT,
  -- NULL: bez terminu, ale nigdy dłużej niż klucz API integracji.
  expires_at       TEXT,
  created_at       TEXT    NOT NULL,
  created_by       TEXT    NOT NULL,
  last_used_at     TEXT,
  revoked_at       TEXT,
  revoked_reason   TEXT    CHECK (revoked_reason IN ('admin', 'reuse'))
);
-- Nazwa jest unikalna tylko wśród połączeń aktywnych i oczekujących, dlatego pilnuje jej panel:
-- termin wygaśnięcia zależy od klucza API, którego baza tu nie zna.
CREATE INDEX idx_agent_connections_integration ON agent_connections(integration_id);
CREATE UNIQUE INDEX idx_agent_connections_code ON agent_connections(code_hash) WHERE code_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_connections_token ON agent_connections(token_hash) WHERE token_hash IS NOT NULL;

-- Kody autoryzacji OAuth: jednorazowe, ważne 60 sekund.
CREATE TABLE oauth_codes (
  code_hash       TEXT    PRIMARY KEY,
  connection_id   INTEGER NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  client_id       TEXT    NOT NULL,
  redirect_uri    TEXT    NOT NULL,
  code_challenge  TEXT    NOT NULL,
  resource        TEXT    NOT NULL,
  expires_at      TEXT    NOT NULL,
  used_at         TEXT
);
CREATE INDEX idx_oauth_codes_connection ON oauth_codes(connection_id);

-- Tokeny dostępu (godzina) i odświeżania (do końca ważności połączenia, rotowane przy każdym użyciu).
CREATE TABLE oauth_tokens (
  token_hash      TEXT    PRIMARY KEY,
  connection_id   INTEGER NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at      TEXT,
  created_at      TEXT    NOT NULL,
  rotated_at      TEXT,
  -- Nowa para zaszyfrowana kluczem głównym na 60 sekund tolerancji ponownego użycia.
  grace_pair_enc  TEXT
);
CREATE INDEX idx_oauth_tokens_connection ON oauth_tokens(connection_id);

-- Szkice wysyłki: wychodzi dokładnie to, co człowiek widział w podglądzie. Ważne 30 minut.
CREATE TABLE agent_drafts (
  id             TEXT    PRIMARY KEY,
  connection_id  INTEGER NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('sms', 'group', 'reply')),
  payload        TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  expires_at     TEXT    NOT NULL,
  sent_at        TEXT,
  result         TEXT,
  -- Skrót jednorazowego klucza potwierdzenia: szkic z sesji z widokami wysyła wyłącznie przycisk w widoku.
  confirm_hash   TEXT
);
CREATE INDEX idx_agent_drafts_expires ON agent_drafts(expires_at);

-- Linki do pobrania raportów i list CSV, ważne godzinę.
CREATE TABLE download_links (
  token_hash  TEXT    PRIMARY KEY,
  api_key_id  INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  connection_id INTEGER NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('package_report', 'package_failed', 'campaign_opened', 'campaign_unopened')),
  ref         TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL
);
CREATE INDEX idx_download_links_expires ON download_links(expires_at);

-- Źródło wysyłki. Nazwa połączenia trafia też do requested_by, więc źródło przetrwa usunięcie połączenia.
ALTER TABLE messages ADD COLUMN agent_connection_id INTEGER REFERENCES agent_connections(id) ON DELETE SET NULL;
ALTER TABLE packages ADD COLUMN agent_connection_id INTEGER REFERENCES agent_connections(id) ON DELETE SET NULL;
CREATE INDEX messages_agent_connection ON messages(agent_connection_id) WHERE agent_connection_id IS NOT NULL;
CREATE INDEX packages_agent_connection ON packages(agent_connection_id) WHERE agent_connection_id IS NOT NULL;

-- Odczyty agenta szukają ostatniej wiadomości i rozsyłki klucza na numer nadawcy odebranego SMS-a.
-- Indeks zaczyna się od numeru, dlatego lista wiadomości bez numeru zachowuje dotychczasowy plan.
CREATE INDEX idx_messages_dest_key ON messages(dest, api_key_id, created_at);
CREATE INDEX idx_package_recipients_dest ON package_recipients(dest, package_id);
