import type { Database } from 'better-sqlite3';

export type ConnectionMethod = 'oauth' | 'token';

/** Połączenie osoby z integracją „Agent AI”. Skróty kodu i tokenu nie opuszczają repozytorium. */
export interface AgentConnectionRow {
  id: number;
  integrationId: number;
  name: string;
  method: ConnectionMethod;
  codeExpiresAt: string | null;
  codeUsedAt: string | null;
  clientId: string | null;
  clientName: string | null;
  /** `null`: bez terminu, ale nigdy dłużej niż klucz API integracji. */
  expiresAt: string | null;
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: 'admin' | 'reuse' | null;
}

interface RawConnection {
  id: number; integration_id: number; name: string; method: ConnectionMethod; code_expires_at: string | null; code_used_at: string | null;
  client_id: string | null; client_name: string | null; expires_at: string | null; created_at: string; created_by: string;
  last_used_at: string | null; revoked_at: string | null; revoked_reason: 'admin' | 'reuse' | null;
}

const COLUMNS = `id, integration_id, name, method, code_expires_at, code_used_at, client_id, client_name, expires_at,
  created_at, created_by, last_used_at, revoked_at, revoked_reason`;

const toRow = (r: RawConnection): AgentConnectionRow => ({
  id: r.id, integrationId: r.integration_id, name: r.name, method: r.method, codeExpiresAt: r.code_expires_at, codeUsedAt: r.code_used_at,
  clientId: r.client_id, clientName: r.client_name, expiresAt: r.expires_at, createdAt: r.created_at, createdBy: r.created_by,
  lastUsedAt: r.last_used_at, revokedAt: r.revoked_at, revokedReason: r.revoked_reason,
});

export class AgentConnectionsRepo {
  constructor(private readonly db: Database) {}

  insert(i: { integrationId: number; name: string; method: ConnectionMethod; expiresAt: string | null; createdBy: string; createdAt: Date }): number {
    return Number(this.db.prepare(
      'INSERT INTO agent_connections (integration_id, name, method, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(i.integrationId, i.name, i.method, i.expiresAt, i.createdAt.toISOString(), i.createdBy).lastInsertRowid);
  }

  get(id: number): AgentConnectionRow | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM agent_connections WHERE id = ?`).get(id) as RawConnection | undefined;
    return row ? toRow(row) : undefined;
  }

  listForIntegration(integrationId: number): AgentConnectionRow[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM agent_connections WHERE integration_id = ? ORDER BY id`).all(integrationId) as RawConnection[])
      .map(toRow);
  }

  /** Nowy kod zastępuje poprzedni i czyści znacznik użycia, także dla połączenia już aktywnego. */
  setCode(id: number, codeHash: string, expiresAt: string): void {
    this.db.prepare('UPDATE agent_connections SET code_hash = ?, code_expires_at = ?, code_used_at = NULL WHERE id = ?').run(codeHash, expiresAt, id);
  }

  findByCodeHash(hash: string): AgentConnectionRow | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM agent_connections WHERE code_hash = ?`).get(hash) as RawConnection | undefined;
    return row ? toRow(row) : undefined;
  }

  /** W jednej transakcji: znacznik użycia, klient, usunięcie wszystkich tokenów OAuth połączenia. */
  useCode(id: number, client: { clientId: string; clientName: string }, at: Date): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE agent_connections SET code_used_at = ?, client_id = ?, client_name = ? WHERE id = ?')
        .run(at.toISOString(), client.clientId, client.clientName, id);
      this.db.prepare('DELETE FROM oauth_tokens WHERE connection_id = ?').run(id);
    })();
  }

  /** Nowy token połączenia nadpisuje poprzedni skrót, więc stary token przestaje działać. */
  setToken(id: number, tokenHash: string): void {
    this.db.prepare('UPDATE agent_connections SET token_hash = ? WHERE id = ?').run(tokenHash, id);
  }

  findByTokenHash(hash: string): AgentConnectionRow | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM agent_connections WHERE token_hash = ?`).get(hash) as RawConnection | undefined;
    return row ? toRow(row) : undefined;
  }

  touch(id: number, at: Date): void {
    this.db.prepare('UPDATE agent_connections SET last_used_at = ? WHERE id = ?').run(at.toISOString(), id);
  }

  /** Odwołanie zapisuje powód i usuwa tokeny OAuth połączenia. */
  revoke(id: number, reason: 'admin' | 'reuse', at: Date): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE agent_connections SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(at.toISOString(), reason, id);
      this.db.prepare('DELETE FROM oauth_tokens WHERE connection_id = ?').run(id);
    })();
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM agent_connections WHERE id = ?').run(id);
  }

  /**
   * Połączenia w użyciu: z użytym kodem, z klientem OAuth z wcześniejszego użycia kodu albo z tokenem, bez odwołanych
   * i wygasłych. Po terminie klucza API wszystkie połączenia integracji są wygasłe, tak jak w `connectionState`.
   */
  countActive(integrationId: number, keyExpiresAt: string | null, now: Date): number {
    if (keyExpiresAt !== null && Date.parse(keyExpiresAt) <= now.getTime()) return 0;
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM agent_connections
       WHERE integration_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND (code_used_at IS NOT NULL OR client_id IS NOT NULL OR token_hash IS NOT NULL)`,
    ).get(integrationId, now.toISOString()) as { n: number }).n;
  }
}
