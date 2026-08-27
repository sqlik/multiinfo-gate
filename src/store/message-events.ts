import type { Database } from 'better-sqlite3';

export interface MessageEvent { at: string; kind: string; detail: string | null }

/**
 * Przebieg wiadomości: przyjęcie, przekazanie do Multiinfo, zmiany statusu,
 * ponowienia, anulowanie, webhooki. Tylko dopisywanie - panel czyta to jako oś czasu.
 */
export class MessageEventsRepo {
  constructor(private readonly db: Database) {}

  record(messageId: string, at: Date, kind: string, detail: string | null): void {
    this.db
      .prepare('INSERT INTO message_events (message_id, at, kind, detail) VALUES (?, ?, ?, ?)')
      .run(messageId, at.toISOString(), kind, detail);
  }

  list(messageId: string): MessageEvent[] {
    return this.db
      .prepare('SELECT at, kind, detail FROM message_events WHERE message_id = ? ORDER BY id')
      .all(messageId) as MessageEvent[];
  }
}
