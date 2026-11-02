import type { Database } from 'better-sqlite3';
import { decryptSecret, SecretDecryptionError } from '../secrets/crypto.ts';

/** Grupy sekretów, których bramka używa do pracy. Wartości historyczne (dziennik integracji, nagłówki dostaw) nie wchodzą. */
export type SecretGroup = 'konta_panelu' | 'konta_multiinfo' | 'klucze_api' | 'integracje' | 'smtp';

export interface KeyCheck {
  readable: number;
  unreadable: number;
  unreadableGroups: SecretGroup[];
}

const SOURCES: ReadonlyArray<{ group: SecretGroup; sql: string }> = [
  { group: 'konta_panelu', sql: 'SELECT totp_secret_enc AS v FROM admin_users WHERE totp_secret_enc IS NOT NULL' },
  { group: 'konta_multiinfo', sql: 'SELECT password_enc AS v FROM accounts WHERE password_enc IS NOT NULL' },
  { group: 'klucze_api', sql: 'SELECT webhook_secret_enc AS v FROM api_keys WHERE webhook_secret_enc IS NOT NULL' },
  { group: 'integracje', sql: 'SELECT secrets_enc AS v FROM integrations WHERE secrets_enc IS NOT NULL' },
  { group: 'smtp', sql: 'SELECT password_enc AS v FROM smtp_settings WHERE password_enc IS NOT NULL' },
];

/** Klucz główny nie pasuje do bazy: dane bramki są bez niego nieczytelne. */
export class KeyMismatchError extends Error {
  constructor(readonly groups: SecretGroup[]) {
    super('Klucz główny nie pasuje do bazy: żadnego z zapisanych sekretów nie można odszyfrować');
    this.name = 'KeyMismatchError';
  }
}

/**
 * Próbuje odszyfrować bieżącym kluczem wszystkie sekrety używane do pracy. Tabele są małe
 * (konta, klucze, integracje), więc sprawdzenie wszystkich wierszy nie wydłuża startu.
 */
export function verifyMasterKey(db: Database, masterKey: Buffer): KeyCheck {
  const result: KeyCheck = { readable: 0, unreadable: 0, unreadableGroups: [] };
  for (const { group, sql } of SOURCES) {
    let groupFailed = false;
    for (const row of db.prepare(sql).all() as Array<{ v: string }>) {
      try {
        decryptSecret(row.v, masterKey);
        result.readable += 1;
      } catch (error) {
        if (!(error instanceof SecretDecryptionError)) throw error;
        result.unreadable += 1;
        groupFailed = true;
      }
    }
    if (groupFailed) result.unreadableGroups.push(group);
  }
  return result;
}

/**
 * Niezgodność tylko wtedy, gdy nie da się odszyfrować żadnego sekretu. Baza mieszana (część
 * pod starym kluczem) pracuje dalej: bramka, która dziś wysyła SMS-y, nie może stanąć po aktualizacji.
 */
export function isKeyMismatch(check: KeyCheck): boolean {
  return check.readable === 0 && check.unreadable > 0;
}
