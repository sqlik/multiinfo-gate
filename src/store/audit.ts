import type { Database } from 'better-sqlite3';

export interface AuditEntry {
  actor: string; action: string; target?: string;
  meta?: Record<string, unknown>; ip?: string;
}

interface RawAudit {
  actor: string; action: string; target: string | null;
  meta: string | null; ip: string | null; at: string;
}

/**
 * Dziennik zdarzeń panelu. Wpisów nie da się zmienić ani usunąć - repozytorium
 * nie udostępnia takich metod, a `meta` nie może zawierać sekretów.
 */
export class AuditRepo {
  constructor(private readonly db: Database) {}

  record(entry: AuditEntry): void {
    this.db
      .prepare('INSERT INTO audit_log (actor, action, target, meta, ip) VALUES (?, ?, ?, ?, ?)')
      .run(
        entry.actor,
        entry.action,
        entry.target ?? null,
        entry.meta ? JSON.stringify(entry.meta) : null,
        entry.ip ?? null,
      );
  }

  list(limit: number, offset: number): Array<AuditEntry & { at: string }> {
    const rows = this.db
      .prepare('SELECT actor, action, target, meta, ip, at FROM audit_log ORDER BY at DESC, id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as RawAudit[];
    return rows.map((r) => ({
      actor: r.actor,
      action: r.action,
      ...(r.target !== null ? { target: r.target } : {}),
      ...(r.meta !== null ? { meta: JSON.parse(r.meta) as Record<string, unknown> } : {}),
      ...(r.ip !== null ? { ip: r.ip } : {}),
      at: r.at,
    }));
  }
}
