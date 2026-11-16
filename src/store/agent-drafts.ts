import type { Database } from 'better-sqlite3';
import { shortId } from '../ids.ts';

export type DraftKind = 'sms' | 'group' | 'reply' | 'file';

/** Szkic wysyłki przygotowany przez agenta: wychodzi dokładnie to, co człowiek widział w podglądzie. */
export interface DraftRow {
  id: string;
  connectionId: number;
  kind: DraftKind;
  payload: unknown;
  createdAt: string;
  expiresAt: string;
  sentAt: string | null;
  result: unknown;
  /** Skrót SHA-256 klucza potwierdzenia; null dla szkicu z sesji bez widoków. */
  confirmHash: string | null;
}

interface RawDraft {
  id: string; connection_id: number; kind: DraftKind; payload: string; created_at: string; expires_at: string; sent_at: string | null; result: string | null; confirm_hash: string | null;
}

export class AgentDraftsRepo {
  constructor(private readonly db: Database) {}

  /** Zwraca identyfikator `drf_…`. */
  insert(d: { connectionId: number; kind: DraftKind; payload: unknown; createdAt: Date; expiresAt: Date; confirmHash?: string | null }): string {
    const id = shortId('drf');
    this.db.prepare('INSERT INTO agent_drafts (id, connection_id, kind, payload, created_at, expires_at, confirm_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, d.connectionId, d.kind, JSON.stringify(d.payload), d.createdAt.toISOString(), d.expiresAt.toISOString(), d.confirmHash ?? null);
    return id;
  }

  /** Szkic innego połączenia daje undefined. Szkic po terminie wraca, żeby wysyłka podała czytelny powód odmowy. */
  get(id: string, connectionId: number): DraftRow | undefined {
    const row = this.db.prepare('SELECT * FROM agent_drafts WHERE id = ? AND connection_id = ?').get(id, connectionId) as RawDraft | undefined;
    if (!row) return undefined;
    return {
      id: row.id, connectionId: row.connection_id, kind: row.kind, payload: JSON.parse(row.payload) as unknown, createdAt: row.created_at,
      expiresAt: row.expires_at, sentAt: row.sent_at, result: row.result === null ? null : JSON.parse(row.result) as unknown,
      confirmHash: row.confirm_hash,
    };
  }

  markSent(id: string, result: unknown, at: Date): void {
    this.db.prepare('UPDATE agent_drafts SET sent_at = ?, result = ? WHERE id = ?').run(at.toISOString(), JSON.stringify(result), id);
  }

  /** Usuwa szkice, których termin minął przed `at`. */
  pruneBefore(at: Date): number {
    return this.db.prepare('DELETE FROM agent_drafts WHERE expires_at < ?').run(at.toISOString()).changes;
  }
}
