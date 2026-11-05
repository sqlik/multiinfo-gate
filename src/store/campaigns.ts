import type { Database } from 'better-sqlite3';

export interface CampaignRow {
  id: number; apiKeyId: number; name: string; firstSentAt: string; lastSentAt: string; sent: number; opens: number;
  clicks: number; bots: number; linksDisabledAt: string | null; detailsPurgedAt: string | null; createdAt: string;
}

export interface CampaignTargetRow { target: string; collapsed: 0 | 1; recipients: number; opens: number; clicks: number }

interface Raw {
  id: number; api_key_id: number; name: string; first_sent_at: string; last_sent_at: string; sent: number; opens: number;
  clicks: number; bots: number; links_disabled_at: string | null; details_purged_at: string | null; created_at: string;
}

const toRow = (r: Raw): CampaignRow => ({
  id: r.id, apiKeyId: r.api_key_id, name: r.name, firstSentAt: r.first_sent_at, lastSentAt: r.last_sent_at,
  sent: r.sent, opens: r.opens, clicks: r.clicks, bots: r.bots,
  linksDisabledAt: r.links_disabled_at, detailsPurgedAt: r.details_purged_at, createdAt: r.created_at,
});

/**
 * Kampanie skracacza. Liczby zbiorcze są utrzymywane na bieżąco i nie zawierają danych osobowych,
 * dlatego zostają po retencji szczegółów odbiorców.
 */
export class CampaignsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Zwraca identyfikator istniejącej albo nowej kampanii i przesuwa `last_sent_at`. Znacznik „linki wyłączone”
   * pozostaje, dlatego kody kolejnej wysyłki powstają wyłączone, a przywraca je wyłącznie „Włącz linki”.
   * Znacznik usuniętych szczegółów znika, ponieważ kolejna wysyłka tworzy nowe kody i nowych odbiorców.
   */
  open(apiKeyId: number, name: string, at: Date): number {
    const stamp = at.toISOString();
    const row = this.db
      .prepare(`INSERT INTO campaigns (api_key_id, name, first_sent_at, last_sent_at, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (api_key_id, name) DO UPDATE SET last_sent_at = excluded.last_sent_at, details_purged_at = NULL
                RETURNING id`)
      .get(apiKeyId, name, stamp, stamp, stamp) as { id: number };
    return row.id;
  }

  get(id: number): CampaignRow | undefined {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  byName(apiKeyId: number, name: string): CampaignRow | undefined {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE api_key_id = ? AND name = ?').get(apiKeyId, name) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  list(opts: { apiKeyId?: number; offset: number; limit: number }): { rows: CampaignRow[]; hasMore: boolean } {
    const where = opts.apiKeyId === undefined ? '' : ' WHERE api_key_id = ?';
    const params: number[] = opts.apiKeyId === undefined ? [] : [opts.apiKeyId];
    const rows = (this.db
      .prepare(`SELECT * FROM campaigns${where} ORDER BY last_sent_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, opts.limit + 1, opts.offset) as Raw[]).map(toRow);
    return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
  }

  /** Liczba rozsyłek i pojedynczych wiadomości z krótkimi linkami kampanii. */
  sources(id: number): { packages: number; messages: number } {
    return this.db
      .prepare(`SELECT (SELECT COUNT(*) FROM packages WHERE campaign_id = @id) AS packages,
                       (SELECT COUNT(*) FROM messages WHERE campaign_id = @id) AS messages`)
      .get({ id }) as { packages: number; messages: number };
  }

  addSent(id: number, recipients: number): void {
    this.db.prepare('UPDATE campaigns SET sent = sent + ? WHERE id = ?').run(recipients, id);
  }

  /** Kolejny odbiorca adresu docelowego; termin retencji wiersza to najpóźniejszy termin jego kodów. */
  addTarget(id: number, target: string, purgeAfter: string): void {
    this.db
      .prepare(`INSERT INTO campaign_targets (campaign_id, target, collapsed, recipients, purge_after) VALUES (?, ?, 0, 1, ?)
                ON CONFLICT (campaign_id, target, collapsed) DO UPDATE SET
                  recipients = recipients + 1, purge_after = MAX(COALESCE(purge_after, ''), excluded.purge_after)`)
      .run(id, target, purgeAfter);
  }

  /** Wejście w godzinie `YYYY-MM-DDTHH` (UTC); automat liczy się osobno od kliknięć ludzi. */
  countClick(id: number, hour: string, bot: boolean): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE campaigns SET ${bot ? 'bots = bots + 1' : 'clicks = clicks + 1'} WHERE id = ?`).run(id);
      this.db
        .prepare(`INSERT INTO campaign_hours (campaign_id, hour, clicks, bots) VALUES (?, ?, ?, ?)
                  ON CONFLICT (campaign_id, hour) DO UPDATE SET clicks = clicks + excluded.clicks, bots = bots + excluded.bots`)
        .run(id, hour, bot ? 0 : 1, bot ? 1 : 0);
    })();
  }

  countOpen(id: number): void {
    this.db.prepare('UPDATE campaigns SET opens = opens + 1 WHERE id = ?').run(id);
  }

  countTargetOpen(id: number, target: string): void {
    this.db.prepare('UPDATE campaign_targets SET opens = opens + 1 WHERE campaign_id = ? AND target = ? AND collapsed = 0').run(id, target);
  }

  countTargetClick(id: number, target: string): void {
    this.db.prepare('UPDATE campaign_targets SET clicks = clicks + 1 WHERE campaign_id = ? AND target = ? AND collapsed = 0').run(id, target);
  }

  hours(id: number): Array<{ hour: string; clicks: number; bots: number }> {
    return this.db.prepare('SELECT hour, clicks, bots FROM campaign_hours WHERE campaign_id = ? ORDER BY hour').all(id) as Array<{ hour: string; clicks: number; bots: number }>;
  }

  targets(id: number): CampaignTargetRow[] {
    return this.db
      .prepare(`SELECT target, collapsed, recipients, opens, clicks FROM campaign_targets WHERE campaign_id = ?
                ORDER BY recipients DESC, id`)
      .all(id) as CampaignTargetRow[];
  }

  /**
   * Doręczone wśród odbiorców z kodami: wiadomości i odbiorcy rozsyłek z `links > 0`; `reported` false,
   * gdy żadna wysyłka nie zamawiała raportu. Stan pojedynczej wiadomości bramka odpytuje zawsze.
   */
  delivered(id: number): { delivered: number; reported: boolean } {
    const row = this.db
      .prepare(`SELECT
          (SELECT COUNT(*) FROM messages WHERE campaign_id = @id AND status = 'delivered')
          + (SELECT COUNT(*) FROM package_recipients r JOIN packages p ON p.id = r.package_id
              WHERE p.campaign_id = @id AND r.links > 0 AND r.status = 'delivered') AS delivered,
          EXISTS (SELECT 1 FROM messages WHERE campaign_id = @id)
          OR EXISTS (SELECT 1 FROM packages WHERE campaign_id = @id AND delivery_report = 1) AS reported`)
      .get({ id }) as { delivered: number; reported: 0 | 1 };
    return { delivered: row.delivered, reported: row.reported === 1 };
  }

  setLinksDisabled(id: number, at: Date | null): void {
    this.db.prepare('UPDATE campaigns SET links_disabled_at = ? WHERE id = ?').run(at === null ? null : at.toISOString(), id);
  }

  setDetailsPurged(id: number, at: Date): void {
    this.db.prepare('UPDATE campaigns SET details_purged_at = ? WHERE id = ?').run(at.toISOString(), id);
  }

  /** Wiersze z `recipients = 1` i minionym `purge_after` scala w wiersz `collapsed = 1` o celu `pattern(target)`. */
  collapseTargets(now: Date, pattern: (url: string) => string): number {
    return this.db.transaction(() => {
      const due = this.db
        .prepare(`SELECT id, campaign_id, target, opens, clicks FROM campaign_targets
                  WHERE collapsed = 0 AND recipients = 1 AND purge_after < ?`)
        .all(now.toISOString()) as Array<{ id: number; campaign_id: number; target: string; opens: number; clicks: number }>;
      const merge = this.db.prepare(`INSERT INTO campaign_targets (campaign_id, target, collapsed, recipients, opens, clicks)
                                     VALUES (?, ?, 1, 1, ?, ?)
                                     ON CONFLICT (campaign_id, target, collapsed) DO UPDATE SET
                                       recipients = recipients + 1, opens = opens + excluded.opens, clicks = clicks + excluded.clicks`);
      const drop = this.db.prepare('DELETE FROM campaign_targets WHERE id = ?');
      for (const row of due) {
        merge.run(row.campaign_id, pattern(row.target), row.opens, row.clicks);
        drop.run(row.id);
      }
      return due.length;
    })();
  }
}
