import type { FastifyInstance } from 'fastify';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { messagePage, messagesPage } from '../views/messages.ts';

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
      }),
    });
  });
}
