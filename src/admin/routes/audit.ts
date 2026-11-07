import type { FastifyInstance } from 'fastify';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { auditPage } from '../views/audit.ts';
import { parseOffset } from '../../paging.ts';

const PAGE_SIZE = 50;

export function registerAuditRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  app.get<{ Querystring: { offset?: string } }>('/dziennik', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const offset = parseOffset(request.query.offset);
    // Jeden wiersz ponad stronę mówi, czy są starsze wpisy.
    const rows = deps.audit.list(PAGE_SIZE + 1, offset);

    return render.page(request, {
      title: 'Dziennik zdarzeń',
      active: 'dziennik',
      body: auditPage({
        rows: rows.slice(0, PAGE_SIZE),
        offset,
        limit: PAGE_SIZE,
        hasMore: rows.length > PAGE_SIZE,
      }),
    });
  });
}
