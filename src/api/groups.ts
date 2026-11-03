import type { FastifyInstance } from 'fastify';
import type { SmsGroupConfig } from '../integrations/config.ts';
import { groupRecipients } from '../integrations/group/members.ts';
import type { IntegrationRow } from '../store/integrations.ts';
import { authenticate } from './auth.ts';
import { dropEmptyFields } from './empty-fields.ts';
import { ApiError } from './errors.ts';
import { messageBodySchema } from './messages.ts';
import type { ApiDeps } from './server.ts';
import { submitMessages } from './submit.ts';

/** Identyfikator grupy w API: stały numer integracji, więc zmiana nazwy grupy nie psuje przepływu. */
const GROUP_API_ID = /^grp_([1-9]\d{0,9})$/;

export const groupApiId = (integrationId: number): string => `grp_${integrationId}`;

export function parseGroupApiId(raw: string): number | null {
  const match = GROUP_API_ID.exec(raw);
  return match ? Number(match[1]) : null;
}

/**
 * Ciało wysyłki do grupy: pola jak w `POST /v1/messages` bez odbiorców, usługi i wątku. Odbiorców
 * i usługę wyznacza grupa. Zod pomija nieznane pola, więc `to` albo `serviceId` w żądaniu nic nie zmienia.
 */
export const groupMessageBodySchema = messageBodySchema.omit({ to: true, serviceId: true, inReplyTo: true });

/** Odbiorcy wysyłki z aplikacji: lista odbiorców albo wszyscy członkowie grupy zamkniętej, bez powtórzeń. */
function recipientsOf(row: IntegrationRow): string[] {
  return groupRecipients(row.config as SmsGroupConfig, '');
}

export function registerGroupRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const now = deps.now ?? (() => new Date());

  app.get('/v1/groups', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    // Tylko nazwa i liczba odbiorców: numery i nazwiska członków zostają w panelu bramki.
    const data = deps.integrations.listForKey(auth.apiKeyId)
      .filter((row) => row.kind === 'sms_group' && row.enabled === 1)
      .map((row) => ({ id: groupApiId(row.id), name: row.name, recipients: recipientsOf(row).length }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    return { data };
  });

  app.post<{ Params: { id: string } }>('/v1/groups/:id/messages', async (request, reply) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    if (!deps.rateLimiter.check(auth.apiKeyId, auth.ratePerMin)) {
      throw new ApiError(429, 'rate_limited', `Przekroczono limit ${auth.ratePerMin} żądań na minutę.`);
    }

    // Brak grupy, grupa innego klucza i integracja innego rodzaju dają tę samą odpowiedź - nie potwierdzamy istnienia.
    const id = parseGroupApiId(request.params.id);
    const row = id === null ? undefined : deps.integrations.get(id);
    if (!row || row.kind !== 'sms_group' || row.apiKeyId !== auth.apiKeyId) {
      throw new ApiError(404, 'group_not_found', 'Nie ma grupy o tym identyfikatorze.');
    }
    if (row.enabled !== 1) {
      throw new ApiError(409, 'group_disabled', `Grupa ${row.name} jest wyłączona w panelu bramki.`);
    }
    const recipients = recipientsOf(row);
    if (recipients.length === 0) {
      throw new ApiError(409, 'group_empty', `Grupa ${row.name} nie ma odbiorców.`);
    }

    const parsed = groupMessageBodySchema.safeParse(dropEmptyFields(request.body));
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_body', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const input = parsed.data;
    const orig = input.orig ?? row.orig ?? undefined;
    const idempotencyKey = request.headers['idempotency-key'];
    const at = now();

    const results = submitMessages(deps, auth, {
      to: recipients,
      text: input.text,
      encoding: input.encoding,
      deliveryReport: input.deliveryReport,
      integrationId: row.id,
      ...(row.serviceId ? { serviceId: row.serviceId } : {}),
      ...(orig !== undefined ? { orig } : {}),
      ...(input.maxParts !== undefined ? { maxParts: input.maxParts } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      ...(input.costCenter !== undefined ? { costCenter: input.costCenter } : {}),
      ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
    }, at);

    deps.integrationEvents.record({
      integrationId: row.id, at, result: 'sent', reason: `wysyłka przez API, ${results.length} odbiorców`,
      logLimit: (row.config as SmsGroupConfig).eventLogLimit,
      ...(results[0] ? { messageId: results[0].id } : {}),
    });

    reply.code(202);
    return {
      group: { id: groupApiId(row.id), name: row.name },
      recipients: results.length,
      messages: results.map((r, i) => ({ id: r.id, to: recipients[i]!, status: r.status, parts: r.parts })),
    };
  });
}
