PRAGMA foreign_keys = ON;

-- Stan skrzynki pocztowej integracji mail_in: jeden wiersz na integrację. Próg uid_floor realizuje
-- zasadę „od teraz”: maile o UID nie wyższym niż próg bramka pomija, chyba że backlog = 1.
-- Kolumna failures liczy kolejne nieudane odpytania do odstępu rosnącego.
CREATE TABLE mail_in_state (
  integration_id INTEGER PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  uidvalidity    INTEGER,
  uid_floor      INTEGER NOT NULL DEFAULT 0,
  backlog        INTEGER NOT NULL DEFAULT 0,
  last_poll_at   TEXT,
  last_ok_at     TEXT,
  next_poll_at   TEXT    NOT NULL,
  error          TEXT,
  error_kind     TEXT,
  error_since    TEXT,
  unseen         INTEGER,
  notified_at    TEXT,
  failures       INTEGER NOT NULL DEFAULT 0
);

-- Maile, które bramka wzięła pod uwagę. Zapis przed wysyłką: awaria w połowie kosztuje jeden
-- niedosłany SMS, nie dubel na koszt konta.
CREATE TABLE mail_in_seen (
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  message_id     TEXT,
  uidvalidity    INTEGER NOT NULL,
  uid            INTEGER NOT NULL,
  at             TEXT    NOT NULL,
  outcome        TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_mail_in_seen_uid ON mail_in_seen(integration_id, uidvalidity, uid);
CREATE INDEX idx_mail_in_seen_message ON mail_in_seen(integration_id, message_id);
CREATE INDEX idx_mail_in_seen_at ON mail_in_seen(at);
