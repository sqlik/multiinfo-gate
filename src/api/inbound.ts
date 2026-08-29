import type { FastifyInstance } from 'fastify';
import type { InboundRow } from '../store/inbound-messages.ts';
import { authenticate } from './auth.ts';
import { normalizeSender } from '../text/phone.ts';
import { ApiError } from './errors.ts';
import type { ApiDeps } from './server.ts';

/** Kształt wiadomości przychodzącej na zewnątrz - te same pola, co w webhooku, plus protokół. */
export function presentInbound(r: InboundRow) {
  // Bez treści zostaje skrót - ten sam, który zostaje w dostawie po wyczyszczeniu payloadu.
  const content = r.body === null ? { bodyHash: r.bodyHash } : r.kind === 'text' ? { text: r.body } : { hex: r.body };
  return {
    id: r.id, serviceId: r.serviceId, from: r.sender, to: r.dest, kind: r.kind, ...content,
    receivedAt: r.receivedAt, relatedMessageId: r.relatedMessageId,
    protocolId: r.protocolId, codingScheme: r.codingScheme, createdAt: r.createdAt,
  };
}

/** `new Date('zła').toISOString()` rzuca RangeError - z zewnątrz ma przyjść czytelne 400. */
function isoOrThrow(name: string, value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new ApiError(400, 'invalid_query', `${name} musi być datą ISO 8601.`);
  return new Date(time).toISOString();
}

/** Parametr powtórzony w adresie przychodzi jako tablica - do SQL poszłaby tablica, a klient dostałby 500. */
function rejectRepeated(query: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) throw new ApiError(400, 'invalid_query', `Parametr ${name} podano więcej niż raz.`);
  }
}

export function registerInboundRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Querystring: Record<string, string> }>('/v1/inbound', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    rejectRepeated(request.query);
    // Ujemny LIMIT znaczy w SQLite „bez ograniczenia”: wartość spoza zakresu wraca do domyślnej.
    const requested = Number.parseInt(request.query.limit ?? '', 10);
    const limit = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, 200) : 25;
    const offset = Math.max(Number.parseInt(request.query.offset ?? '0', 10) || 0, 0);

    // Odczyt nie wymaga subskrypcji - wystarczy dostęp klucza do usługi.
    let serviceIds = auth.allowedServiceIds;
    if (request.query.serviceId) {
      if (!serviceIds.includes(request.query.serviceId)) {
        throw new ApiError(403, 'service_not_allowed', `Klucz nie ma dostępu do usługi ${request.query.serviceId}.`);
      }
      serviceIds = [request.query.serviceId];
    }

    // Numer w dowolnym zapisie („+48 601…”, dziewięć cyfr) - do postaci, w jakiej zapisujemy nadawcę.
    const countryCode = deps.accounts.get(auth.accountId)?.defaultCountryCode ?? '';
    const rows = deps.inbound.list({
      accountId: auth.accountId,
      serviceIds,
      ...(request.query.from ? { sender: normalizeSender(request.query.from, countryCode) } : {}),
      ...(request.query.since ? { since: isoOrThrow('since', request.query.since) } : {}),
      ...(request.query.until ? { until: isoOrThrow('until', request.query.until) } : {}),
      limit: limit + 1,
      offset,
    });
    return { data: rows.slice(0, limit).map(presentInbound), hasMore: rows.length > limit };
  });

  app.get<{ Params: { id: string } }>('/v1/inbound/:id', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    const row = deps.inbound.get(request.params.id);
    // Brak i cudza wiadomość dają tę samą odpowiedź - nie potwierdzamy istnienia.
    if (!row || row.accountId !== auth.accountId || !auth.allowedServiceIds.includes(row.serviceId)) {
      throw new ApiError(404, 'inbound_not_found', 'Nie ma wiadomości przychodzącej o tym identyfikatorze.');
    }
    return presentInbound(row);
  });
}
