import type { Database } from 'better-sqlite3';

export interface OAuthClientRow {
  clientId: string;
  kind: 'dynamic' | 'metadata';
  name: string;
  redirectUris: string[];
  sourceIp: string | null;
  createdAt: string;
  fetchedAt: string | null;
  connectedAt: string | null;
}

export interface AuthCodeRow { connectionId: number; clientId: string; redirectUri: string; codeChallenge: string; resource: string; expiresAt: string }

export interface TokenRow {
  connectionId: number;
  kind: 'access' | 'refresh';
  expiresAt: string | null;
  createdAt: string;
  rotatedAt: string | null;
  gracePairEnc: string | null;
}

/** Tolerancja ponownego użycia tokenu odświeżania po rotacji. */
const GRACE_MS = 60_000;
/** Zużyty token odświeżania zostaje tyle czasu, żeby jego ponowne użycie zostało rozpoznane i odwołało połączenie. */
const ROTATED_KEEP_MS = 30 * 86_400_000;
/** Klient dynamiczny, który nie dokończył połączenia. */
const ABANDONED_CLIENT_MS = 86_400_000;

interface RawClient {
  client_id: string; kind: 'dynamic' | 'metadata'; name: string; redirect_uris: string; source_ip: string | null;
  created_at: string; fetched_at: string | null; connected_at: string | null;
}

const toClient = (r: RawClient): OAuthClientRow => ({
  clientId: r.client_id, kind: r.kind, name: r.name, redirectUris: JSON.parse(r.redirect_uris) as string[], sourceIp: r.source_ip,
  createdAt: r.created_at, fetchedAt: r.fetched_at, connectedAt: r.connected_at,
});

/** Klienci, kody autoryzacji i tokeny serwera autoryzacji bramki. Kody i tokeny wyłącznie jako skróty. */
export class OAuthRepo {
  constructor(private readonly db: Database) {}

  /** Ponowny zapis (odświeżony dokument metadanych) aktualizuje dane klienta i zachowuje chwilę rejestracji. */
  upsertClient(c: Omit<OAuthClientRow, 'connectedAt'>): void {
    this.db.prepare(
      `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, source_ip, created_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET kind = excluded.kind, name = excluded.name, redirect_uris = excluded.redirect_uris,
         source_ip = excluded.source_ip, fetched_at = excluded.fetched_at`,
    ).run(c.clientId, c.kind, c.name, JSON.stringify(c.redirectUris), c.sourceIp, c.createdAt, c.fetchedAt);
  }

  getClient(clientId: string): OAuthClientRow | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as RawClient | undefined;
    return row ? toClient(row) : undefined;
  }

  markConnected(clientId: string, at: Date): void {
    this.db.prepare('UPDATE oauth_clients SET connected_at = ? WHERE client_id = ?').run(at.toISOString(), clientId);
  }

  insertCode(hash: string, c: AuthCodeRow): void {
    this.db.prepare(
      'INSERT INTO oauth_codes (code_hash, connection_id, client_id, redirect_uri, code_challenge, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(hash, c.connectionId, c.clientId, c.redirectUri, c.codeChallenge, c.resource, c.expiresAt);
  }

  /** Zwraca kod i oznacza użycie; drugie wywołanie i kod po terminie dają undefined. */
  takeCode(hash: string, at: Date): AuthCodeRow | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT connection_id, client_id, redirect_uri, code_challenge, resource, expires_at FROM oauth_codes
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      ).get(hash, at.toISOString()) as
        { connection_id: number; client_id: string; redirect_uri: string; code_challenge: string; resource: string; expires_at: string } | undefined;
      if (!row) return undefined;
      this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?').run(at.toISOString(), hash);
      return {
        connectionId: row.connection_id, clientId: row.client_id, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge,
        resource: row.resource, expiresAt: row.expires_at,
      };
    })();
  }

  insertToken(hash: string, t: Omit<TokenRow, 'rotatedAt' | 'gracePairEnc'>): void {
    this.db.prepare('INSERT INTO oauth_tokens (token_hash, connection_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(hash, t.connectionId, t.kind, t.expiresAt, t.createdAt);
  }

  getToken(hash: string): TokenRow | undefined {
    const row = this.db.prepare(
      'SELECT connection_id, kind, expires_at, created_at, rotated_at, grace_pair_enc FROM oauth_tokens WHERE token_hash = ?',
    ).get(hash) as
      { connection_id: number; kind: 'access' | 'refresh'; expires_at: string | null; created_at: string; rotated_at: string | null; grace_pair_enc: string | null }
      | undefined;
    return row
      ? { connectionId: row.connection_id, kind: row.kind, expiresAt: row.expires_at, createdAt: row.created_at, rotatedAt: row.rotated_at, gracePairEnc: row.grace_pair_enc }
      : undefined;
  }

  /** Oznacza token odświeżania jako zużyty i zapisuje zaszyfrowaną nową parę na czas tolerancji. */
  rotate(hash: string, gracePairEnc: string, at: Date): void {
    this.db.prepare('UPDATE oauth_tokens SET rotated_at = ?, grace_pair_enc = ? WHERE token_hash = ?').run(at.toISOString(), gracePairEnc, hash);
  }

  deleteToken(hash: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(hash);
  }

  deleteForConnection(connectionId: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM oauth_tokens WHERE connection_id = ?').run(connectionId);
      this.db.prepare('DELETE FROM oauth_codes WHERE connection_id = ?').run(connectionId);
    })();
  }

  /** Sprzątanie: kody po terminie, tokeny dostępu po terminie, tolerancja starsza niż 60 s, tokeny odświeżania 30 dni po rotacji, klienci dynamiczni bez połączenia starsi niż doba. */
  prune(now: Date): { codes: number; tokens: number; clients: number } {
    const iso = now.toISOString();
    const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
    return this.db.transaction(() => {
      const codes = this.db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(iso).changes;
      const access = this.db.prepare("DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at <= ?").run(iso).changes;
      const refresh = this.db.prepare("DELETE FROM oauth_tokens WHERE kind = 'refresh' AND rotated_at IS NOT NULL AND rotated_at <= ?")
        .run(before(ROTATED_KEEP_MS)).changes;
      this.db.prepare('UPDATE oauth_tokens SET grace_pair_enc = NULL WHERE grace_pair_enc IS NOT NULL AND rotated_at <= ?').run(before(GRACE_MS));
      const clients = this.db.prepare(
        `DELETE FROM oauth_clients WHERE kind = 'dynamic' AND connected_at IS NULL AND created_at <= ?
           AND NOT EXISTS (SELECT 1 FROM agent_connections c WHERE c.client_id = oauth_clients.client_id)`,
      ).run(before(ABANDONED_CLIENT_MS)).changes;
      return { codes, tokens: access + refresh, clients };
    })();
  }
}
