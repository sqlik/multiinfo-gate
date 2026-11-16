import type { Database } from 'better-sqlite3';
import { shortId } from '../ids.ts';

/** Wysyłka z pliku: jedna albo kilka rozsyłek z odbiorcami jednego pliku. */
export interface FileSendRow {
  id: string;
  apiKeyId: number;
  integrationId: number | null;
  connectionId: number | null;
  requestedBy: string | null;
  name: string;
  recipients: number;
  startAt: string | null;
  createdAt: string;
}

interface RawSend {
  id: string; api_key_id: number; integration_id: number | null; connection_id: number | null; requested_by: string | null; name: string;
  recipients: number; start_at: string | null; created_at: string;
}

export class FileSendsRepo {
  constructor(private readonly db: Database) {}

  /** Zwraca identyfikator `fsd_…` albo podany. */
  insert(row: Omit<FileSendRow, 'id'> & { id?: string }): string {
    const id = row.id ?? shortId('fsd');
    this.db.prepare(`INSERT INTO file_sends (id, api_key_id, integration_id, connection_id, requested_by, name, recipients, start_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, row.apiKeyId, row.integrationId, row.connectionId, row.requestedBy, row.name, row.recipients, row.startAt, row.createdAt);
    return id;
  }

  get(id: string): FileSendRow | undefined {
    const r = this.db.prepare('SELECT * FROM file_sends WHERE id = ?').get(id) as RawSend | undefined;
    if (!r) return undefined;
    return {
      id: r.id, apiKeyId: r.api_key_id, integrationId: r.integration_id, connectionId: r.connection_id, requestedBy: r.requested_by, name: r.name,
      recipients: r.recipients, startAt: r.start_at, createdAt: r.created_at,
    };
  }
}
