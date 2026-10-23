PRAGMA foreign_keys = ON;

-- Adres e-mail nadawcy wiadomości, z której Mail2SMS zlecił wysyłkę; pusty dla zleceń z API i webhooków.
-- Dziennik integracji ma stały rozmiar, więc adres przy wiadomości jest jedynym trwałym śladem nadawcy.
ALTER TABLE messages ADD COLUMN mail_from TEXT;
