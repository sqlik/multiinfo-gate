import type { Database } from 'better-sqlite3';

export interface LinkDomainRow {
  id: number; domain: string; displayName: string; homeUrl: string | null; bareLinks: 0 | 1; enabled: 0 | 1;
  checkedAt: string | null; checkOk: 0 | 1 | null; checkDetail: string | null; createdAt: string; updatedAt: string;
}

export interface LinkDomainInput { domain: string; displayName: string; homeUrl: string | null; bareLinks: boolean }

interface Raw {
  id: number; domain: string; display_name: string; home_url: string | null; bare_links: 0 | 1; enabled: 0 | 1;
  checked_at: string | null; check_ok: 0 | 1 | null; check_detail: string | null; created_at: string; updated_at: string;
}

const toRow = (r: Raw): LinkDomainRow => ({
  id: r.id, domain: r.domain, displayName: r.display_name, homeUrl: r.home_url, bareLinks: r.bare_links, enabled: r.enabled,
  checkedAt: r.checked_at, checkOk: r.check_ok, checkDetail: r.check_detail, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Nazwa domeny w postaci zapisu: małe litery. Pozostałą normalizację wykonuje usługa domen. */
const key = (domain: string) => domain.toLowerCase();

export class LinkDomainsRepo {
  constructor(private readonly db: Database) {}

  list(): LinkDomainRow[] {
    return (this.db.prepare('SELECT * FROM link_domains ORDER BY domain').all() as Raw[]).map(toRow);
  }

  get(id: number): LinkDomainRow | undefined {
    const row = this.db.prepare('SELECT * FROM link_domains WHERE id = ?').get(id) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  byDomain(domain: string): LinkDomainRow | undefined {
    const row = this.db.prepare('SELECT * FROM link_domains WHERE domain = ?').get(key(domain)) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  create(input: LinkDomainInput, at: Date): number {
    const stamp = at.toISOString();
    const info = this.db
      .prepare(`INSERT INTO link_domains (domain, display_name, home_url, bare_links, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(key(input.domain), input.displayName, input.homeUrl, input.bareLinks ? 1 : 0, stamp, stamp);
    return Number(info.lastInsertRowid);
  }

  update(id: number, input: LinkDomainInput, at: Date): void {
    this.db
      .prepare('UPDATE link_domains SET domain = ?, display_name = ?, home_url = ?, bare_links = ?, updated_at = ? WHERE id = ?')
      .run(key(input.domain), input.displayName, input.homeUrl, input.bareLinks ? 1 : 0, at.toISOString(), id);
  }

  setEnabled(id: number, enabled: boolean, at: Date): void {
    this.db.prepare('UPDATE link_domains SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, at.toISOString(), id);
  }

  setCheck(id: number, ok: boolean, detail: string | null, at: Date): void {
    this.db
      .prepare('UPDATE link_domains SET checked_at = ?, check_ok = ?, check_detail = ? WHERE id = ?')
      .run(at.toISOString(), ok ? 1 : 0, detail, id);
  }

  /** Identyfikatory kluczy z tą domeną; usunięcie domeny przypisanej jest zabronione. */
  keysUsing(id: number): number[] {
    return (this.db
      .prepare(`SELECT api_key_id FROM api_key_link_domains WHERE domain_id = ?
                UNION SELECT id FROM api_keys WHERE link_default_domain_id = ? ORDER BY 1`)
      .all(id, id) as Array<{ api_key_id: number }>).map((r) => r.api_key_id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM link_domains WHERE id = ?').run(id);
  }
}
