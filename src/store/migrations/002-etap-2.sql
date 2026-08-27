PRAGMA foreign_keys = ON;

-- Ślad ostatniego wywołania sendsmslong.aspx (JSON). Hasło zamaskowane, treść tylko
-- gdy konto przechowuje treść.
ALTER TABLE messages ADD COLUMN trace TEXT;

CREATE TABLE message_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  at         TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  detail     TEXT
);
CREATE INDEX idx_message_events_message ON message_events(message_id, id);

CREATE TABLE packages (
  id                TEXT    PRIMARY KEY,
  api_key_id        INTEGER NOT NULL REFERENCES api_keys(id),
  account_id        INTEGER NOT NULL REFERENCES accounts(id),
  service_id        TEXT    NOT NULL,
  default_text      TEXT,
  orig              TEXT,
  cost_center       TEXT,
  start_at          TEXT,
  delivery_report   INTEGER NOT NULL DEFAULT 1,
  encoding          TEXT    NOT NULL,
  multipart         INTEGER NOT NULL DEFAULT 0,
  mi_package_id     TEXT,
  recipients_count  INTEGER NOT NULL,
  remaining_count   INTEGER,
  mi_status         INTEGER,
  status            TEXT    NOT NULL DEFAULT 'queued',
  provider_code     INTEGER,
  error             TEXT,
  report_status     TEXT    NOT NULL DEFAULT 'none',
  report_id         TEXT,
  report_expires_at TEXT,
  report_path       TEXT,
  created_at        TEXT    NOT NULL,
  completed_at      TEXT
);
CREATE INDEX idx_packages_created ON packages(created_at DESC);

CREATE TABLE package_recipients (
  package_id        TEXT    NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  dest              TEXT    NOT NULL,
  text              TEXT,
  client_id         TEXT,
  mi_id             TEXT,
  mi_status         INTEGER,
  status            TEXT,
  status_changed_at TEXT,
  PRIMARY KEY (package_id, seq)
);

CREATE TABLE webhook_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id    INTEGER NOT NULL REFERENCES api_keys(id),
  event         TEXT    NOT NULL,
  payload       TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',
  last_response TEXT,
  created_at    TEXT    NOT NULL,
  delivered_at  TEXT
);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status, created_at DESC);
