import type { FastifyInstance, FastifyReply } from 'fastify';
import { reportCsv } from '../api/packages.ts';
import { AgentError } from '../integrations/agent.ts';
import { OPENING_TIME_COLUMNS, openersCsv, RECIPIENT_CSV_COLUMNS } from '../links/campaigns.ts';
import { downloadExpiredPage } from '../links/pages.ts';
import type { Logger } from '../log.ts';
import type { CampaignsRepo } from '../store/campaigns.ts';
import type { DownloadKind, DownloadLinksRepo } from '../store/download-links.ts';
import type { PackagesRepo, RecipientRow } from '../store/packages.ts';
import type { ShortLinksRepo } from '../store/short-links.ts';
import { csvCell } from '../text/csv.ts';
import { generateSecret, hashSecret, logPrefix } from './codes.ts';
import type { ReadDeps } from './reads.ts';

/** Link do pobrania jest ważny godzinę (spec 8). */
export const DOWNLOAD_TTL_MS = 3_600_000;

export interface DownloadRouteDeps {
  downloads: DownloadLinksRepo; packages: PackagesRepo; shortLinks: ShortLinksRepo; campaigns: CampaignsRepo; log?: Logger; now?: () => Date;
}

/**
 * Link do jednego pliku jednego klucza. Token ma 32 bajty losowe, bramka zapisuje wyłącznie jego skrót, a dane
 * czyta w chwili pobrania. `ref` to identyfikator rozsyłki albo kampanii.
 */
export function createDownload(
  deps: { downloads: Pick<DownloadLinksRepo, 'insert'> }, base: string | null, apiKeyId: number, kind: DownloadKind, ref: string, now: Date,
): { url: string; expiresAt: string } {
  if (base === null) {
    throw new AgentError('no_gateway_address', 'Adres bramki nie jest ustawiony, dlatego bramka nie może utworzyć linku do pobrania.');
  }
  const { value, hash } = generateSecret('');
  const expiresAt = new Date(now.getTime() + DOWNLOAD_TTL_MS);
  deps.downloads.insert(hash, { apiKeyId, kind, ref, createdAt: now, expiresAt });
  return { url: `${base.replace(/\/+$/, '')}/pobierz/${value}`, expiresAt: expiresAt.toISOString() };
}

/** Niedoręczeni: kolumny raportu rozsyłki, wyłącznie odbiorcy w stanie innym niż doręczony. */
export function failedCsv(rows: RecipientRow[]): string {
  return reportCsv(rows.filter((r) => r.status !== 'delivered'));
}

/** Odbiorcy kampanii bez otwarcia: kolumny pliku odbiorców z otwarciem bez czasów otwarcia. */
export function unopenedCsv(deps: Pick<ReadDeps, 'shortLinks'>, campaignId: number): string {
  const links = deps.shortLinks.linksByDest(campaignId);
  const lines = [RECIPIENT_CSV_COLUMNS.filter((c) => !OPENING_TIME_COLUMNS.has(c)).join(';')];
  for (const r of deps.shortLinks.recipients(campaignId, 'unopened')) {
    const l = links.get(r.dest);
    lines.push([r.dest, r.clientId, l?.clicks ?? 0, (l?.targets ?? []).join(' ')].map(csvCell).join(';'));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Nazwa kampanii w nazwie pliku: małe litery ASCII i łączniki; nazwa bez liter i cyfr daje identyfikator. */
function slug(name: string, id: number): string {
  const ascii = name.replace(/ł/g, 'l').replace(/Ł/g, 'L').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return ascii === '' ? String(id) : ascii;
}

/** Plik linku: rozsyłka albo kampania klucza, który utworzył link; brak albo cudzy zasób daje `undefined`. */
function fileOf(deps: DownloadRouteDeps, link: { apiKeyId: number; kind: DownloadKind; ref: string }): { name: string; body: string } | undefined {
  if (link.kind === 'package_report' || link.kind === 'package_failed') {
    const p = deps.packages.get(link.ref);
    if (!p || p.apiKeyId !== link.apiKeyId) return undefined;
    const rows = deps.packages.recipients(p.id);
    return link.kind === 'package_report'
      ? { name: `raport-${p.id}.csv`, body: reportCsv(rows) }
      : { name: `niedoreczeni-${p.id}.csv`, body: failedCsv(rows) };
  }
  const c = deps.campaigns.get(Number(link.ref));
  if (!c || c.apiKeyId !== link.apiKeyId) return undefined;
  return link.kind === 'campaign_opened'
    ? { name: `kampania-${slug(c.name, c.id)}-z-otwarciem.csv`, body: openersCsv(deps, c.id) }
    : { name: `kampania-${slug(c.name, c.id)}-bez-otwarcia.csv`, body: unopenedCsv(deps, c.id) };
}

/** Odpowiedź bez zapisu w pamięci przeglądarki i pośredników, bez adresu linku w nagłówku Referer. */
const noStore = (reply: FastifyReply): FastifyReply => reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');

/**
 * `GET /pobierz/:token`: plik CSV bez logowania, dopóki link jest ważny. Link po terminie i nieznany dają tę samą
 * stronę „Link wygasł”. Do logu trafia wyłącznie przedrostek tokenu.
 */
export function registerDownloadRoute(app: FastifyInstance, deps: DownloadRouteDeps): void {
  const now = deps.now ?? (() => new Date());
  app.get<{ Params: { token: string } }>('/pobierz/:token', async (request, reply) => {
    const token = request.params.token;
    const link = deps.downloads.get(hashSecret(token), now());
    const file = link === undefined ? undefined : fileOf(deps, link);
    if (link === undefined || file === undefined) {
      deps.log?.info('pobranie.wygasle', { token: logPrefix(token) });
      return noStore(reply).code(404).type('text/html; charset=utf-8').send(downloadExpiredPage());
    }
    deps.log?.info('pobranie', { token: logPrefix(token), kind: link.kind, apiKeyId: link.apiKeyId });
    return noStore(reply).type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${file.name}"`).send(file.body);
  });
}
