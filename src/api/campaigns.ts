import type { FastifyInstance } from 'fastify';
import { campaignDetail } from '../links/campaigns.ts';
import type { CampaignRow } from '../store/campaigns.ts';
import { authenticate } from './auth.ts';
import { ApiError } from './errors.ts';
import type { ApiDeps } from './server.ts';
import { parseOffset } from '../paging.ts';

/** Ujemny LIMIT znaczy w SQLite „bez ograniczenia”: wartość spoza zakresu wraca do domyślnej. */
function page(query: Record<string, string>, fallback: number): { limit: number; offset: number } {
  const requested = Number.parseInt(query.limit ?? '', 10);
  const limit = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, 200) : fallback;
  const offset = parseOffset(query.offset);
  return { limit, offset };
}

const listItem = (c: CampaignRow) => ({
  name: c.name, firstSentAt: c.firstSentAt, lastSentAt: c.lastSentAt, sent: c.sent, opens: c.opens, clicks: c.clicks, bots: c.bots,
  linksDisabledAt: c.linksDisabledAt,
});

/** Kampanie klucza: lista z liczbami i szczegóły z linkami oraz stroną odbiorców z otwarciem (spec 12.4). */
export function registerCampaignRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Querystring: Record<string, string> }>('/v1/campaigns', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    const { rows, hasMore } = deps.campaigns.list({ apiKeyId: auth.apiKeyId, order: 'created', ...page(request.query, 25) });
    return { data: rows.map(listItem), hasMore };
  });

  app.get<{ Params: { name: string }; Querystring: Record<string, string> }>('/v1/campaigns/:name', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    const row = deps.campaigns.byName(auth.apiKeyId, request.params.name);
    // Kampania innego klucza i nieznana nazwa dają tę samą odpowiedź - nie potwierdzamy istnienia.
    if (row === undefined) throw new ApiError(404, 'campaign_not_found', 'Nie ma kampanii o tej nazwie.');
    const { limit, offset } = page(request.query, 50);
    // Jeden odbiorca ponad stronę, żeby wiedzieć, czy jest następna.
    const d = campaignDetail(deps, row.id, limit + 1, offset, 'first')!;
    return {
      ...listItem(row),
      packages: d.packages,
      messages: d.messages,
      delivered: d.reported ? d.delivered : null,
      detailsPurgedAt: row.detailsPurgedAt,
      domain: d.domain,
      expiresAt: d.expiresAt,
      utm: d.utm,
      links: d.targets,
      openers: {
        data: d.openers.slice(0, limit).map((o) => ({
          to: o.dest, clientId: o.clientId, firstOpenedAt: o.firstOpenedAt, lastClickedAt: o.lastClickedAt, clicks: o.clicks, targets: o.targets,
        })),
        hasMore: d.openers.length > limit,
      },
    };
  });
}
