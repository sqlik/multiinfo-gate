import type { Database } from 'better-sqlite3';
import type { CertBundle } from '../secrets/pkcs12.ts';
import { decryptSecret, encryptSecret } from '../secrets/crypto.ts';

export interface AccountRow {
  id: number; name: string; baseUrl: string; login: string;
  defaultCountryCode: string; defaultOrig: string | null; storeContent: 0 | 1;
  certCn: string; certIssuerCn: string; certFingerprintSha1: string;
  certNotBefore: string; certNotAfter: string;
  pausedReason: string | null; active: 0 | 1; createdAt: string;
}

export interface AccountSecrets {
  password: string; certPem: string; keyPem: string; caPem: string | null;
}

export interface AccountInput {
  name: string; baseUrl: string; login: string; password: string;
  certPem: string; keyPem: string; caPem: string | null;
  certCn: string; certIssuerCn: string; certFingerprintSha1: string;
  certNotBefore: string; certNotAfter: string;
  defaultCountryCode: string; defaultOrig: string | null;
  storeContent: 0 | 1; serviceIds: string[];
  /** Nadpisy uzgodnione z Polkomtelem. Pominięcie oznacza pusty słownik. */
  origs?: string[];
}

export interface AccountPatch {
  name: string; baseUrl: string;
  /** Pominięte = bez zmiany hasła. */
  password?: string;
  defaultCountryCode: string; storeContent: 0 | 1; serviceIds: string[];
}

/** Kolumny zwracane na zewnątrz. Kolumny z przyrostkiem `_enc` nigdy się tu nie pojawiają. */
const PUBLIC_COLUMNS = `
  id, name, base_url, login, default_country_code, default_orig, store_content,
  cert_cn, cert_issuer_cn, cert_fingerprint_sha1, cert_not_before, cert_not_after,
  paused_reason, active, created_at`;

interface RawAccount {
  id: number; name: string; base_url: string; login: string;
  default_country_code: string; default_orig: string | null; store_content: 0 | 1;
  cert_cn: string; cert_issuer_cn: string; cert_fingerprint_sha1: string;
  cert_not_before: string; cert_not_after: string;
  paused_reason: string | null; active: 0 | 1; created_at: string;
}

function toRow(r: RawAccount): AccountRow {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    login: r.login,
    defaultCountryCode: r.default_country_code,
    defaultOrig: r.default_orig,
    storeContent: r.store_content,
    certCn: r.cert_cn,
    certIssuerCn: r.cert_issuer_cn,
    certFingerprintSha1: r.cert_fingerprint_sha1,
    certNotBefore: r.cert_not_before,
    certNotAfter: r.cert_not_after,
    pausedReason: r.paused_reason,
    active: r.active,
    createdAt: r.created_at,
  };
}

export class AccountsRepo {
  constructor(
    private readonly db: Database,
    private readonly masterKey: Buffer,
  ) {}

  list(): AccountRow[] {
    const rows = this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM accounts ORDER BY name`).all() as RawAccount[];
    return rows.map(toRow);
  }

  get(id: number): AccountRow | undefined {
    const row = this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE id = ?`).get(id) as
      | RawAccount
      | undefined;
    return row ? toRow(row) : undefined;
  }

  /** Jedyne miejsce, w którym sekrety konta wracają w postaci jawnej. */
  getSecrets(id: number, masterKey: Buffer = this.masterKey): AccountSecrets {
    const row = this.db
      .prepare('SELECT password_enc, cert_pem_enc, key_pem_enc, ca_pem_enc FROM accounts WHERE id = ?')
      .get(id) as
      | { password_enc: string; cert_pem_enc: string; key_pem_enc: string; ca_pem_enc: string | null }
      | undefined;
    if (!row) throw new Error(`Nie ma konta o identyfikatorze ${id}`);
    return {
      password: decryptSecret(row.password_enc, masterKey),
      certPem: decryptSecret(row.cert_pem_enc, masterKey),
      keyPem: decryptSecret(row.key_pem_enc, masterKey),
      caPem: row.ca_pem_enc === null ? null : decryptSecret(row.ca_pem_enc, masterKey),
    };
  }

  serviceIds(id: number): string[] {
    const rows = this.db
      .prepare('SELECT service_id FROM account_services WHERE account_id = ? ORDER BY service_id')
      .all(id) as Array<{ service_id: string }>;
    return rows.map((r) => r.service_id);
  }

  /** Słownik nadpisów konta. Pusty oznacza, że nadpisy nie zostały dla niego uruchomione. */
  origs(id: number): string[] {
    const rows = this.db
      .prepare('SELECT orig FROM account_origs WHERE account_id = ? ORDER BY orig')
      .all(id) as Array<{ orig: string }>;
    return rows.map((r) => r.orig);
  }

  /**
   * Kasuje wyłącznie pozycje, które zniknęły ze słownika. Skasowanie całości i wpisanie
   * jej z powrotem wyglądałoby na to samo, ale usunięcie wiersza z `account_origs`
   * kaskaduje na `api_key_origs` - klucze traciłyby wtedy nadpisy przy każdym zapisie,
   * także takim, który niczego nie zmienia.
   */
  setOrigs(id: number, origs: Array<{ orig: string; label: string | null }>): void {
    const replace = this.db.transaction((list: Array<{ orig: string; label: string | null }>) => {
      const keep = list.map((item) => item.orig);
      const placeholders = keep.map(() => '?').join(', ');
      this.db
        .prepare(
          keep.length === 0
            ? 'DELETE FROM account_origs WHERE account_id = ?'
            : `DELETE FROM account_origs WHERE account_id = ? AND orig NOT IN (${placeholders})`,
        )
        .run(id, ...keep);

      const add = this.db.prepare(
        'INSERT INTO account_origs (account_id, orig, label) VALUES (?, ?, ?)\n' +
        '  ON CONFLICT (account_id, orig) DO UPDATE SET label = excluded.label',
      );
      for (const item of list) add.run(id, item.orig, item.label);
    });
    replace(origs);
  }

  /** Nadpis domyślny konta. Wartość musi należeć do słownika - pilnuje tego panel. */
  setDefaultOrig(id: number, orig: string | null): void {
    this.db.prepare('UPDATE accounts SET default_orig = ? WHERE id = ?').run(orig, id);
  }

  insert(input: AccountInput): number {
    const create = this.db.transaction((): number => {
      const info = this.db
        .prepare(
          `INSERT INTO accounts (
             name, base_url, login, password_enc, cert_pem_enc, key_pem_enc, ca_pem_enc,
             cert_cn, cert_issuer_cn, cert_fingerprint_sha1, cert_not_before, cert_not_after,
             default_country_code, default_orig, store_content
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.name,
          input.baseUrl,
          input.login,
          encryptSecret(input.password, this.masterKey),
          encryptSecret(input.certPem, this.masterKey),
          encryptSecret(input.keyPem, this.masterKey),
          input.caPem === null ? null : encryptSecret(input.caPem, this.masterKey),
          input.certCn,
          input.certIssuerCn,
          input.certFingerprintSha1,
          input.certNotBefore,
          input.certNotAfter,
          input.defaultCountryCode,
          input.defaultOrig,
          input.storeContent,
        );
      const id = Number(info.lastInsertRowid);

      const addService = this.db.prepare('INSERT INTO account_services (account_id, service_id) VALUES (?, ?)');
      for (const serviceId of input.serviceIds) addService.run(id, serviceId);

      const addOrig = this.db.prepare('INSERT INTO account_origs (account_id, orig) VALUES (?, ?)');
      for (const orig of input.origs ?? []) addOrig.run(id, orig);

      return id;
    });
    return create();
  }

  /**
   * Edycja konta bez dotykania certyfikatu i loginu. Lista ID usług podmieniana
   * w całości, ale wiersze, które zostają, nie są kasowane i wstawiane na nowo -
   * zapis bez zmian nie ma zostawiać śladu, tak samo jak przy nadpisach.
   */
  update(id: number, patch: AccountPatch): void {
    const run = this.db.transaction(() => {
      this.db
        .prepare('UPDATE accounts SET name = ?, base_url = ?, default_country_code = ?, store_content = ? WHERE id = ?')
        .run(patch.name, patch.baseUrl, patch.defaultCountryCode, patch.storeContent, id);
      if (patch.password !== undefined) {
        this.db
          .prepare('UPDATE accounts SET password_enc = ? WHERE id = ?')
          .run(encryptSecret(patch.password, this.masterKey), id);
      }
      const keep = patch.serviceIds;
      this.db
        .prepare(
          keep.length === 0
            ? 'DELETE FROM account_services WHERE account_id = ?'
            : `DELETE FROM account_services WHERE account_id = ? AND service_id NOT IN (${keep.map(() => '?').join(', ')})`,
        )
        .run(id, ...keep);
      const add = this.db.prepare('INSERT OR IGNORE INTO account_services (account_id, service_id) VALUES (?, ?)');
      for (const serviceId of keep) add.run(id, serviceId);
    });
    run();
  }

  /** Podmienia materiał kryptograficzny konta razem z opisem certyfikatu. */
  updateCertificate(id: number, bundle: CertBundle, masterKey: Buffer = this.masterKey): void {
    this.db
      .prepare(
        `UPDATE accounts SET
           cert_pem_enc = ?, key_pem_enc = ?, ca_pem_enc = ?,
           cert_cn = ?, cert_issuer_cn = ?, cert_fingerprint_sha1 = ?,
           cert_not_before = ?, cert_not_after = ?
         WHERE id = ?`,
      )
      .run(
        encryptSecret(bundle.certPem, masterKey),
        encryptSecret(bundle.keyPem, masterKey),
        bundle.caPem === null ? null : encryptSecret(bundle.caPem, masterKey),
        bundle.cn,
        bundle.issuerCn,
        bundle.fingerprintSha1,
        bundle.notBefore.toISOString(),
        bundle.notAfter.toISOString(),
        id,
      );
  }

  pause(id: number, reason: string): void {
    this.db.prepare('UPDATE accounts SET paused_reason = ?, active = 0 WHERE id = ?').run(reason, id);
  }

  resume(id: number): void {
    this.db.prepare('UPDATE accounts SET paused_reason = NULL, active = 1 WHERE id = ?').run(id);
  }
}
