import type { Database } from 'better-sqlite3';

export type InboundKind = 'text' | 'binary';

export interface InboundRow {
  id: string; accountId: number; serviceId: string; miId: string; sender: string; dest: string;
  kind: InboundKind; body: string | null; bodyHash: string;
  protocolId: number; codingScheme: number; connectorId: string | null;
  relatedMessageId: string | null; receivedAt: string; createdAt: string;
  /** Identyfikator zgłoszenia zwrócony przez obcą aplikację i integracja wychodząca, która go pozyskała. */
  externalRef: string | null; externalIntegrationId: number | null;
}

/** Odebrana wiadomość przy zapisie: identyfikator zgłoszenia dochodzi później, po dostawie. */
export type InboundInput = Omit<InboundRow, 'externalRef' | 'externalIntegrationId'>;

export interface InboundFilter {
  accountId?: number;
  /** Usługi, do których pytający ma dostęp; pusta lista to pusta odpowiedź, brak pola nie zawęża. */
  serviceIds?: string[];
  sender?: string; since?: string; until?: string;
  limit: number; offset: number;
}

interface Raw {
  id: string; account_id: number; service_id: string; mi_id: string; sender: string; dest: string;
  kind: InboundKind; body: string | null; body_hash: string;
  protocol_id: number; coding_scheme: number; connector_id: string | null;
  related_message_id: string | null; received_at: string; created_at: string;
  external_ref: string | null; external_integration_id: number | null;
}

const toRow = (r: Raw): InboundRow => ({
  id: r.id, accountId: r.account_id, serviceId: r.service_id, miId: r.mi_id, sender: r.sender, dest: r.dest,
  kind: r.kind, body: r.body, bodyHash: r.body_hash, protocolId: r.protocol_id, codingScheme: r.coding_scheme,
  connectorId: r.connector_id, relatedMessageId: r.related_message_id, receivedAt: r.received_at, createdAt: r.created_at,
  externalRef: r.external_ref, externalIntegrationId: r.external_integration_id,
});

/** Wiadomości przychodzące od abonentów, odebrane z Multiinfo. */
export class InboundMessagesRepo {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Wstawia wiadomość, chyba że para (konto, identyfikator MI) już jest - wtedy nic nie robi
   * i zwraca fałsz. Tak wraca wiadomość niepotwierdzona w Multiinfo po ok. 9 minutach.
   */
  insertIfNew(i: InboundInput): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbound_messages (
           id, account_id, service_id, mi_id, sender, dest, kind, body, body_hash,
           protocol_id, coding_scheme, connector_id, related_message_id, received_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.id, i.accountId, i.serviceId, i.miId, i.sender, i.dest, i.kind, i.body, i.bodyHash,
        i.protocolId, i.codingScheme, i.connectorId, i.relatedMessageId, i.receivedAt, i.createdAt,
      );
    return info.changes === 1;
  }

  get(id: string): InboundRow | undefined {
    const row = this.db.prepare('SELECT * FROM inbound_messages WHERE id = ?').get(id) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  list(f: InboundFilter): InboundRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (f.accountId !== undefined) { where.push('account_id = ?'); params.push(f.accountId); }
    if (f.serviceIds !== undefined) {
      if (f.serviceIds.length === 0) return [];
      where.push(`service_id IN (${f.serviceIds.map(() => '?').join(', ')})`);
      params.push(...f.serviceIds);
    }
    if (f.sender !== undefined) { where.push('sender = ?'); params.push(f.sender); }
    if (f.since !== undefined) { where.push('received_at >= ?'); params.push(f.since); }
    if (f.until !== undefined) { where.push('received_at <= ?'); params.push(f.until); }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM inbound_messages${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, f.limit, f.offset) as Raw[];
    return rows.map(toRow);
  }

  /** Identyfikator zgłoszenia z odpowiedzi obcej aplikacji - pozwala potem wysłać odpowiedź agenta w wątku. */
  setExternalRef(id: string, integrationId: number, ref: string): void {
    this.db.prepare('UPDATE inbound_messages SET external_ref = ?, external_integration_id = ? WHERE id = ?')
      .run(ref.slice(0, 200), integrationId, id);
  }

  /** Najnowsza odebrana z tym identyfikatorem zgłoszenia, pozyskanym przez integrację tego klucza. */
  findByExternalRefForKey(apiKeyId: number, ref: string): InboundRow | undefined {
    const row = this.db.prepare(
      `SELECT im.* FROM inbound_messages im JOIN integrations i ON i.id = im.external_integration_id
        WHERE i.api_key_id = ? AND im.external_ref = ? ORDER BY im.created_at DESC, im.id DESC LIMIT 1`,
    ).get(apiKeyId, ref) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  countSince(since: Date): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM inbound_messages WHERE created_at >= ?')
      .get(since.toISOString()) as { n: number };
    return row.n;
  }
}
