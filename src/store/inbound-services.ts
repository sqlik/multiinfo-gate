import type { Database } from 'better-sqlite3';

export interface InboundTarget { accountId: number; serviceId: string }

export interface InboundServiceState {
  serviceId: string; lastPollAt: string | null; lastReceivedAt: string | null; error: string | null;
}

export interface InboundServiceError { accountId: number; accountName: string; serviceId: string; error: string }

/** Stan odbiornika trzymany przy usłudze konta (`account_services`) i wyliczanie, co odpytywać. */
export class InboundServicesRepo {
  constructor(private readonly db: Database) {}

  /**
   * Odbiór zapala subskrypcja: para konto+usługa jest celem, gdy konto jest czynne
   * i niewstrzymane, usługa nadal należy do konta, a choć jeden czynny klucz z webhookiem
   * subskrybuje ją. Bez subskrybentów nie ma po co pytać Multiinfo.
   */
  activeTargets(now: Date): InboundTarget[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.account_id AS account_id, s.service_id AS service_id
           FROM account_services s
           JOIN accounts a ON a.id = s.account_id
           JOIN api_keys k ON k.account_id = s.account_id
           JOIN api_key_services ks ON ks.api_key_id = k.id AND ks.service_id = s.service_id
          WHERE a.active = 1 AND a.paused_reason IS NULL
            AND k.inbound_subscribed = 1 AND k.webhook_url IS NOT NULL AND k.revoked_at IS NULL
            AND (k.expires_at IS NULL OR k.expires_at > ?)
          ORDER BY s.account_id, s.service_id`,
      )
      .all(now.toISOString()) as Array<{ account_id: number; service_id: string }>;
    return rows.map((r) => ({ accountId: r.account_id, serviceId: r.service_id }));
  }

  states(accountId: number): InboundServiceState[] {
    const rows = this.db
      .prepare(
        `SELECT service_id, inbound_last_poll_at, inbound_last_received_at, inbound_error
           FROM account_services WHERE account_id = ? ORDER BY service_id`,
      )
      .all(accountId) as Array<{
        service_id: string; inbound_last_poll_at: string | null; inbound_last_received_at: string | null; inbound_error: string | null;
      }>;
    return rows.map((r) => ({
      serviceId: r.service_id, lastPollAt: r.inbound_last_poll_at, lastReceivedAt: r.inbound_last_received_at, error: r.inbound_error,
    }));
  }

  markPolled(t: InboundTarget, at: Date): void {
    this.db.prepare('UPDATE account_services SET inbound_last_poll_at = ? WHERE account_id = ? AND service_id = ?')
      .run(at.toISOString(), t.accountId, t.serviceId);
  }

  markReceived(t: InboundTarget, at: Date): void {
    this.db.prepare('UPDATE account_services SET inbound_last_received_at = ? WHERE account_id = ? AND service_id = ?')
      .run(at.toISOString(), t.accountId, t.serviceId);
  }

  setError(t: InboundTarget, error: string | null): void {
    this.db.prepare('UPDATE account_services SET inbound_error = ? WHERE account_id = ? AND service_id = ?')
      .run(error, t.accountId, t.serviceId);
  }

  errors(): InboundServiceError[] {
    const rows = this.db
      .prepare(
        `SELECT s.account_id, a.name, s.service_id, s.inbound_error FROM account_services s
           JOIN accounts a ON a.id = s.account_id WHERE s.inbound_error IS NOT NULL ORDER BY a.name, s.service_id`,
      )
      .all() as Array<{ account_id: number; name: string; service_id: string; inbound_error: string }>;
    return rows.map((r) => ({ accountId: r.account_id, accountName: r.name, serviceId: r.service_id, error: r.inbound_error }));
  }
}
