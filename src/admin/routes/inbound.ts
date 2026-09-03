import type { FastifyInstance } from 'fastify';
import { normalizeSender, stripPhone } from '../../text/phone.ts';
import { endOfWarsawDay } from '../../time/warsaw.ts';
import type { InboundRow } from '../../store/inbound-messages.ts';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { deliveryView, integrationLink } from '../views/deliveries.ts';
import { inboundDetailPage, inboundPage } from '../views/inbound.ts';

const PAGE_SIZE = 25;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Parametr z adresu: tekst albo nic; powtórzony (tablica) jest pomijany, nie wysadza strony. */
const text = (v: string | string[] | undefined): string | null => (typeof v === 'string' ? v.trim() || null : null);

/** Dzień z kalendarza (RRRR-MM-DD, istniejący) albo nic - 31 lutego z ręcznie złożonego adresu nie filtruje. */
function day(v: string | string[] | undefined): string | null {
  const value = text(v);
  if (value === null || !DAY.test(value)) return null;
  try { endOfWarsawDay(value); } catch { return null; }
  return value;
}

/** Początek dnia w Polsce to koniec dnia poprzedniego. */
function startOfWarsawDay(validDay: string): string {
  const [y, m, d] = validDay.split('-').map(Number) as [number, number, number];
  const previous = new Date(Date.UTC(y, m - 1, d - 1));
  return endOfWarsawDay(previous.toISOString().slice(0, 10));
}

export function registerInboundViewRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  /** Numer z pola filtru jak nadawca przy zapisie; kod kraju do dziewięciu cyfr znamy tylko przy wybranym koncie. */
  const senderFilter = (raw: string, accountId: number | null): string => {
    const account = accountId === null ? undefined : deps.accounts.get(accountId);
    return account ? normalizeSender(raw, account.defaultCountryCode) : stripPhone(raw);
  };

  app.get<{ Querystring: Record<string, string | undefined> }>('/odebrane', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const q = request.query as Record<string, string | string[] | undefined>;
    const konto = Number.parseInt(text(q.konto) ?? '', 10) || null;
    const filters = { konto, usluga: text(q.usluga), od: text(q.od), dzienOd: day(q.dzienOd), dzienDo: day(q.dzienDo) };
    const offset = Math.max(0, Number.parseInt(text(q.offset) ?? '0', 10) || 0);
    // Jeden wiersz ponad stronę, żeby wiedzieć, czy jest następna.
    const rows: InboundRow[] = deps.inbound.list({
      ...(filters.konto === null ? {} : { accountId: filters.konto }),
      ...(filters.usluga === null ? {} : { serviceIds: [filters.usluga] }),
      ...(filters.od === null ? {} : { sender: senderFilter(filters.od, filters.konto) }),
      ...(filters.dzienOd === null ? {} : { since: startOfWarsawDay(filters.dzienOd) }),
      ...(filters.dzienDo === null ? {} : { until: endOfWarsawDay(filters.dzienDo) }),
      limit: PAGE_SIZE + 1, offset,
    });
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
    return render.page(request, {
      title: row.id, active: 'odebrane',
      body: inboundDetailPage({
        row,
        accountName: account?.name ?? `konto ${row.accountId}`,
        deliveries: deps.deliveries.listForInbound(row.id).map((delivery) => deliveryView(deps, delivery)),
        ticket: row.externalRef === null || row.externalIntegrationId === null ? null
          : { ref: row.externalRef, integration: integrationLink(deps, row.externalIntegrationId) },
        related: row.relatedMessageId === null ? null : deps.messages.get(row.relatedMessageId) ?? null,
        replies: deps.messages.repliesTo(row.id),
      }),
    });
  });
}
