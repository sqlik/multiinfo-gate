import type { FastifyInstance } from 'fastify';
import { reportCsv } from '../../api/packages.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { packagePage, packagesPage } from '../views/packages.ts';

const PAGE_SIZE = 25;

/** Tylu odbiorców pokazujemy w szczególe; pełna lista jest w CSV. */
const RECIPIENTS_SHOWN = 200;

export function registerPackageViewRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  app.get<{ Querystring: { offset?: string } }>('/rozsylki', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const offset = Math.max(0, Number.parseInt(request.query.offset ?? '0', 10) || 0);
    // Jeden wiersz ponad stronę, żeby wiedzieć, czy jest następna.
    const rows = deps.packages.list({ limit: PAGE_SIZE + 1, offset });

    return render.page(request, {
      title: 'Rozsyłki',
      active: 'rozsylki',
      body: packagesPage({
        rows: rows.slice(0, PAGE_SIZE),
        hasMore: rows.length > PAGE_SIZE,
        offset,
        limit: PAGE_SIZE,
        keyNames: new Map(deps.apiKeys.list().map((k) => [k.id, k.name])),
        accountNames: new Map(deps.accounts.list().map((a) => [a.id, a.name])),
      }),
    });
  });

  app.get<{ Params: { id: string } }>('/rozsylki/:id', async (request, reply) => {
    const row = deps.packages.get(request.params.id);
    if (!row) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');

    return render.page(request, {
      title: row.id,
      active: 'rozsylki',
      body: packagePage({
        row,
        accountName: deps.accounts.get(row.accountId)?.name ?? `konto ${row.accountId}`,
        keyName: deps.apiKeys.get(row.apiKeyId)?.name ?? `klucz ${row.apiKeyId}`,
        recipients: deps.packages.recipients(row.id, RECIPIENTS_SHOWN),
        shown: RECIPIENTS_SHOWN,
        summary: row.reportStatus === 'ready' ? deps.packages.recipientSummary(row.id) : null,
      }),
    });
  });

  app.get<{ Params: { id: string } }>('/rozsylki/:id/raport.csv', async (request, reply) => {
    const row = deps.packages.get(request.params.id);
    if (!row) return reply.callNotFound();
    if (row.reportStatus !== 'ready') {
      reply.type('text/plain; charset=utf-8');
      return reply.code(409).send('Raport nie jest jeszcze gotowy.');
    }
    reply.type('text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${row.id}.csv"`);
    return reportCsv(deps.packages.recipients(row.id));
  });
}
