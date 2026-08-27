PRAGMA foreign_keys = ON;

-- Wszystkie znaczniki czasu zapisujemy w ISO 8601 ze strefą Z. Wbudowane
-- datetime('now') daje postać 'RRRR-MM-DD GG:MM:SS', która przy porównaniu
-- tekstowym z wartościami podawanymi z zewnątrz wypada przed nimi, więc
-- filtry zakresu dat milczkiem zwracałyby pustą listę.

CREATE TABLE accounts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL UNIQUE,
  base_url               TEXT    NOT NULL DEFAULT 'https://api2.multiinfo.plus.pl/Api61/',
  login                  TEXT    NOT NULL,
  password_enc           TEXT    NOT NULL,
  cert_pem_enc           TEXT    NOT NULL,
  key_pem_enc            TEXT    NOT NULL,
  ca_pem_enc             TEXT,
  cert_cn                TEXT    NOT NULL,
  cert_issuer_cn         TEXT    NOT NULL,
  cert_fingerprint_sha1  TEXT    NOT NULL,
  cert_not_before        TEXT    NOT NULL,
  cert_not_after         TEXT    NOT NULL,
  default_country_code   TEXT    NOT NULL DEFAULT '48',
  default_orig           TEXT,
  store_content          INTEGER NOT NULL DEFAULT 0,
  paused_reason          TEXT,
  active                 INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE account_services (
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  service_id  TEXT    NOT NULL,
  label       TEXT,
  PRIMARY KEY (account_id, service_id)
);

CREATE TABLE account_origs (
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  orig        TEXT    NOT NULL,
  label       TEXT,
  PRIMARY KEY (account_id, orig)
);

CREATE TABLE api_keys (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               TEXT    NOT NULL,
  key_hash           TEXT    NOT NULL UNIQUE,
  key_prefix         TEXT    NOT NULL,
  default_service_id TEXT,
  default_orig       TEXT,
  max_parts          INTEGER NOT NULL DEFAULT 9,
  rate_per_min       INTEGER NOT NULL DEFAULT 60,
  webhook_url        TEXT,
  webhook_secret_enc TEXT,
  last_used_at       TEXT,
  revoked_at         TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

CREATE TABLE api_key_services (
  api_key_id  INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  service_id  TEXT    NOT NULL,
  PRIMARY KEY (api_key_id, service_id)
);

-- Usunięcie nadpisu ze słownika konta kasuje go też z kluczy, dlatego klucz obcy
-- wskazuje na account_origs, a nie na samą wartość tekstową.
CREATE TABLE api_key_origs (
  api_key_id  INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL,
  orig        TEXT    NOT NULL,
  PRIMARY KEY (api_key_id, orig),
  FOREIGN KEY (account_id, orig) REFERENCES account_origs(account_id, orig) ON DELETE CASCADE
);

CREATE TABLE messages (
  id              TEXT    PRIMARY KEY,
  api_key_id      INTEGER NOT NULL REFERENCES api_keys(id),
  account_id      INTEGER NOT NULL REFERENCES accounts(id),
  service_id      TEXT    NOT NULL,
  dest            TEXT    NOT NULL,
  body            TEXT,
  body_hash       TEXT    NOT NULL,
  encoding        TEXT    NOT NULL,
  parts           INTEGER NOT NULL,
  slots           INTEGER NOT NULL,
  orig            TEXT,
  cost_center     TEXT,
  valid_to        TEXT,
  mi_ids          TEXT    NOT NULL DEFAULT '[]',
  status          TEXT    NOT NULL DEFAULT 'queued',
  mi_status       INTEGER,
  mi_substatus    INTEGER,
  provider_code   INTEGER,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_poll_at    TEXT,
  idempotency_key TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at         TEXT,
  final_at        TEXT
);
CREATE INDEX idx_messages_created ON messages(created_at DESC);
CREATE INDEX idx_messages_status ON messages(status);
CREATE UNIQUE INDEX idx_messages_idem ON messages(api_key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  run_at     TEXT    NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  locked_at  TEXT,
  last_error TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_jobs_ready ON jobs(run_at) WHERE locked_at IS NULL;

CREATE TABLE admin_users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  login              TEXT    NOT NULL UNIQUE,
  password_hash      TEXT    NOT NULL,
  totp_secret_enc    TEXT,
  totp_enabled       INTEGER NOT NULL DEFAULT 0,
  recovery_codes_enc TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  meta   TEXT,
  ip     TEXT,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_audit_at ON audit_log(at DESC);
