import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MessageRow } from '../store/messages.ts';
import { authenticate } from './auth.ts';
import { ApiError } from './errors.ts';
import type { ApiDeps } from './server.ts';
import { submitMessages } from './submit.ts';

const bodySchema = z.object({
  to: z.union([z.string(), z.array(z.string()).min(1).max(500)]),
  text: z.string().min(1),
  orig: z.string().optional(),
  serviceId: z.union([z.string(), z.number()]).optional(),
  encoding: z.enum(['auto', 'gsm', 'unicode']).default('auto'),
  maxParts: z.number().int().min(1).max(9).optional(),
  deliveryReport: z.boolean().default(true),
  validTo: z.string().datetime().optional(),
  costCenter: z.string().optional(),
  /** Wiadomość przychodząca, na którą to odpowiedź; identyfikator ma stały kształt, reszta to sprawdzenie w bazie. */
  inReplyTo: z.string().regex(/^in_[A-Za-z0-9_]{1,40}$/).optional(),
});


export function registerMessageRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const now = deps.now ?? (() => new Date());

  app.post('/v1/messages', async (request, reply) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);

    if (!deps.rateLimiter.check(auth.apiKeyId, auth.ratePerMin)) {
      throw new ApiError(429, 'rate_limited', `Przekroczono limit ${auth.ratePerMin} żądań na minutę.`);
    }

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        400,
        'invalid_body',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const input = parsed.data;

    const idempotencyKey = request.headers['idempotency-key'];
    const results = submitMessages(deps, auth, {
      to: Array.isArray(input.to) ? input.to : [input.to],
      text: input.text,
      encoding: input.encoding,
      deliveryReport: input.deliveryReport,
      ...(input.orig !== undefined ? { orig: input.orig } : {}),
      ...(input.serviceId !== undefined ? { serviceId: String(input.serviceId) } : {}),
      ...(input.maxParts !== undefined ? { maxParts: input.maxParts } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      ...(input.costCenter !== undefined ? { costCenter: input.costCenter } : {}),
      ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
      ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
    }, now());

    reply.code(202);
    return Array.isArray(input.to) ? results : results[0];
  });

  app.get<{ Params: { id: string } }>('/v1/messages/:id', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    const message = deps.messages.get(request.params.id);
    // Brak wiadomości i cudza wiadomość dają tę samą odpowiedź - nie potwierdzamy istnienia.
    if (!message || message.apiKeyId !== auth.apiKeyId) {
      throw new ApiError(404, 'message_not_found', 'Nie ma wiadomości o tym identyfikatorze.');
    }
    return present(message);
  });

  app.get<{ Querystring: Record<string, string> }>('/v1/messages', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    // Ujemny LIMIT znaczy w SQLite „bez ograniczenia”: wartość spoza zakresu wraca do domyślnej.
    const requested = Number.parseInt(request.query.limit ?? '', 10);
    const limit = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, 200) : 25;
    const offset = Math.max(Number.parseInt(request.query.offset ?? '0', 10) || 0, 0);

    const rows = deps.messages.list({
      apiKeyId: auth.apiKeyId,
      ...(request.query.status ? { status: request.query.status } : {}),
      ...(request.query.to ? { dest: request.query.to } : {}),
      ...(request.query.from ? { from: request.query.from } : {}),
      ...(request.query.until ? { until: request.query.until } : {}),
      limit: limit + 1,
      offset,
    });

    return { data: rows.slice(0, limit).map(present), hasMore: rows.length > limit };
  });
}

/** Kształt wiadomości widziany z zewnątrz. Treść pokazujemy tylko, jeśli jest przechowywana. */
function present(m: MessageRow) {
  return {
    id: m.id,
    status: m.status,
    to: m.dest,
    ...(m.body === null ? {} : { text: m.body }),
    encoding: m.encoding,
    parts: m.parts,
    slots: m.slots,
    orig: m.orig,
    serviceId: m.serviceId,
    inReplyTo: m.inReplyTo,
    createdAt: m.createdAt,
    sentAt: m.sentAt,
    finalAt: m.finalAt,
    providerCode: m.providerCode,
    error: m.error,
  };
}
