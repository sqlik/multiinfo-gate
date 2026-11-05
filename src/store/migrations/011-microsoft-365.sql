PRAGMA foreign_keys = ON;

-- Konto techniczne Microsoft 365 połączone logowaniem w przeglądarce. Token odświeżania wyłącznie zaszyfrowany
-- kluczem głównym; token dostępu bramka trzyma tylko w pamięci. Zmiana katalogu albo aplikacji kasuje token,
-- bo należy on do innej rejestracji aplikacji.
CREATE TABLE m365_accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  tenant          TEXT    NOT NULL,
  client_id       TEXT    NOT NULL,
  -- Adres przekierowania użyty przy ostatnim logowaniu; panel ostrzega, gdy logowanie startuje spod innego adresu.
  redirect_uri    TEXT,
  -- Adres skrzynki: z roszczenia `email`, w razie braku z `preferred_username`; administrator może go zmienić.
  address         TEXT,
  -- 1, gdy adres zmienił administrator; ponowne logowanie tym samym kontem go wtedy nie nadpisuje.
  address_manual  INTEGER NOT NULL DEFAULT 0,
  -- Tożsamość z ostatniego logowania (`preferred_username` i `oid`); rozpoznaje ponowne logowanie tym samym kontem.
  login_name      TEXT,
  login_oid       TEXT,
  refresh_enc     TEXT,
  state           TEXT    NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'connected', 'needs_login', 'error')),
  error_code      TEXT,
  error_message   TEXT,
  -- Początek bieżącej awarii; kolejne błędy go nie przesuwają, udane odświeżenie go czyści.
  error_since     TEXT,
  notified_at     TEXT,
  connected_at    TEXT,
  connected_by    TEXT,
  last_refresh_at TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- Wysyłka maili przez konto Microsoft 365 zamiast hasła. Konta wskazanego w ustawieniach nie można usunąć,
-- dopóki administrator nie zmieni sposobu logowania.
ALTER TABLE smtp_settings ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'password' CHECK (auth_mode IN ('password', 'm365'));
ALTER TABLE smtp_settings ADD COLUMN m365_account_id INTEGER REFERENCES m365_accounts(id) ON DELETE RESTRICT;

-- Kanał SMS powiadomień: reguła mówi, czy zdarzenie idzie także SMS-em, a kolejka prowadzi stan SMS-a
-- niezależnie od maila. Dotychczasowe reguły i wpisy kolejki zostają bez SMS-a.
ALTER TABLE notification_rules ADD COLUMN sms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_queue ADD COLUMN sms_status TEXT NOT NULL DEFAULT 'none';
-- Czas wysłania SMS-a; dobowe pule powiadomień SMS liczą się od tej chwili, a nie od zdarzenia.
ALTER TABLE notification_queue ADD COLUMN sms_sent_at TEXT;
-- Liczba SMS-ów wysłanych dla wpisu, po jednym na numer kanału. Dobowe pule liczą SMS-y, a limit reguły na godzinę
-- liczy powiadomienia.
ALTER TABLE notification_queue ADD COLUMN sms_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_notification_sms_pending ON notification_queue(sms_status, event, at);

-- Ustawienia kanału SMS (jeden wiersz): odbiorcy jako tablica JSON, klucz API, w imieniu którego bramka
-- wysyła, i opcjonalny nadawca. Usunięcie klucza zostawia kanał bez klucza, czyli wyłączony w praktyce.
CREATE TABLE sms_notify_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled     INTEGER NOT NULL DEFAULT 0,
  recipients  TEXT    NOT NULL DEFAULT '[]',
  api_key_id  INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  orig        TEXT,
  updated_at  TEXT    NOT NULL
);

-- Wiadomość systemowa: SMS kanału powiadomień wysłany w imieniu klucza. Nie pojawia się w API, webhooku
-- klucza ani w integracjach wychodzących; panel pokazuje ją z oznaczeniem.
ALTER TABLE messages ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
