import type { Database } from 'better-sqlite3';

export interface ShortLinkRow {
  code: string; domainId: number; apiKeyId: number; campaignId: number; target: string; utm: 0 | 1; recipientKey: string;
  messageId: string | null; packageId: string | null; seq: number | null; dest: string; clientId: string | null;
  clicks: number; botClicks: number; firstOpenedAt: string | null; lastClickedAt: string | null;
  expiresAt: string; disabledAt: string | null; purgeAfter: string; createdAt: string;
}

export type ShortLinkInput = Omit<ShortLinkRow, 'clicks' | 'botClicks' | 'firstOpenedAt' | 'lastClickedAt' | 'disabledAt'>;

interface Raw {
  code: string; domain_id: number; api_key_id: number; campaign_id: number; target: string; utm: 0 | 1; recipient_key: string;
  message_id: string | null; package_id: string | null; seq: number | null; dest: string; client_id: string | null;
  clicks: number; bot_clicks: number; first_opened_at: string | null; last_clicked_at: string | null;
  expires_at: string; disabled_at: string | null; purge_after: string; created_at: string;
}

const toRow = (r: Raw): ShortLinkRow => ({
  code: r.code, domainId: r.domain_id, apiKeyId: r.api_key_id, campaignId: r.campaign_id, target: r.target, utm: r.utm,
  recipientKey: r.recipient_key, messageId: r.message_id, packageId: r.package_id, seq: r.seq, dest: r.dest, clientId: r.client_id,
  clicks: r.clicks, botClicks: r.bot_clicks, firstOpenedAt: r.first_opened_at, lastClickedAt: r.last_clicked_at,
  expiresAt: r.expires_at, disabledAt: r.disabled_at, purgeAfter: r.purge_after, createdAt: r.created_at,
});

/** Krótkie kody skracacza: jeden na wystąpienie linku u odbiorcy, bez adresu IP i nagłówka User-Agent wejścia. */
export class ShortLinksRepo {
  constructor(private readonly db: Database) {}

  insert(row: ShortLinkInput): void {
    this.db
      .prepare(`INSERT INTO short_links (code, domain_id, api_key_id, campaign_id, target, utm, recipient_key, message_id, package_id,
                  seq, dest, client_id, expires_at, purge_after, created_at)
                VALUES (@code, @domainId, @apiKeyId, @campaignId, @target, @utm, @recipientKey, @messageId, @packageId,
                  @seq, @dest, @clientId, @expiresAt, @purgeAfter, @createdAt)`)
      .run(row);
  }

  get(code: string): ShortLinkRow | undefined {
    const row = this.db.prepare('SELECT * FROM short_links WHERE code = ?').get(code) as Raw | undefined;
    return row ? toRow(row) : undefined;
  }

  exists(code: string): boolean {
    return this.db.prepare('SELECT 1 FROM short_links WHERE code = ?').get(code) !== undefined;
  }

  /** Kliknięcie: liczniki kodu; zwraca `firstOpen` true przy pierwszym wejściu niebędącym automatem. */
  click(code: string, at: Date, bot: boolean): { firstOpen: boolean } {
    if (bot) {
      this.db.prepare('UPDATE short_links SET bot_clicks = bot_clicks + 1 WHERE code = ?').run(code);
      return { firstOpen: false };
    }
    const stamp = at.toISOString();
    const before = this.db
      .prepare(`UPDATE short_links SET clicks = clicks + 1, last_clicked_at = @stamp, first_opened_at = COALESCE(first_opened_at, @stamp)
                WHERE code = @code RETURNING clicks`)
      .get({ code, stamp }) as { clicks: number } | undefined;
    return { firstOpen: before?.clicks === 1 };
  }

  /** Czy ten odbiorca otworzył już inny kod kampanii (opcjonalnie: o tym samym celu). */
  recipientOpenedOther(campaignId: number, recipientKey: string, code: string, target?: string): boolean {
    const sameTarget = target === undefined ? '' : ' AND target = @target';
    return this.db
      .prepare(`SELECT 1 FROM short_links WHERE campaign_id = @campaignId AND recipient_key = @recipientKey AND code <> @code
                AND first_opened_at IS NOT NULL${sameTarget} LIMIT 1`)
      .get({ campaignId, recipientKey, code, ...(target === undefined ? {} : { target }) }) !== undefined;
  }

  disableCampaign(campaignId: number, at: Date): number {
    return this.db.prepare('UPDATE short_links SET disabled_at = ? WHERE campaign_id = ? AND disabled_at IS NULL')
      .run(at.toISOString(), campaignId).changes;
  }

  /** Przywraca kody kampanii z pominięciem kodów anulowanych wiadomości, które pozostają wyłączone. */
  enableCampaign(campaignId: number): number {
    return this.db
      .prepare(`UPDATE short_links SET disabled_at = NULL WHERE campaign_id = ? AND disabled_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = short_links.message_id AND m.status = 'cancelled')`)
      .run(campaignId).changes;
  }

  disableMessage(messageId: string, at: Date): number {
    return this.db.prepare('UPDATE short_links SET disabled_at = ? WHERE message_id = ? AND disabled_at IS NULL')
      .run(at.toISOString(), messageId).changes;
  }

  forMessage(messageId: string): ShortLinkRow[] {
    return (this.db.prepare('SELECT * FROM short_links WHERE message_id = ? ORDER BY rowid').all(messageId) as Raw[]).map(toRow);
  }

  forPackageRecipient(packageId: string, seq: number): ShortLinkRow[] {
    return (this.db.prepare('SELECT * FROM short_links WHERE package_id = ? AND seq = ? ORDER BY rowid').all(packageId, seq) as Raw[]).map(toRow);
  }

  /** Kody rozsyłki w skrócie, do odpowiedzi na powtórzone żądanie; brak kodów daje `undefined`. */
  packageSummary(packageId: string): { count: number; domainId: number; campaignId: number; expiresAt: string } | undefined {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count, MIN(domain_id) AS domain_id, MIN(campaign_id) AS campaign_id, MIN(expires_at) AS expires_at
                FROM short_links WHERE package_id = ?`)
      .get(packageId) as { count: number; domain_id: number | null; campaign_id: number | null; expires_at: string | null };
    if (row.count === 0 || row.domain_id === null || row.campaign_id === null || row.expires_at === null) return undefined;
    return { count: row.count, domainId: row.domain_id, campaignId: row.campaign_id, expiresAt: row.expires_at };
  }

  /**
   * Kody kampanii w skrócie: domena najnowszego kodu, najpóźniejsze wygaśnięcie i dopisywanie UTM przez
   * którykolwiek kod. Kampania bez kodów, na przykład po retencji, daje `undefined`.
   */
  campaignSummary(campaignId: number): { domain: string; expiresAt: string; utm: boolean } | undefined {
    const row = this.db
      .prepare(`SELECT (SELECT d.domain FROM short_links s JOIN link_domains d ON d.id = s.domain_id WHERE s.campaign_id = @id
                        ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1) AS domain,
                       MAX(expires_at) AS expires_at, MAX(utm) AS utm
                FROM short_links WHERE campaign_id = @id`)
      .get({ id: campaignId }) as { domain: string | null; expires_at: string | null; utm: 0 | 1 | null };
    if (row.domain === null || row.expires_at === null) return undefined;
    return { domain: row.domain, expiresAt: row.expires_at, utm: row.utm === 1 };
  }

  /** Liczby rozsyłki z jej kodów: odbiorcy z otwarciem i kliknięcia ludzi; rozsyłka bez kodów daje `undefined`. */
  packageStats(packageId: string): {
    count: number; opens: number; clicks: number; firstOpenedAt: string | null; domain: string; expiresAt: string;
  } | undefined {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count, COUNT(DISTINCT CASE WHEN s.first_opened_at IS NOT NULL THEN s.recipient_key END) AS opens,
                  COALESCE(SUM(s.clicks), 0) AS clicks, MIN(s.first_opened_at) AS first_opened_at, MIN(d.domain) AS domain,
                  MAX(s.expires_at) AS expires_at
                FROM short_links s JOIN link_domains d ON d.id = s.domain_id WHERE s.package_id = ?`)
      .get(packageId) as {
        count: number; opens: number; clicks: number; first_opened_at: string | null; domain: string | null; expires_at: string | null;
      };
    if (row.count === 0 || row.domain === null || row.expires_at === null) return undefined;
    return {
      count: row.count, opens: row.opens, clicks: row.clicks, firstOpenedAt: row.first_opened_at, domain: row.domain, expiresAt: row.expires_at,
    };
  }

  /** Odbiorcy z otwarciem, zgrupowani po `recipient_key`, od najnowszego kliknięcia. */
  openers(campaignId: number, offset: number, limit: number): Array<{
    dest: string; clientId: string | null; firstOpenedAt: string; lastClickedAt: string; clicks: number; targets: string[];
  }> {
    const rows = this.db
      .prepare(`SELECT MIN(dest) AS dest, MIN(client_id) AS client_id, MIN(first_opened_at) AS first_opened_at,
                  MAX(last_clicked_at) AS last_clicked_at, SUM(clicks) AS clicks, json_group_array(DISTINCT target) AS targets
                FROM short_links WHERE campaign_id = ? AND first_opened_at IS NOT NULL
                GROUP BY recipient_key ORDER BY MAX(last_clicked_at) DESC, recipient_key LIMIT ? OFFSET ?`)
      .all(campaignId, limit, offset) as Array<{
        dest: string; client_id: string | null; first_opened_at: string; last_clicked_at: string; clicks: number; targets: string;
      }>;
    return rows.map((r) => ({
      dest: r.dest, clientId: r.client_id, firstOpenedAt: r.first_opened_at, lastClickedAt: r.last_clicked_at, clicks: r.clicks,
      targets: (JSON.parse(r.targets) as string[]).sort(),
    }));
  }

  remaining(campaignId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM short_links WHERE campaign_id = ?').get(campaignId) as { n: number }).n;
  }

  /** Najpóźniejszy termin retencji kodów domeny; do tej chwili domena nie może zostać usunięta. */
  domainPurgeAfter(domainId: number): string | null {
    return (this.db.prepare('SELECT MAX(purge_after) AS last FROM short_links WHERE domain_id = ?').get(domainId) as { last: string | null }).last;
  }

  /** Usuwa kody z minionym `purge_after`; zwraca identyfikatory kampanii, których kody zniknęły. */
  purge(now: Date): number[] {
    return this.db.transaction(() => {
      const stamp = now.toISOString();
      const campaigns = (this.db.prepare('SELECT DISTINCT campaign_id FROM short_links WHERE purge_after < ? ORDER BY campaign_id')
        .all(stamp) as Array<{ campaign_id: number }>).map((r) => r.campaign_id);
      this.db.prepare('DELETE FROM short_links WHERE purge_after < ?').run(stamp);
      return campaigns;
    })();
  }
}
