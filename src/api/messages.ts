import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { measureText } from '../text/measure.ts';
import { InvalidPhoneError, normalizePhone } from '../text/phone.ts';
import { TooManyPartsError, segmentText } from '../text/segment.ts';
import type { MessageRow } from '../store/messages.ts';
import { authenticate } from './auth.ts';
import { ApiError } from './errors.ts';
import { resolveOrig } from './orig.ts';
import type { ApiDeps } from './server.ts';

const MAX_VALIDITY_MS = 72 * 3600_000;

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
});

const shortId = () => `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const bodyHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

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

    const account = deps.accounts.get(auth.accountId);
    if (!account) throw new ApiError(500, 'account_missing', 'Konto przypisane do klucza nie istnieje.');

    const serviceId = String(input.serviceId ?? auth.defaultServiceId ?? '');
    if (!serviceId) throw new ApiError(400, 'service_required', 'Klucz nie ma domyślnej usługi - podaj serviceId.');
    if (!auth.allowedServiceIds.includes(serviceId)) {
      throw new ApiError(403, 'service_not_allowed', `Klucz nie ma dostępu do usługi ${serviceId}.`);
    }

    const orig = resolveOrig(input.orig, auth, account, deps.accounts);

    let validTo: Date | undefined;
    if (input.validTo !== undefined) {
      validTo = new Date(input.validTo);
      const ahead = validTo.getTime() - now().getTime();
      if (ahead <= 0) throw new ApiError(400, 'valid_to_in_past', 'Data ważności już minęła.');
      if (ahead > MAX_VALIDITY_MS) {
        throw new ApiError(400, 'valid_to_too_far', 'Multiinfo dopuszcza ważność najwyżej 72 godziny.');
      }
    }

    const maxParts = Math.min(input.maxParts ?? auth.maxParts, auth.maxParts);
    const measurement = measureText(input.text, input.encoding);
    let segmentation;
    try {
      segmentation = segmentText(input.text, measurement, maxParts);
    } catch (e) {
      if (e instanceof TooManyPartsError) throw new ApiError(400, 'too_many_parts', e.message);
      throw e;
    }

    const idempotencyKey = request.headers['idempotency-key'];
    const idem = typeof idempotencyKey === 'string' ? idempotencyKey : undefined;
    const hash = bodyHash(input.text);

    const recipients = Array.isArray(input.to) ? input.to : [input.to];

    // Najpierw sprawdzamy wszystkich odbiorców, dopiero potem cokolwiek zapisujemy:
    // lista ma wejść w całości albo wcale. Inaczej błędny numer na trzeciej pozycji
    // zostawiłby dwie wiadomości w kolejce, a klient dostałby 400 i wysłał je ponownie.
    const checked = recipients.map((raw, index) => {
      let dest: string;
      try {
        dest = normalizePhone(raw, account.defaultCountryCode);
      } catch (e) {
        if (e instanceof InvalidPhoneError) throw new ApiError(400, 'invalid_phone', e.message);
        throw e;
      }

      const perRecipientIdem = idem === undefined ? undefined : recipients.length === 1 ? idem : `${idem}#${index}`;
      const existing = perRecipientIdem === undefined
        ? undefined
        : deps.messages.findByIdempotencyKey(auth.apiKeyId, perRecipientIdem);
      if (existing && (existing.bodyHash !== hash || existing.dest !== dest)) {
        throw new ApiError(409, 'idempotency_conflict',
          'Ten klucz idempotencji został już użyty z inną treścią lub innym odbiorcą.');
      }
      return { dest, perRecipientIdem, existing };
    });

    const results = deps.messages.transaction(() => checked.map(({ dest, perRecipientIdem, existing }) => {
      if (existing) {
        return {
          id: existing.id, status: existing.status, encoding: existing.encoding,
          parts: existing.parts, characters: measurement.characters,
          slots: existing.slots, slotsRemaining: segmentation.slotsRemaining,
        };
      }

      const id = shortId();
      deps.messages.insert({
        id, apiKeyId: auth.apiKeyId, accountId: auth.accountId, serviceId, dest,
        body: account.storeContent ? input.text : null, bodyHash: hash,
        encoding: measurement.encoding, parts: segmentation.parts, slots: measurement.slots,
        orig: orig ?? null, costCenter: input.costCenter ?? null,
        validTo: validTo?.toISOString() ?? null,
        idempotencyKey: perRecipientIdem ?? null,
        createdAt: now().toISOString(),
      });
      deps.jobs.enqueue('send', { messageId: id, text: input.text, deliveryReport: input.deliveryReport }, now());
      deps.events.record(id, now(), 'queued', null);

      return {
        id, status: 'queued', encoding: measurement.encoding, parts: segmentation.parts,
        characters: measurement.characters, slots: measurement.slots,
        slotsRemaining: segmentation.slotsRemaining,
      };
    }));

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
    createdAt: m.createdAt,
    sentAt: m.sentAt,
    finalAt: m.finalAt,
    providerCode: m.providerCode,
    error: m.error,
  };
}
