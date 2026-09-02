PRAGMA foreign_keys = ON;

-- Integracja: aplikacja obca rozmawia z bramką w swoim formacie. Zawsze na jednym kluczu API,
-- bo limity, statystyki i uprawnienia do usług są przy kluczu.
CREATE TABLE integrations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  api_key_id     INTEGER NOT NULL REFERENCES api_keys(id),
  service_id     TEXT,
  orig           TEXT,
  preset         TEXT    NOT NULL DEFAULT 'custom',
  enabled        INTEGER NOT NULL DEFAULT 1,
  hook_id        TEXT    UNIQUE,
  config         TEXT    NOT NULL,
  secrets_enc    TEXT,
  store_payloads INTEGER NOT NULL DEFAULT 0,
  last_event_at  TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_integrations_key_name ON integrations(api_key_id, name);
CREATE INDEX idx_integrations_kind_enabled ON integrations(kind, enabled);

-- Dziennik integracji: co przyszło albo wyszło i z jakim wynikiem. Ładunek tylko, gdy integracja
-- ma włączone przechowywanie; wtedy zaszyfrowany, bo bywa w nim numer i nazwisko z CRM.
CREATE TABLE integration_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  at             TEXT    NOT NULL,
  result         TEXT    NOT NULL,
  reason         TEXT,
  source_ip      TEXT,
  message_id     TEXT,
  inbound_id     TEXT,
  delivery_id    INTEGER,
  payload_enc    TEXT,
  response       TEXT
);
CREATE INDEX idx_integration_events_integration ON integration_events(integration_id, id DESC);
CREATE INDEX idx_integration_events_at ON integration_events(at DESC);

-- Idempotencja po identyfikatorze zdarzenia z ładunku (24 h).
CREATE TABLE integration_dedup (
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  event_key      TEXT    NOT NULL,
  at             TEXT    NOT NULL,
  PRIMARY KEY (integration_id, event_key)
);

-- Ochrona przed burzą: jedno okno na integrację, nadpisywane przy nowym oknie.
CREATE TABLE integration_throttle (
  integration_id INTEGER PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  window_start   TEXT    NOT NULL,
  count          INTEGER NOT NULL DEFAULT 0,
  notified       INTEGER NOT NULL DEFAULT 0
);

-- Ślady integracji na istniejących tabelach.
ALTER TABLE messages ADD COLUMN integration_id INTEGER REFERENCES integrations(id) ON DELETE SET NULL;
ALTER TABLE inbound_messages ADD COLUMN external_ref TEXT;
ALTER TABLE inbound_messages ADD COLUMN external_integration_id INTEGER REFERENCES integrations(id) ON DELETE SET NULL;
CREATE INDEX idx_inbound_external_ref ON inbound_messages(external_integration_id, external_ref) WHERE external_ref IS NOT NULL;
ALTER TABLE webhook_deliveries ADD COLUMN integration_id INTEGER REFERENCES integrations(id) ON DELETE CASCADE;
ALTER TABLE webhook_deliveries ADD COLUMN method TEXT NOT NULL DEFAULT 'POST';
ALTER TABLE webhook_deliveries ADD COLUMN headers_enc TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN response_ref TEXT;
CREATE INDEX idx_webhook_deliveries_integration ON webhook_deliveries(integration_id) WHERE integration_id IS NOT NULL;

-- Powiadomienia administratora: jeden wiersz SMTP (id = 1), reguły per zdarzenie, kolejka.
CREATE TABLE smtp_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  host          TEXT    NOT NULL,
  port          INTEGER NOT NULL,
  security      TEXT    NOT NULL,
  user          TEXT,
  password_enc  TEXT,
  from_address  TEXT    NOT NULL,
  from_name     TEXT    NOT NULL DEFAULT 'Multiinfo Gate',
  recipients    TEXT    NOT NULL,
  instance_name TEXT    NOT NULL,
  panel_url     TEXT,
  updated_at    TEXT    NOT NULL
);
CREATE TABLE notification_rules (
  event        TEXT    PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 1,
  max_per_hour INTEGER NOT NULL DEFAULT 5,
  group_hours  INTEGER NOT NULL DEFAULT 0,
  params       TEXT    NOT NULL DEFAULT '{}'
);
-- dedup_key: co nie ma pójść dwa razy (np. certyfikat konta 3 na progu 30 dni); NULL = zawsze nowe.
CREATE TABLE notification_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT    NOT NULL,
  at          TEXT    NOT NULL,
  subject_key TEXT,
  dedup_key   TEXT,
  summary     TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  sent_at     TEXT
);
CREATE UNIQUE INDEX idx_notification_dedup ON notification_queue(event, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX idx_notification_pending ON notification_queue(status, event, at);
