import type { Database } from 'better-sqlite3';

export type DownloadKind = 'package_report' | 'package_failed' | 'campaign_opened' | 'campaign_unopened';

/** Linki do pobrania raportów i list CSV dla agentów AI. Bramka przechowuje wyłącznie skrót tokenu z adresu. */
export class DownloadLinksRepo {
  constructor(private readonly db: Database) {}

  insert(hash: string, l: { apiKeyId: number; kind: DownloadKind; ref: string; createdAt: Date; expiresAt: Date }): void {
    this.db.prepare('INSERT INTO download_links (token_hash, api_key_id, kind, ref, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash, l.apiKeyId, l.kind, l.ref, l.createdAt.toISOString(), l.expiresAt.toISOString());
  }

  /** Link po terminie daje undefined, także zanim sprzątanie usunie go z bazy. */
  get(hash: string, now: Date): { apiKeyId: number; kind: DownloadKind; ref: string } | undefined {
    const row = this.db.prepare('SELECT api_key_id, kind, ref FROM download_links WHERE token_hash = ? AND expires_at > ?')
      .get(hash, now.toISOString()) as { api_key_id: number; kind: DownloadKind; ref: string } | undefined;
    return row ? { apiKeyId: row.api_key_id, kind: row.kind, ref: row.ref } : undefined;
  }

  pruneBefore(at: Date): number {
    return this.db.prepare('DELETE FROM download_links WHERE expires_at < ?').run(at.toISOString()).changes;
  }
}
