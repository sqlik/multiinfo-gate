import type { Database } from 'better-sqlite3';
import { decryptSecret, encryptSecret } from '../secrets/crypto.ts';

export interface AdminUserRow {
  id: number; login: string; passwordHash: string;
  totpEnabled: 0 | 1; createdAt: string; lastLoginAt: string | null;
}

interface RawAdminUser {
  id: number; login: string; password_hash: string;
  totp_enabled: 0 | 1; created_at: string; last_login_at: string | null;
}

const COLUMNS = 'id, login, password_hash, totp_enabled, created_at, last_login_at';

function toRow(r: RawAdminUser): AdminUserRow {
  return {
    id: r.id, login: r.login, passwordHash: r.password_hash,
    totpEnabled: r.totp_enabled, createdAt: r.created_at, lastLoginAt: r.last_login_at,
  };
}

export class AdminUsersRepo {
  constructor(
    private readonly db: Database,
    private readonly masterKey: Buffer,
  ) {}

  findByLogin(login: string): AdminUserRow | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM admin_users WHERE login = ?`)
      .get(login) as RawAdminUser | undefined;
    return row ? toRow(row) : undefined;
  }

  findById(id: number): AdminUserRow | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM admin_users WHERE id = ?`)
      .get(id) as RawAdminUser | undefined;
    return row ? toRow(row) : undefined;
  }

  /** Sekret TOTP w postaci jawnej. Nie wolno go zapisywać w dzienniku ani zwracać do przeglądarki. */
  totpSecret(id: number): string | null {
    const row = this.db.prepare('SELECT totp_secret_enc FROM admin_users WHERE id = ?').get(id) as
      | { totp_secret_enc: string | null }
      | undefined;
    if (!row?.totp_secret_enc) return null;
    return decryptSecret(row.totp_secret_enc, this.masterKey);
  }

  insert(login: string, passwordHash: string): number {
    const info = this.db
      .prepare('INSERT INTO admin_users (login, password_hash) VALUES (?, ?)')
      .run(login, passwordHash);
    return Number(info.lastInsertRowid);
  }

  list(): AdminUserRow[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM admin_users ORDER BY id`).all() as RawAdminUser[];
    return rows.map(toRow);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM admin_users').get() as { n: number };
    return row.n;
  }

  /** Wpisy dziennika z loginem tej osoby zostają - dziennik nie ma klucza obcego do konta. */
  delete(id: number): void {
    this.db.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
  }

  /** Po resecie konto wraca do stanu sprzed włączenia drugiego składnika. */
  resetTotp(id: number): void {
    this.db
      .prepare('UPDATE admin_users SET totp_secret_enc = NULL, recovery_codes_enc = NULL, totp_enabled = 0 WHERE id = ?')
      .run(id);
  }

  setPassword(id: number, passwordHash: string): void {
    this.db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  touchLogin(id: number, at: Date): void {
    this.db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(at.toISOString(), id);
  }

  enableTotp(id: number, secret: string, recoveryCodes: string[]): void {
    this.db
      .prepare('UPDATE admin_users SET totp_secret_enc = ?, recovery_codes_enc = ?, totp_enabled = 1 WHERE id = ?')
      .run(
        encryptSecret(secret, this.masterKey),
        encryptSecret(JSON.stringify(recoveryCodes), this.masterKey),
        id,
      );
  }

  /**
   * Zużywa kod odzyskiwania. Trafienie usuwa kod z listy, więc drugie użycie
   * tego samego kodu zwróci już fałsz.
   */
  consumeRecoveryCode(id: number, code: string): boolean {
    const consume = this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT recovery_codes_enc FROM admin_users WHERE id = ?').get(id) as
        | { recovery_codes_enc: string | null }
        | undefined;
      if (!row?.recovery_codes_enc) return false;

      const codes = JSON.parse(decryptSecret(row.recovery_codes_enc, this.masterKey)) as string[];
      const index = codes.indexOf(code);
      if (index === -1) return false;

      codes.splice(index, 1);
      this.db
        .prepare('UPDATE admin_users SET recovery_codes_enc = ? WHERE id = ?')
        .run(encryptSecret(JSON.stringify(codes), this.masterKey), id);
      return true;
    });
    return consume();
  }
}
