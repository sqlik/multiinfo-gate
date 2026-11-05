// Wyniki kampanii skracacza: szczegóły do panelu i API, CSV odbiorców z otwarciem, wyłączenie
// i włączenie linków oraz blok `links` w odczycie wiadomości i rozsyłki. Panel woła usługę z tras
// „Kampanie”, API z `/v1/campaigns`, a w 1.12 także serwer MCP.
import type { PanelUser } from '../m365/service.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { AuditRepo } from '../store/audit.ts';
import type { CampaignRow, CampaignTargetRow, CampaignsRepo } from '../store/campaigns.ts';
import type { LinkDomainsRepo } from '../store/link-domains.ts';
import type { MessageRow } from '../store/messages.ts';
import type { ShortLinksRepo } from '../store/short-links.ts';
import { warsawStamp } from '../time/warsaw.ts';
import { shortUrl } from './shortener.ts';
import { targetPattern } from './utm.ts';

export type CampaignTarget = { target: string; kind: 'shared' | 'individual'; opens: number; clicks: number };
export type CampaignOpener = ReturnType<ShortLinksRepo['openers']>[number];

export interface CampaignDetail {
  row: CampaignRow; keyName: string; packages: number; messages: number; delivered: number; reported: boolean;
  hours: Array<{ hour: string; clicks: number; bots: number }>;
  targets: CampaignTarget[];
  /** Domena najnowszego kodu, najpóźniejsze wygaśnięcie i UTM; null, gdy kodów już nie ma. */
  domain: string | null; expiresAt: string | null; utm: boolean | null;
  openers: CampaignOpener[];
}

export interface CampaignReadDeps {
  campaigns: CampaignsRepo;
  shortLinks: ShortLinksRepo;
  apiKeys: Pick<ApiKeysRepo, 'get'>;
}

export interface CampaignServiceDeps extends CampaignReadDeps {
  audit: Pick<AuditRepo, 'record'>;
}

/**
 * Wiersze tabeli „Linki”. Adres wielu odbiorców jest wspólny. Adresy jednego odbiorcy (linki indywidualne)
 * i wiersze scalone po retencji tabela łączy według wzorca `targetPattern`. Jedyny adres swojego wzorca
 * pozostaje pełnym adresem. Kolejność od największej liczby odbiorców, przy remisie najpierw adres wspólny.
 */
export function groupTargets(rows: readonly CampaignTargetRow[]): CampaignTarget[] {
  const out: Array<CampaignTarget & { recipients: number; members: number }> = [];
  const groups = new Map<string, CampaignTarget & { recipients: number; members: number; first: string; collapsed: boolean }>();
  for (const r of rows) {
    if (r.collapsed === 0 && r.recipients > 1) {
      out.push({ target: r.target, kind: 'shared', opens: r.opens, clicks: r.clicks, recipients: r.recipients, members: 1 });
      continue;
    }
    const key = r.collapsed === 1 ? r.target : targetPattern(r.target);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        target: key, kind: 'individual', opens: r.opens, clicks: r.clicks, recipients: r.recipients, members: 1,
        first: r.target, collapsed: r.collapsed === 1,
      });
    } else {
      group.opens += r.opens;
      group.clicks += r.clicks;
      group.recipients += r.recipients;
      group.members += 1;
      group.collapsed ||= r.collapsed === 1;
    }
  }
  for (const g of groups.values()) {
    const single = g.members === 1 && !g.collapsed;
    out.push({ target: single ? g.first : g.target, kind: 'individual', opens: g.opens, clicks: g.clicks, recipients: g.recipients, members: g.members });
  }
  const rank = (t: CampaignTarget) => (t.kind === 'shared' ? 0 : 1);
  out.sort((a, b) => b.recipients - a.recipients || rank(a) - rank(b) || a.target.localeCompare(b.target));
  return out.map(({ target, kind, opens, clicks }) => ({ target, kind, opens, clicks }));
}

export function campaignDetail(deps: CampaignReadDeps, id: number, openersLimit: number, openersOffset = 0): CampaignDetail | undefined {
  const row = deps.campaigns.get(id);
  if (row === undefined) return undefined;
  const { delivered, reported } = deps.campaigns.delivered(id);
  const sources = deps.campaigns.sources(id);
  const summary = deps.shortLinks.campaignSummary(id);
  return {
    row,
    keyName: deps.apiKeys.get(row.apiKeyId)?.name ?? `klucz ${row.apiKeyId}`,
    packages: sources.packages,
    messages: sources.messages,
    delivered,
    reported,
    hours: deps.campaigns.hours(id),
    targets: groupTargets(deps.campaigns.targets(id)),
    domain: summary?.domain ?? null,
    expiresAt: summary?.expiresAt ?? null,
    utm: summary?.utm ?? null,
    openers: deps.shortLinks.openers(id, openersOffset, openersLimit),
  };
}

const CSV_HEADER = 'numer;identyfikator_klienta;pierwsze_otwarcie;ostatnie_klikniecie;klikniecia;linki';
/** Tylu odbiorców CSV odczytuje z bazy naraz. */
const CSV_PAGE = 1000;

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Odbiorcy z otwarciem w CSV: pola jak w tabeli panelu, czas polski, adresy docelowe rozdzielone spacją. */
export function openersCsv(deps: Pick<CampaignReadDeps, 'shortLinks'>, id: number): string {
  const lines = [CSV_HEADER];
  for (let offset = 0; ; offset += CSV_PAGE) {
    const page = deps.shortLinks.openers(id, offset, CSV_PAGE);
    for (const o of page) {
      lines.push([o.dest, o.clientId, warsawStamp(o.firstOpenedAt), warsawStamp(o.lastClickedAt), o.clicks, o.targets.join(' ')]
        .map(csvCell).join(';'));
    }
    if (page.length < CSV_PAGE) break;
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Blok `links` w odczycie wiadomości i rozsyłki. Po retencji liczby są null, a `detailsPurged` true. */
export interface ReadLinksBlock {
  campaign: string; domain: string | null; expiresAt: string | null; shortened: number | null;
  opens: number | null; clicks: number | null; firstOpenedAt: string | null; detailsPurged: boolean;
}
export interface MessageLinksBlock extends ReadLinksBlock {
  shortLinks: Array<{ url: string; target: string; clicks: number; firstOpenedAt: string | null }>;
}

type BlockDeps = {
  campaigns: Pick<CampaignsRepo, 'get'>;
  shortLinks: Pick<ShortLinksRepo, 'forMessage' | 'packageStats'>;
  linkDomains: Pick<LinkDomainsRepo, 'get'>;
};

const purged = (campaign: string): ReadLinksBlock => ({
  campaign, domain: null, expiresAt: null, shortened: null, opens: null, clicks: null, firstOpenedAt: null, detailsPurged: true,
});

/**
 * Wiadomość z krótkimi linkami: kampania, krótkie linki, kliknięcia ludzi i pierwsze otwarcie. Krótki link
 * ma zawsze schemat https://, także przy domenie z linkami bez schematu, tak jak w zdarzeniu `link.opened`.
 */
export function messageLinks(deps: BlockDeps, m: Pick<MessageRow, 'id' | 'campaignId'>): MessageLinksBlock | undefined {
  if (m.campaignId === null) return undefined;
  const campaign = deps.campaigns.get(m.campaignId);
  if (campaign === undefined) return undefined;
  const codes = deps.shortLinks.forMessage(m.id);
  if (codes.length === 0) return { ...purged(campaign.name), shortLinks: [] };
  const domainOf = (id: number) => deps.linkDomains.get(id)?.domain ?? null;
  const opened = codes.map((c) => c.firstOpenedAt).filter((at): at is string => at !== null).sort();
  return {
    campaign: campaign.name,
    domain: domainOf(codes[0]!.domainId),
    expiresAt: codes.map((c) => c.expiresAt).sort().at(-1)!,
    shortened: codes.length,
    opens: opened.length > 0 ? 1 : 0,
    clicks: codes.reduce((n, c) => n + c.clicks, 0),
    firstOpenedAt: opened[0] ?? null,
    detailsPurged: false,
    shortLinks: codes.map((c) => ({
      url: shortUrl(domainOf(c.domainId) ?? '', c.code, false), target: c.target, clicks: c.clicks, firstOpenedAt: c.firstOpenedAt,
    })),
  };
}

/** Rozsyłka z krótkimi linkami: liczby wszystkich odbiorców; listę odbiorców z otwarciem podaje kampania. */
export function packageLinks(deps: BlockDeps, p: { id: string; campaignId: number | null }): ReadLinksBlock | undefined {
  if (p.campaignId === null) return undefined;
  const campaign = deps.campaigns.get(p.campaignId);
  if (campaign === undefined) return undefined;
  const stats = deps.shortLinks.packageStats(p.id);
  if (stats === undefined) return purged(campaign.name);
  return {
    campaign: campaign.name, domain: stats.domain, expiresAt: stats.expiresAt, shortened: stats.count, opens: stats.opens,
    clicks: stats.clicks, firstOpenedAt: stats.firstOpenedAt, detailsPurged: false,
  };
}

/** Kampanie w panelu: odczyt oraz „Wyłącz linki” i „Włącz linki” z wpisem w dzienniku zdarzeń. */
export class CampaignService {
  constructor(private readonly deps: CampaignServiceDeps) {}

  list(opts: { apiKeyId?: number; offset: number; limit: number }): { rows: CampaignRow[]; hasMore: boolean } {
    return this.deps.campaigns.list(opts);
  }

  detail(id: number, openersLimit: number, openersOffset = 0): CampaignDetail | undefined {
    return campaignDetail(this.deps, id, openersLimit, openersOffset);
  }

  openersCsv(id: number): string {
    return openersCsv(this.deps, id);
  }

  /** Wyłącza wszystkie kody kampanii, także w wysłanych SMS-ach; zwraca liczbę wyłączonych kodów. */
  disableLinks(id: number, user: PanelUser, now: Date): number {
    const row = this.deps.campaigns.get(id);
    if (row === undefined) return 0;
    const codes = this.deps.shortLinks.disableCampaign(id, now);
    this.deps.campaigns.setLinksDisabled(id, now);
    this.deps.audit.record({ actor: user.login, action: 'kampania.linki_wylaczone', target: `kampania:${id}`, meta: { name: row.name, codes } });
    return codes;
  }

  /** Przywraca kody kampanii poza kodami anulowanych wiadomości; zwraca liczbę przywróconych kodów. */
  enableLinks(id: number, user: PanelUser, _now: Date): number {
    const row = this.deps.campaigns.get(id);
    if (row === undefined) return 0;
    const codes = this.deps.shortLinks.enableCampaign(id);
    this.deps.campaigns.setLinksDisabled(id, null);
    this.deps.audit.record({ actor: user.login, action: 'kampania.linki_wlaczone', target: `kampania:${id}`, meta: { name: row.name, codes } });
    return codes;
  }
}
