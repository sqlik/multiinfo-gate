PRAGMA foreign_keys = ON;

-- Klucz subskrybuje wiadomości przychodzące: dostaje message.received dla swoich usług.
ALTER TABLE api_keys ADD COLUMN inbound_subscribed INTEGER NOT NULL DEFAULT 0;

-- Stan odbiornika przy usłudze konta: kiedy ostatnio pytano, kiedy ostatnio coś przyszło, czemu stoi.
ALTER TABLE account_services ADD COLUMN inbound_last_poll_at TEXT;
ALTER TABLE account_services ADD COLUMN inbound_last_received_at TEXT;
ALTER TABLE account_services ADD COLUMN inbound_error TEXT;

CREATE TABLE inbound_messages (
  id                 TEXT    PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES accounts(id),
  service_id         TEXT    NOT NULL,
  mi_id              TEXT    NOT NULL,
  sender             TEXT    NOT NULL,
  dest               TEXT    NOT NULL,
  kind               TEXT    NOT NULL,
  body               TEXT,
  body_hash          TEXT    NOT NULL,
  protocol_id        INTEGER NOT NULL,
  coding_scheme      INTEGER NOT NULL,
  connector_id       TEXT,
  related_message_id TEXT    REFERENCES messages(id) ON DELETE SET NULL,
  received_at        TEXT    NOT NULL,
  created_at         TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_inbound_mi ON inbound_messages(account_id, mi_id);
CREATE INDEX idx_inbound_service_created ON inbound_messages(service_id, created_at DESC);
CREATE INDEX idx_inbound_created ON inbound_messages(created_at DESC);

-- Wątek wiąże obie tabele w cykl; SET NULL, żeby kasowanie (retencja) nie utknęło na kluczu obcym.
-- Odpowiedź na wiadomość przychodzącą (smsInId w sendsmslong.aspx).
ALTER TABLE messages ADD COLUMN in_reply_to TEXT REFERENCES inbound_messages(id) ON DELETE SET NULL;

-- Dostawa zdarzenia message.received: której wiadomości dotyczy i czy po zakończeniu
-- usunąć z payloadu treść (konto bez przechowywania treści).
ALTER TABLE webhook_deliveries ADD COLUMN inbound_id TEXT REFERENCES inbound_messages(id) ON DELETE CASCADE;
ALTER TABLE webhook_deliveries ADD COLUMN scrub_after INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_webhook_deliveries_inbound ON webhook_deliveries(inbound_id) WHERE inbound_id IS NOT NULL;
