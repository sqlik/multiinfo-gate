import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CampaignService } from '../../links/campaigns.ts';
import type { PanelUser } from '../../m365/service.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { campaignPage, campaignsPage } from '../views/campaigns.ts';
import { parseOffset } from '../../paging.ts';

const PAGE_SIZE = 25;
/** Tylu odbiorców i wierszy linków pokazuje strona kampanii; pełna lista odbiorców jest w CSV. */
const SHOWN = 50;
const WINDOW_MS = 48 * 3_600_000;

const idOf = (raw: string): number | null => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

/** Nazwa pliku CSV: nazwa kampanii, gdy składa się ze znaków bezpiecznych w nagłówku, w przeciwnym razie numer. */
const csvName = (id: number, name: string) => (/^[A-Za-z0-9._-]{1,100}$/.test(name) ? name : `kampania-${id}`);

/** „Kampanie”: lista, szczegóły z wykresem, CSV odbiorców oraz „Wyłącz linki” i „Włącz linki” (spec 12.2). */
export function registerCampaignRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());
  const service = new CampaignService({ campaigns: deps.campaigns, shortLinks: deps.shortLinks, apiKeys: deps.apiKeys, audit: deps.audit });

  const userOf = (request: FastifyRequest): PanelUser => {
    const id = request.adminUserId!;
    return { id, login: deps.users.findById(id)?.login ?? String(id) };
  };

  const campaignOf = (raw: string) => {
    const id = idOf(raw);
    return id === null ? undefined : deps.campaigns.get(id);
  };

  app.get<{ Querystring: { offset?: string } }>('/kampanie', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const offset = parseOffset(request.query.offset);
    const { rows, hasMore } = service.list({ offset, limit: PAGE_SIZE });
    return render.page(request, {
      title: 'Kampanie',
      active: 'kampanie',
      body: campaignsPage({ rows, hasMore, offset, limit: PAGE_SIZE, keyNames: new Map(deps.apiKeys.list().map((k) => [k.id, k.name])) }),
    });
  });

  app.get<{ Params: { id: string }; Querystring: { widok?: string } }>('/kampanie/:id', async (request, reply) => {
    const row = campaignOf(request.params.id);
    if (!row) return reply.callNotFound();
    const detail = service.detail(row.id, SHOWN)!;
    const at = now();
    reply.type('text/html; charset=utf-8');
    return render.page(request, {
      title: row.name,
      active: 'kampanie',
      body: campaignPage({
        detail,
        mode: request.query.widok === 'dzien' ? 'daily' : 'hourly',
        canSwitch: at.getTime() - Date.parse(row.firstSentAt) > WINDOW_MS,
        shown: SHOWN,
      }, at),
    });
  });

  app.get<{ Params: { id: string } }>('/kampanie/:id/odbiorcy.csv', async (request, reply) => {
    const row = campaignOf(request.params.id);
    if (!row) return reply.callNotFound();
    reply.type('text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${csvName(row.id, row.name)}-odbiorcy.csv"`);
    return service.openersCsv(row.id);
  });

  app.post<{ Params: { id: string } }>('/kampanie/:id/wylacz', async (request, reply) => {
    const row = campaignOf(request.params.id);
    if (!row) return reply.callNotFound();
    service.disableLinks(row.id, userOf(request), now());
    render.flash(request, 'ok', 'Linki kampanii wyłączone. Odbiorca, który otworzy link, zobaczy stronę „Link wygasł”');
    return reply.redirect(`/kampanie/${row.id}`, 303);
  });

  app.post<{ Params: { id: string } }>('/kampanie/:id/wlacz', async (request, reply) => {
    const row = campaignOf(request.params.id);
    if (!row) return reply.callNotFound();
    service.enableLinks(row.id, userOf(request), now());
    render.flash(request, 'ok', 'Linki kampanii włączone. Linki, których ważność nie minęła, ponownie przekierowują do adresów docelowych');
    return reply.redirect(`/kampanie/${row.id}`, 303);
  });
}
