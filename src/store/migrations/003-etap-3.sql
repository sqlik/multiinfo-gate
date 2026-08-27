PRAGMA foreign_keys = ON;

-- Chwila UTC, w której klucz przestaje działać (koniec wybranego dnia w czasie polskim).
-- NULL to klucz bezterminowy.
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
