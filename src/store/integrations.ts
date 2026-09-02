import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { decryptSecret, encryptSecret } from '../secrets/crypto.ts';
import {
  parseConfig, type InboundConfig, type IntegrationConfig, type IntegrationKind, type IntegrationSecrets,
  type OutboundConfig, type OutboundEvent,
} from '../integrations/config.ts';

export interface IntegrationRow {
  id: number; name: string; kind: IntegrationKind; apiKeyId: number; serviceId: string | null; orig: string | null;
  preset: string; enabled: 0 | 1; hookId: string | null; config: IntegrationConfig; storePayloads: 0 | 1;
  lastEventAt: string | null; createdAt: string; updatedAt: string;
}

export interface IntegrationInput {
  name: string; kind: IntegrationKind; apiKeyId: number; serviceId: string | null; orig: string | null; preset: string;
  enabled: 0 | 1; config: IntegrationConfig; secrets: IntegrationSecrets; storePayloads: 0 | 1; createdAt: Date;
}

export interface IntegrationPatch {
  name: string; serviceId: string | null; orig: string | null; preset: string; enabled: 0 | 1;
  config: IntegrationConfig; storePayloads: 0 | 1;
  /** Pominięte = bez zmian; klucz z pustą wartością usuwa ten sekret; inne nadpisują. */
  secrets?: IntegrationSecrets;
}

interface Raw {
  id: number; name: string; kind: IntegrationKind; api_key_id: number; service_id: string | null; orig: string | null;
  preset: string; enabled: 0 | 1; hook_id: string | null; config: string; store_payloads: 0 | 1;
  last_event_at: string | null; created_at: string; updated_at: string;
}

/** Kolumna `secrets_enc` nie jest tu wymieniona - sekrety nie opuszczają bazy poza `secrets()`. */
const COLUMNS = 'id, name, kind, api_key_id, service_id, orig, preset, enabled, hook_id, config, store_payloads, last_event_at, created_at, updated_at';

const toRow = (r: Raw): IntegrationRow => ({
  id: r.id, name: r.name, kind: r.kind, apiKeyId: r.api_key_id, serviceId: r.service_id, orig: r.orig, preset: r.preset,
  enabled: r.enabled, hookId: r.hook_id, config: parseConfig(r.kind, JSON.parse(r.config)), storePayloads: r.store_payloads,
  lastEventAt: r.last_event_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

export const isInbound = (r: IntegrationRow): r is IntegrationRow & { config: InboundConfig } => r.kind === 'webhook_in';
export const isOutbound = (r: IntegrationRow): r is IntegrationRow & { config: OutboundConfig } => r.kind === 'webhook_out';

/** 24 bajty losowe = 32 znaki base64url; tyle samo entropii co klucz API. */
export const newHookId = (): string => randomBytes(24).toString('base64url');

/** Warunek SQL: integracja `i` to włączona wychodząca nasłuchująca zdarzenia podanego jako parametr. */
const OUTBOUND_LISTENER_SQL = `i.kind = 'webhook_out' AND i.enabled = 1
          AND EXISTS (SELECT 1 FROM json_each(json_extract(i.config, '$.events')) e WHERE e.value = ?)`;

export class IntegrationsRepo {
  constructor(private readonly db: Database, private readonly masterKey: Buffer) {}

  insert(i: IntegrationInput): number {
    const at = i.createdAt.toISOString();
    const info = this.db.prepare(
      `INSERT INTO integrations (name, kind, api_key_id, service_id, orig, preset, enabled, hook_id, config, secrets_enc, store_payloads, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(i.name, i.kind, i.apiKeyId, i.serviceId, i.orig, i.preset, i.enabled, i.kind === 'webhook_in' ? newHookId() : null,
      JSON.stringify(i.config), this.encrypt(i.secrets), i.storePayloads, at, at);
    return Number(info.lastInsertRowid);
  }

  update(id: number, p: IntegrationPatch, at: Date): void {
    this.db.transaction(() => {
      this.db.prepare(
        'UPDATE integrations SET name = ?, service_id = ?, orig = ?, preset = ?, enabled = ?, config = ?, store_payloads = ?, updated_at = ? WHERE id = ?',
      ).run(p.name, p.serviceId, p.orig, p.preset, p.enabled, JSON.stringify(p.config), p.storePayloads, at.toISOString(), id);
      if (p.secrets !== undefined) {
        const merged = { ...this.secrets(id) };
        for (const [k, v] of Object.entries(p.secrets)) {
          if (v === '') delete merged[k];
          else merged[k] = v;
        }
        this.db.prepare('UPDATE integrations SET secrets_enc = ? WHERE id = ?').run(this.encrypt(merged), id);
      }
    })();
  }

  get(id: number): IntegrationRow | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM integrations WHERE id = ?`).get(id) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  getByHookId(hookId: string): IntegrationRow | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM integrations WHERE hook_id = ?`).get(hookId) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  list(): IntegrationRow[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM integrations ORDER BY name`).all() as Raw[]).map(toRow);
  }

  listForKey(apiKeyId: number): IntegrationRow[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM integrations WHERE api_key_id = ? ORDER BY name`).all(apiKeyId) as Raw[]).map(toRow);
  }

  /** Włączone wychodzące klucza nasłuchujące zdarzenia. Filtr po zdarzeniu w JSON, żeby nie parsować wszystkich. */
  listOutboundFor(apiKeyId: number, event: OutboundEvent): IntegrationRow[] {
    return (this.db.prepare(
      `SELECT ${COLUMNS} FROM integrations i WHERE i.api_key_id = ? AND ${OUTBOUND_LISTENER_SQL} ORDER BY i.name`,
    ).all(apiKeyId, event) as Raw[]).map(toRow);
  }

  /**
   * Klucze konta z dostępem do usługi, które mają włączoną wychodzącą na message.received -
   * drugi (obok subskrypcji klucza) powód, dla którego odbiornik pyta Multiinfo o usługę.
   */
  inboundListenerKeyIds(accountId: number, serviceId: string, now: Date): number[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT k.id FROM api_keys k
         JOIN api_key_services s ON s.api_key_id = k.id AND s.service_id = ?
         JOIN integrations i ON i.api_key_id = k.id AND ${OUTBOUND_LISTENER_SQL}
        WHERE k.account_id = ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)
        ORDER BY k.id`,
    ).all(serviceId, 'message.received', accountId, now.toISOString()) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  setEnabled(id: number, enabled: boolean, at: Date): void {
    this.db.prepare('UPDATE integrations SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, at.toISOString(), id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM integrations WHERE id = ?').run(id);
  }

  regenerateHook(id: number, at: Date): string {
    const hookId = newHookId();
    this.db.prepare('UPDATE integrations SET hook_id = ?, updated_at = ? WHERE id = ?').run(hookId, at.toISOString(), id);
    return hookId;
  }

  /** Sekrety jawnie - wyłącznie do uwierzytelnienia żądania albo złożenia nagłówków. Nie zapisywać nigdzie indziej. */
  secrets(id: number): IntegrationSecrets {
    const row = this.db.prepare('SELECT secrets_enc FROM integrations WHERE id = ?').get(id) as { secrets_enc: string | null } | undefined;
    if (!row?.secrets_enc) return {};
    return JSON.parse(decryptSecret(row.secrets_enc, this.masterKey)) as IntegrationSecrets;
  }

  secretNames(id: number): string[] {
    return Object.keys(this.secrets(id)).sort();
  }

  touch(id: number, at: Date): void {
    this.db.prepare('UPDATE integrations SET last_event_at = ? WHERE id = ?').run(at.toISOString(), id);
  }

  countEnabled(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM integrations WHERE enabled = 1').get() as { n: number }).n;
  }

  /** Integracje z choć jednym wpisem error/rejected/undelivered/throttled od chwili `since` - kafelek przeglądu. */
  countTroubled(since: Date): number {
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT integration_id) AS n FROM integration_events
        WHERE at >= ? AND result IN ('error', 'rejected', 'undelivered', 'throttled')`,
    ).get(since.toISOString()) as { n: number };
    return row.n;
  }

  private encrypt(secrets: IntegrationSecrets): string | null {
    return Object.keys(secrets).length === 0 ? null : encryptSecret(JSON.stringify(secrets), this.masterKey);
  }
}
