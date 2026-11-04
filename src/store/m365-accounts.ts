import type { Database } from 'better-sqlite3';
import { decryptSecret, encryptSecret } from '../secrets/crypto.ts';

export type M365State = 'new' | 'connected' | 'needs_login' | 'error';

export interface M365AccountRow {
  id: number; name: string; tenant: string; clientId: string; redirectUri: string | null; address: string | null;
  state: M365State; errorCode: string | null; errorMessage: string | null; errorSince: string | null; notifiedAt: string | null;
  connectedAt: string | null; connectedBy: string | null; lastRefreshAt: string | null; createdAt: string; updatedAt: string;
}

export interface M365AccountInput { name: string; tenant: string; clientId: string }

interface RawAccount {
  id: number; name: string; tenant: string; client_id: string; redirect_uri: string | null; address: string | null;
  state: M365State; error_code: string | null; error_message: string | null; error_since: string | null; notified_at: string | null;
  connected_at: string | null; connected_by: string | null; last_refresh_at: string | null; created_at: string; updated_at: string;
}

const toRow = (r: RawAccount): M365AccountRow => ({
  id: r.id, name: r.name, tenant: r.tenant, clientId: r.client_id, redirectUri: r.redirect_uri, address: r.address,
  state: r.state, errorCode: r.error_code, errorMessage: r.error_message, errorSince: r.error_since, notifiedAt: r.notified_at,
  connectedAt: r.connected_at, connectedBy: r.connected_by, lastRefreshAt: r.last_refresh_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Kolumny błędu i powiadomienia czyszczone po udanym logowaniu, odświeżeniu, rozłączeniu i zmianie aplikacji. */
const CLEAR_ERROR = 'error_code = NULL, error_message = NULL, error_since = NULL, notified_at = NULL';

/**
 * Konta Microsoft 365. Token odświeżania wyłącznie zaszyfrowany kluczem głównym i odczytywany jawnie
 * tylko przez `refreshToken()`, na potrzeby wymiany na token dostępu.
 */
export class M365AccountsRepo {
  constructor(private readonly db: Database, private readonly masterKey: Buffer) {}

  list(): M365AccountRow[] {
    return (this.db.prepare('SELECT * FROM m365_accounts ORDER BY name COLLATE NOCASE, id').all() as RawAccount[]).map(toRow);
  }

  get(id: number): M365AccountRow | undefined {
    const r = this.db.prepare('SELECT * FROM m365_accounts WHERE id = ?').get(id) as RawAccount | undefined;
    return r ? toRow(r) : undefined;
  }

  create(input: M365AccountInput, at: Date): number {
    const now = at.toISOString();
    const info = this.db.prepare('INSERT INTO m365_accounts (name, tenant, client_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.name, input.tenant, input.clientId, now, now);
    return Number(info.lastInsertRowid);
  }

  /** Zmiana `tenant` albo `clientId` kasuje token i ustawia `new`: stary token należy do innej aplikacji. */
  update(id: number, input: M365AccountInput, at: Date): void {
    const current = this.get(id);
    if (!current) return;
    const now = at.toISOString();
    if (current.tenant !== input.tenant || current.clientId !== input.clientId) {
      this.db.prepare(
        `UPDATE m365_accounts SET name = ?, tenant = ?, client_id = ?, refresh_enc = NULL, state = 'new',
           connected_at = NULL, connected_by = NULL, ${CLEAR_ERROR}, updated_at = ? WHERE id = ?`,
      ).run(input.name, input.tenant, input.clientId, now, id);
      return;
    }
    this.db.prepare('UPDATE m365_accounts SET name = ?, updated_at = ? WHERE id = ?').run(input.name, now, id);
  }

  setAddress(id: number, address: string, at: Date): void {
    this.db.prepare('UPDATE m365_accounts SET address = ?, updated_at = ? WHERE id = ?').run(address, at.toISOString(), id);
  }

  connected(id: number, c: { refreshToken: string; address: string; redirectUri: string; by: string }, at: Date): void {
    const now = at.toISOString();
    this.db.prepare(
      `UPDATE m365_accounts SET refresh_enc = ?, address = ?, redirect_uri = ?, state = 'connected', connected_at = ?,
         connected_by = ?, last_refresh_at = ?, ${CLEAR_ERROR}, updated_at = ? WHERE id = ?`,
    ).run(encryptSecret(c.refreshToken, this.masterKey), c.address, c.redirectUri, now, c.by, now, now, id);
  }

  refreshed(id: number, refreshToken: string, at: Date): void {
    const now = at.toISOString();
    this.db.prepare(
      `UPDATE m365_accounts SET refresh_enc = ?, state = 'connected', last_refresh_at = ?, ${CLEAR_ERROR}, updated_at = ? WHERE id = ?`,
    ).run(encryptSecret(refreshToken, this.masterKey), now, now, id);
  }

  refreshToken(id: number): string | null {
    const r = this.db.prepare('SELECT refresh_enc FROM m365_accounts WHERE id = ?').get(id) as { refresh_enc: string | null } | undefined;
    return r?.refresh_enc ? decryptSecret(r.refresh_enc, this.masterKey) : null;
  }

  /** Ustawia `error_since` tylko wtedy, gdy było puste; `connected`/`refreshed` je czyszczą razem z `notified_at`. */
  failed(id: number, f: { state: 'needs_login' | 'error'; code: string | null; message: string }, at: Date): void {
    const now = at.toISOString();
    this.db.prepare(
      `UPDATE m365_accounts SET state = ?, error_code = ?, error_message = ?, error_since = COALESCE(error_since, ?), updated_at = ?
       WHERE id = ?`,
    ).run(f.state, f.code, f.message, now, now, id);
  }

  markNotified(id: number, at: Date): void {
    this.db.prepare('UPDATE m365_accounts SET notified_at = ? WHERE id = ?').run(at.toISOString(), id);
  }

  disconnect(id: number, at: Date): void {
    this.db.prepare(
      `UPDATE m365_accounts SET refresh_enc = NULL, state = 'new', connected_at = NULL, connected_by = NULL, ${CLEAR_ERROR},
         updated_at = ? WHERE id = ?`,
    ).run(at.toISOString(), id);
  }

  /** Konto wskazane w ustawieniach SMTP blokuje klucz obcy (ON DELETE RESTRICT): wyjątek, konto zostaje. */
  remove(id: number): void {
    this.db.prepare('DELETE FROM m365_accounts WHERE id = ?').run(id);
  }
}
