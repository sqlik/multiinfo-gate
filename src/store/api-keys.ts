import type { Database } from 'better-sqlite3';
import { decryptSecret, encryptSecret } from '../secrets/crypto.ts';

export interface ApiKeyRow {
  id: number; accountId: number; name: string; keyHash: string; keyPrefix: string;
  defaultServiceId: string | null; defaultOrig: string | null;
  maxParts: number; ratePerMin: number;
  webhookUrl: string | null; lastUsedAt: string | null; revokedAt: string | null;
  /** Chwila UTC końca ważności (koniec dnia w czasie polskim); `null` to klucz bezterminowy. */
  expiresAt: string | null;
  createdAt: string; allowedServiceIds: string[];
  /** Nadpisy, których klucz może użyć jawnie, poza swoją wartością domyślną. */
  allowedOrigs: string[];
}

export interface ApiKeyInput {
  accountId: number; name: string; keyHash: string; keyPrefix: string;
  defaultServiceId: string | null; defaultOrig: string | null;
  maxParts: number; ratePerMin: number;
  webhookUrl: string | null; webhookSecret: string | null; serviceIds: string[];
  /** Podzbiór słownika konta. Pominięcie oznacza brak dodatkowych uprawnień. */
  origs?: string[];
  /** Pominięcie albo `null` oznacza klucz bezterminowy. */
  expiresAt?: string | null;
}

export interface ApiKeyPatch {
  name: string; defaultServiceId: string | null; defaultOrig: string | null;
  maxParts: number; ratePerMin: number; webhookUrl: string | null;
  /** Pominięty = bez zmiany; `null` = kasuje; tekst = nowy sekret. */
  webhookSecret?: string | null;
  expiresAt: string | null; serviceIds: string[]; origs: string[];
}

/** Kolumna `webhook_secret_enc` nie jest tu wymieniona - sekret nie opuszcza bazy. */
const PUBLIC_COLUMNS = `
  id, account_id, name, key_hash, key_prefix, default_service_id, default_orig,
  max_parts, rate_per_min, webhook_url, last_used_at, revoked_at, expires_at, created_at`;

interface RawApiKey {
  id: number; account_id: number; name: string; key_hash: string; key_prefix: string;
  default_service_id: string | null; default_orig: string | null;
  max_parts: number; rate_per_min: number;
  webhook_url: string | null; last_used_at: string | null; revoked_at: string | null;
  expires_at: string | null; created_at: string;
}

export class ApiKeysRepo {
  constructor(
    private readonly db: Database,
    private readonly masterKey: Buffer,
  ) {}

  private toRow(r: RawApiKey): ApiKeyRow {
    return {
      id: r.id,
      accountId: r.account_id,
      name: r.name,
      keyHash: r.key_hash,
      keyPrefix: r.key_prefix,
      defaultServiceId: r.default_service_id,
      defaultOrig: r.default_orig,
      maxParts: r.max_parts,
      ratePerMin: r.rate_per_min,
      webhookUrl: r.webhook_url,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      allowedServiceIds: this.serviceIds(r.id),
      allowedOrigs: this.origs(r.id),
    };
  }

  private serviceIds(apiKeyId: number): string[] {
    const rows = this.db
      .prepare('SELECT service_id FROM api_key_services WHERE api_key_id = ? ORDER BY service_id')
      .all(apiKeyId) as Array<{ service_id: string }>;
    return rows.map((r) => r.service_id);
  }

  private origs(apiKeyId: number): string[] {
    const rows = this.db
      .prepare('SELECT orig FROM api_key_origs WHERE api_key_id = ? ORDER BY orig')
      .all(apiKeyId) as Array<{ orig: string }>;
    return rows.map((r) => r.orig);
  }

  list(): ApiKeyRow[] {
    const rows = this.db
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_keys ORDER BY created_at DESC`)
      .all() as RawApiKey[];
    return rows.map((r) => this.toRow(r));
  }

  get(id: number): ApiKeyRow | undefined {
    const row = this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE id = ?`).get(id) as RawApiKey | undefined;
    return row ? this.toRow(row) : undefined;
  }

  /**
   * Zwraca wszystkie klucze o danym prefiksie, także odwołane. Rozstrzygnięcie,
   * czy klucz wolno użyć, należy do uwierzytelniania - dzięki temu odróżnia ono
   * klucz nieznany od odwołanego.
   */
  findByPrefix(prefix: string): ApiKeyRow[] {
    const rows = this.db
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE key_prefix = ?`)
      .all(prefix) as RawApiKey[];
    return rows.map((r) => this.toRow(r));
  }

  insert(input: ApiKeyInput): number {
    const create = this.db.transaction((): number => {
      const info = this.db
        .prepare(
          `INSERT INTO api_keys (
             account_id, name, key_hash, key_prefix, default_service_id, default_orig,
             max_parts, rate_per_min, webhook_url, webhook_secret_enc, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.accountId,
          input.name,
          input.keyHash,
          input.keyPrefix,
          input.defaultServiceId,
          input.defaultOrig,
          input.maxParts,
          input.ratePerMin,
          input.webhookUrl,
          input.webhookSecret === null ? null : encryptSecret(input.webhookSecret, this.masterKey),
          input.expiresAt ?? null,
        );
      const id = Number(info.lastInsertRowid);

      const addService = this.db.prepare('INSERT INTO api_key_services (api_key_id, service_id) VALUES (?, ?)');
      for (const serviceId of input.serviceIds) addService.run(id, serviceId);

      const addOrig = this.db.prepare(
        'INSERT INTO api_key_origs (api_key_id, account_id, orig) VALUES (?, ?, ?)',
      );
      for (const orig of input.origs ?? []) addOrig.run(id, input.accountId, orig);

      return id;
    });
    return create();
  }

  /** Zapis edycji klucza w jednej transakcji: pola, lista ID usług, lista nadpisów. */
  update(id: number, patch: ApiKeyPatch): void {
    const run = this.db.transaction(() => {
      const row = this.get(id);
      if (!row) throw new Error(`Nie ma klucza o identyfikatorze ${id}`);
      this.db
        .prepare(
          `UPDATE api_keys SET name = ?, default_service_id = ?, default_orig = ?, max_parts = ?,
             rate_per_min = ?, webhook_url = ?, expires_at = ? WHERE id = ?`,
        )
        .run(
          patch.name,
          patch.defaultServiceId,
          patch.defaultOrig,
          patch.maxParts,
          patch.ratePerMin,
          patch.webhookUrl,
          patch.expiresAt,
          id,
        );
      if (patch.webhookSecret !== undefined) {
        this.db
          .prepare('UPDATE api_keys SET webhook_secret_enc = ? WHERE id = ?')
          .run(patch.webhookSecret === null ? null : encryptSecret(patch.webhookSecret, this.masterKey), id);
      }
      this.db.prepare('DELETE FROM api_key_services WHERE api_key_id = ?').run(id);
      const addService = this.db.prepare('INSERT INTO api_key_services (api_key_id, service_id) VALUES (?, ?)');
      for (const serviceId of patch.serviceIds) addService.run(id, serviceId);
      this.db.prepare('DELETE FROM api_key_origs WHERE api_key_id = ?').run(id);
      const addOrig = this.db.prepare('INSERT INTO api_key_origs (api_key_id, account_id, orig) VALUES (?, ?, ?)');
      for (const orig of patch.origs) addOrig.run(id, row.accountId, orig);
    });
    run();
  }

  /**
   * ID usług, z których korzystają czynne klucze konta (lista albo wartość domyślna),
   * z nazwami tych kluczy. Panel nie pozwala odebrać kontu usługi, która tu figuruje.
   */
  serviceIdsInUse(accountId: number): Map<string, string[]> {
    const used = new Map<string, Set<string>>();
    const note = (serviceId: string | null, name: string) => {
      if (serviceId === null) return;
      if (!used.has(serviceId)) used.set(serviceId, new Set());
      used.get(serviceId)!.add(name);
    };
    for (const key of this.list()) {
      if (key.accountId !== accountId || key.revokedAt !== null) continue;
      note(key.defaultServiceId, key.name);
      for (const serviceId of key.allowedServiceIds) note(serviceId, key.name);
    }
    return new Map([...used].map(([serviceId, names]) => [serviceId, [...names].sort()]));
  }

  revoke(id: number): void {
    this.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
  }

  /** Sekret w postaci jawnej - wyłącznie do podpisania webhooka. Nie zapisywać nigdzie indziej. */
  webhookSecret(id: number): string | null {
    const row = this.db.prepare('SELECT webhook_secret_enc FROM api_keys WHERE id = ?').get(id) as
      | { webhook_secret_enc: string | null } | undefined;
    if (!row?.webhook_secret_enc) return null;
    return decryptSecret(row.webhook_secret_enc, this.masterKey);
  }

  /** Zmiana adresu idzie zawsze w parze z nowym sekretem; pusty adres wyłącza webhook. */
  setWebhook(id: number, url: string | null, secret: string | null): void {
    this.db
      .prepare('UPDATE api_keys SET webhook_url = ?, webhook_secret_enc = ? WHERE id = ?')
      .run(url, secret === null ? null : encryptSecret(secret, this.masterKey), id);
  }

  /** Odnotowuje użycie klucza. Wywoływane po każdym udanym uwierzytelnieniu. */
  touch(id: number): void {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }
}
