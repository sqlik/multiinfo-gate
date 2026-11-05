import type { FastifyInstance } from 'fastify';
import { messageLinks } from '../../links/campaigns.ts';
import type { MessageRow } from '../../store/messages.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { deliveryView, integrationLink } from '../views/deliveries.ts';
import { messagePage, messagesPage, type MessageDetail } from '../views/messages.ts';

/** Kampania i liczby krótkich linków wiadomości; brak dla wiadomości bez skróconych linków. */
function messageLinkRows(deps: AdminDeps, row: MessageRow): NonNullable<MessageDetail['links']> | null {
  const block = messageLinks(deps, row);
  if (block === undefined || row.campaignId === null) return null;
  return { campaign: { id: row.campaignId, name: block.campaign }, clicks: block.clicks, firstOpenedAt: block.firstOpenedAt };
}

const PAGE_SIZE = 25;

/** `https://api2.multiinfo.plus.pl/Api61/` → `api2.multiinfo.plus.pl/Api61` - jak w makiecie śladu. */
function hostOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return baseUrl;
  }
}

export function registerMessageViewRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  app.get<{ Querystring: { status?: string; to?: string; offset?: string } }>(
    '/wiadomosci',
    async (request, reply) => {
      reply.type('text/html; charset=utf-8');

      const status = (request.query.status ?? '').trim() || null;
      const to = (request.query.to ?? '').trim() || null;
      const offset = Math.max(0, Number.parseInt(request.query.offset ?? '0', 10) || 0);

      // Pobieramy jeden wiersz ponad stronę, żeby wiedzieć, czy jest następna.
      const rows = deps.messages.list({
        ...(status === null ? {} : { status }),
        ...(to === null ? {} : { dest: to }),
        // Panel pokazuje także wiadomości kanału SMS powiadomień, z oznaczeniem na liście.
        includeSystem: true,
        limit: PAGE_SIZE + 1,
        offset,
      });

      return render.page(request, {
        title: 'Wiadomości',
        active: 'wiadomosci',
        body: messagesPage({
          rows: rows.slice(0, PAGE_SIZE),
          filters: { status, to },
          hasMore: rows.length > PAGE_SIZE,
          offset,
          limit: PAGE_SIZE,
          keyNames: new Map(deps.apiKeys.list().map((k) => [k.id, k.name])),
          accountNames: new Map(deps.accounts.list().map((a) => [a.id, a.name])),
        }),
      });
    },
  );

  app.get<{ Params: { id: string } }>('/wiadomosci/:id', async (request, reply) => {
    const row = deps.messages.get(request.params.id);
    if (!row) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');

    const account = deps.accounts.get(row.accountId);
    const key = deps.apiKeys.get(row.apiKeyId);

    return render.page(request, {
      title: row.id,
      active: 'wiadomosci',
      body: messagePage({
        row,
        accountName: account?.name ?? `konto ${row.accountId}`,
        keyName: key?.name ?? `klucz ${row.apiKeyId}`,
        storeContent: account?.storeContent === 1,
        host: hostOf(account?.baseUrl ?? ''),
        events: deps.events.list(row.id),
        deliveries: deps.deliveries.listForMessage(row.id).map((delivery) => deliveryView(deps, delivery)),
        integration: row.integrationId === null ? null : integrationLink(deps, row.integrationId),
        links: messageLinkRows(deps, row),
      }),
    });
  });
}
