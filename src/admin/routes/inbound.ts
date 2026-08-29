import type { FastifyInstance } from 'fastify';
import { endOfWarsawDay } from '../../time/warsaw.ts';
import type { InboundRow } from '../../store/inbound-messages.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { inboundDetailPage, inboundPage } from '../views/inbound.ts';

const PAGE_SIZE = 25;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Początek dnia w Polsce to koniec dnia poprzedniego. */
function startOfWarsawDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const previous = new Date(Date.UTC(y, m - 1, d - 1));
  return endOfWarsawDay(previous.toISOString().slice(0, 10));
}

export function registerInboundViewRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  app.get<{ Querystring: Record<string, string | undefined> }>('/odebrane', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const q = request.query;
    const konto = q.konto ? Number.parseInt(q.konto, 10) || null : null;
    const filters = {
      konto, usluga: (q.usluga ?? '').trim() || null, od: (q.od ?? '').trim() || null,
      dzienOd: DAY.test(q.dzienOd ?? '') ? q.dzienOd! : null,
      dzienDo: DAY.test(q.dzienDo ?? '') ? q.dzienDo! : null,
    };
    const offset = Math.max(0, Number.parseInt(q.offset ?? '0', 10) || 0);
    let rows: InboundRow[];
    try {
      // Jeden wiersz ponad stronę, żeby wiedzieć, czy jest następna.
      rows = deps.inbound.list({
        ...(filters.konto === null ? {} : { accountId: filters.konto }),
        ...(filters.usluga === null ? {} : { serviceIds: [filters.usluga] }),
        ...(filters.od === null ? {} : { sender: filters.od }),
        ...(filters.dzienOd === null ? {} : { since: startOfWarsawDay(filters.dzienOd) }),
        ...(filters.dzienDo === null ? {} : { until: endOfWarsawDay(filters.dzienDo) }),
        limit: PAGE_SIZE + 1, offset,
      });
    } catch {
      // Dzień, którego nie ma w kalendarzu (np. 31 lutego) - pusta lista zamiast błędu 500.
      rows = [];
    }
    return render.page(request, {
      title: 'Odebrane', active: 'odebrane',
      body: inboundPage({
        rows: rows.slice(0, PAGE_SIZE), filters, hasMore: rows.length > PAGE_SIZE, offset, limit: PAGE_SIZE,
        accounts: deps.accounts.list().map((a) => ({ id: a.id, name: a.name })),
      }),
    });
  });

  app.get<{ Params: { id: string } }>('/odebrane/:id', async (request, reply) => {
    const row = deps.inbound.get(request.params.id);
    if (!row) return reply.callNotFound();
    reply.type('text/html; charset=utf-8');
    const account = deps.accounts.get(row.accountId);
    const keyNames = new Map(deps.apiKeys.list().map((k) => [k.id, k.name]));
    return render.page(request, {
      title: row.id, active: 'odebrane',
      body: inboundDetailPage({
        row,
        accountName: account?.name ?? `konto ${row.accountId}`,
        deliveries: deps.deliveries.listForInbound(row.id).map((delivery) => ({
          delivery, keyName: keyNames.get(delivery.apiKeyId) ?? `klucz ${delivery.apiKeyId}`,
        })),
        related: row.relatedMessageId === null ? null : deps.messages.get(row.relatedMessageId) ?? null,
        replies: deps.messages.repliesTo(row.id),
      }),
    });
  });
}
