PRAGMA foreign_keys = ON;

-- Domeny skracacza linków. Nazwa małymi literami, ASCII (domena IDN w postaci punycode), bez kropki na końcu.
-- Domeny przypisanej do klucza albo z kodami przed końcem retencji nie można usunąć, tylko wyłączyć.
CREATE TABLE link_domains (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  domain        TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,
  -- Dokąd kieruje sam adres domeny; NULL oznacza neutralną stronę z nazwą wyświetlaną.
  home_url      TEXT,
  -- 1: krótki link w treści bez `https://`.
  bare_links    INTEGER NOT NULL DEFAULT 0,
  -- 0: domena nie przekierowuje żadnego linku.
  enabled       INTEGER NOT NULL DEFAULT 1,
  checked_at    TEXT,
  check_ok      INTEGER,
  check_detail  TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- Skracanie przy kluczu. Istniejące klucze zostają bez skracania.
ALTER TABLE api_keys ADD COLUMN link_mode TEXT NOT NULL DEFAULT 'off' CHECK (link_mode IN ('off', 'sender', 'always'));
ALTER TABLE api_keys ADD COLUMN link_default_domain_id INTEGER REFERENCES link_domains(id);
ALTER TABLE api_keys ADD COLUMN link_validity_days INTEGER NOT NULL DEFAULT 90;
ALTER TABLE api_keys ADD COLUMN link_utm INTEGER NOT NULL DEFAULT 1;

-- Domeny skracacza dostępne dla klucza.
CREATE TABLE api_key_link_domains (
  api_key_id  INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  domain_id   INTEGER NOT NULL REFERENCES link_domains(id),
  PRIMARY KEY (api_key_id, domain_id)
);
CREATE INDEX idx_api_key_link_domains_domain ON api_key_link_domains(domain_id);

-- Domeny docelowe: bramka skraca wyłącznie linki prowadzące do tych domen i ich subdomen.
CREATE TABLE api_key_link_targets (
  api_key_id  INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  domain      TEXT    NOT NULL,
  PRIMARY KEY (api_key_id, domain)
);

-- Kampania: para (klucz, nazwa). Liczby zbiorcze bez danych osobowych, bez limitu czasu.
CREATE TABLE campaigns (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id         INTEGER NOT NULL REFERENCES api_keys(id),
  name               TEXT    NOT NULL,
  first_sent_at      TEXT    NOT NULL,
  last_sent_at       TEXT    NOT NULL,
  -- SMS-y z krótkimi linkami.
  sent               INTEGER NOT NULL DEFAULT 0,
  -- Unikalni odbiorcy z otwarciem, bez automatów.
  opens              INTEGER NOT NULL DEFAULT 0,
  -- Wszystkie wejścia ludzi.
  clicks             INTEGER NOT NULL DEFAULT 0,
  -- Wejścia odfiltrowane jako automaty.
  bots               INTEGER NOT NULL DEFAULT 0,
  links_disabled_at  TEXT,
  details_purged_at  TEXT,
  created_at         TEXT    NOT NULL,
  UNIQUE (api_key_id, name)
);
CREATE INDEX idx_campaigns_last_sent ON campaigns(last_sent_at);

-- Kliknięcia w godzinach (UTC, `YYYY-MM-DDTHH`) do wykresu kampanii.
CREATE TABLE campaign_hours (
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  hour         TEXT    NOT NULL,
  clicks       INTEGER NOT NULL DEFAULT 0,
  bots         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, hour)
);

-- Liczby per adres docelowy. Adres indywidualny (jeden odbiorca) po terminie retencji trafia do wiersza
-- `collapsed = 1` ze wzorcem zamiast adresu, bo adres może zawierać dane odbiorcy.
CREATE TABLE campaign_targets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  target       TEXT    NOT NULL,
  collapsed    INTEGER NOT NULL DEFAULT 0,
  recipients   INTEGER NOT NULL DEFAULT 0,
  opens        INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  purge_after  TEXT,
  UNIQUE (campaign_id, target, collapsed)
);
CREATE INDEX idx_campaign_targets_purge ON campaign_targets(purge_after);

-- Krótki kod: jeden na wystąpienie linku u odbiorcy. Kod rozróżnia wielkość liter. Bramka nie zapisuje
-- adresu IP ani nagłówka User-Agent wejścia. `message_id` i `package_id` bez kluczy obcych: kody powstają
-- przy przyjęciu wysyłki, a wiadomości i rozsyłki nie są usuwane.
CREATE TABLE short_links (
  code             TEXT    PRIMARY KEY,
  domain_id        INTEGER NOT NULL REFERENCES link_domains(id),
  api_key_id       INTEGER NOT NULL REFERENCES api_keys(id),
  campaign_id      INTEGER NOT NULL REFERENCES campaigns(id),
  target           TEXT    NOT NULL,
  utm              INTEGER NOT NULL,
  -- Odbiorca w kampanii: `msg_…` albo `pkg_…#<seq>`.
  recipient_key    TEXT    NOT NULL,
  message_id       TEXT,
  package_id       TEXT,
  seq              INTEGER,
  dest             TEXT    NOT NULL,
  client_id        TEXT,
  clicks           INTEGER NOT NULL DEFAULT 0,
  bot_clicks       INTEGER NOT NULL DEFAULT 0,
  first_opened_at  TEXT,
  last_clicked_at  TEXT,
  expires_at       TEXT    NOT NULL,
  disabled_at      TEXT,
  purge_after      TEXT    NOT NULL,
  created_at       TEXT    NOT NULL
);
CREATE INDEX idx_short_links_recipient ON short_links(campaign_id, recipient_key);
-- Odbiorcy adresu docelowego liczą się według numerów: przypomnienie do tego samego numeru nie tworzy linku wspólnego.
CREATE INDEX idx_short_links_dest ON short_links(campaign_id, dest);
CREATE INDEX idx_short_links_message ON short_links(message_id);
CREATE INDEX idx_short_links_package ON short_links(package_id, seq);
CREATE INDEX idx_short_links_purge ON short_links(purge_after);
CREATE INDEX idx_short_links_domain ON short_links(domain_id);

-- Wiadomości i rozsyłki z krótkimi linkami należą do kampanii; `links` to liczba kodów odbiorcy rozsyłki.
ALTER TABLE messages ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id);
ALTER TABLE packages ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id);
ALTER TABLE package_recipients ADD COLUMN links INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_campaign ON messages(campaign_id);
CREATE INDEX idx_packages_campaign ON packages(campaign_id);
