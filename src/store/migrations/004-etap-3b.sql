PRAGMA foreign_keys = ON;

-- Ostatnie udane logowanie do panelu (chwila UTC). NULL: konto jeszcze nie weszło.
ALTER TABLE admin_users ADD COLUMN last_login_at TEXT;
