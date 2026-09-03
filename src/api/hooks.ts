import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { runInbound, type InboundIntegration } from '../integrations/pipeline.ts';
import { silentLogger } from '../log.ts';
import type { ApiDeps } from './server.ts';

/** Limit żądań na adres źródłowy, niezależny od limitów klucza - `/hooks/` nie ma nagłówka z kluczem. */
export const HOOK_RATE_PER_MIN = 120;
export const HOOK_BODY_LIMIT = 256 * 1024;

/** Porównanie w stałym czasie niezależnie od długości: skróty obu stron mają tę samą długość. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

type AuthVerdict = { ok: true } | { ok: false; status: 401 | 403; reason: string };

/** Warstwy poza sekretem w adresie: nagłówek z tokenem, basic auth, lista źródeł. Każda opcjonalna. */
async function verify(request: FastifyRequest, integration: InboundIntegration, secrets: Record<string, string>, deps: ApiDeps): Promise<AuthVerdict> {
  const auth = integration.config.auth;
  if (auth.header) {
    const given = request.headers[auth.header.name.toLowerCase()];
    const expected = secrets[auth.header.valueRef];
    if (typeof given !== 'string' || expected === undefined || !sameSecret(given, expected)) {
      return { ok: false, status: 401, reason: `nagłówek ${auth.header.name} nie pasuje` };
    }
  }
  if (auth.basic) {
    const header = request.headers.authorization ?? '';
    const m = /^Basic\s+(\S+)$/.exec(header);
    const decoded = m ? Buffer.from(m[1]!, 'base64').toString('utf8') : '';
    const expected = `${auth.basic.user}:${secrets[auth.basic.passRef] ?? ''}`;
    if (!m || !sameSecret(decoded, expected)) return { ok: false, status: 401, reason: 'basic auth nie pasuje' };
  }
  if (!(await deps.sources.allowed(auth.sources, request.ip))) {
    return { ok: false, status: 403, reason: `adres ${request.ip} spoza listy źródeł` };
  }
  return { ok: true };
}

export function registerHookRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;

  // Inne metody bez ujawniania, czy integracja istnieje.
  app.route({
    method: ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
    url: '/hooks/:hookId',
    handler: async (_request, reply) => reply.code(405).send({ accepted: false, reason: 'method' }),
  });

  app.post<{ Params: { hookId: string } }>('/hooks/:hookId', { bodyLimit: HOOK_BODY_LIMIT }, async (request, reply) => {
    const integration = deps.integrations.getByHookId(request.params.hookId);
    if (!integration || integration.enabled === 0 || integration.kind !== 'webhook_in') {
      return reply.code(404).send({ accepted: false, reason: 'unknown' });
    }
    if (deps.hookLimiter && !deps.hookLimiter.check(`hook:${request.ip}`, HOOK_RATE_PER_MIN)) {
      return reply.code(429).send({ accepted: false, reason: 'rate_limited' });
    }
    const inbound = integration as InboundIntegration;
    const at = now();
    const verdict = await verify(request, inbound, deps.integrations.secrets(integration.id), deps);
    if (!verdict.ok) {
      // Adres źródłowy tak, ładunek nie: odrzucone żądanie może być cudze.
      deps.integrationEvents.record({ integrationId: integration.id, at, result: 'rejected', reason: verdict.reason, sourceIp: request.ip, logLimit: inbound.config.eventLogLimit });
      deps.notifier?.notify('integration_error', `integration:${integration.id}`, `${integration.name}: odrzucone uwierzytelnienie (${verdict.reason})`, at);
      log.warn('integracja.odrzucona', { integrationId: integration.id, ip: request.ip });
      return reply.code(verdict.status).send({ accepted: false, reason: 'unauthorized' });
    }

    const payload = request.body ?? {};
    const outcome = runInbound(deps, inbound, payload, { sourceIp: request.ip }, at);
    switch (outcome.kind) {
      case 'sent':
        return reply.code(202).send({ accepted: true, messageIds: outcome.messageIds });
      // 200 przy odrzuceniu jest celowe: aplikacje źródłowe biorą je za sukces i nie ponawiają.
      case 'skipped':
        return reply.code(200).send({ accepted: false, reason: 'condition' });
      case 'duplicate':
        return reply.code(200).send({ accepted: false, reason: 'duplicate' });
      case 'throttled':
        if (outcome.notify) {
          deps.notifier?.notify('integration_throttled', `integration:${integration.id}`,
            `${integration.name}: przekroczony limit ${inbound.config.throttle.limit} w ${inbound.config.throttle.windowMinutes} min`, at);
        }
        return reply.code(200).send({ accepted: false, reason: 'throttled' });
      case 'unavailable':
        deps.notifier?.notify('integration_error', `integration:${integration.id}`, `${integration.name}: ${outcome.detail}`, at);
        return reply.code(503).send({ accepted: false, reason: 'unavailable', detail: outcome.detail });
      case 'error': {
        // Mail do administratora bez numeru z ładunku: numer to dana osobowa, a szczegół wystarczy w odpowiedzi i dzienniku.
        const summary = outcome.code === 'invalid_phone' ? 'nieprawidłowy numer odbiorcy w ładunku' : outcome.detail;
        deps.notifier?.notify('integration_error', `integration:${integration.id}`, `${integration.name}: ${summary}`, at);
        return reply.code(422).send({ accepted: false, reason: outcome.code, detail: outcome.detail });
      }
    }
  });
}
