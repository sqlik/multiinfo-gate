import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PowerAutomateConfig } from '../integrations/config.ts';
import { paActionLabel, payloadForLog, runPowerAutomate, type PaCall, type PowerAutomateIntegration } from '../integrations/power-automate.ts';
import { silentLogger } from '../log.ts';
import { authenticate } from './auth.ts';
import { dropEmptyFields } from './empty-fields.ts';
import { ApiError } from './errors.ts';
import { messageBodySchema } from './messages.ts';
import { keyBeforeBody, PACKAGE_BODY_LIMIT, packageBodySchema } from './packages.ts';
import type { ApiDeps } from './server.ts';

/** Identyfikator integracji w API: stały numer integracji, więc zmiana nazwy nie psuje przepływu. */
const PA_API_ID = /^int_([1-9]\d{0,9})$/;

export const paIntegrationApiId = (integrationId: number): string => `int_${integrationId}`;

export function parsePaIntegrationApiId(raw: string): number | null {
  const match = PA_API_ID.exec(raw);
  return match ? Number(match[1]) : null;
}

/**
 * Kto zlecił wysyłkę w przepływie. Trafia do dziennika integracji oraz do wiadomości i rozsyłki,
 * nigdy do treści SMS-a. Bez znaków sterujących, bo dziennik pokazuje go w jednym wierszu.
 * Wartość z samych spacji znaczy to samo, co pole pominięte.
 */
export const requestedBySchema = z.string()
  .trim()
  .max(100, 'Zlecający może liczyć najwyżej 100 znaków.')
  // Także znaki niewidoczne i zmieniające kierunek tekstu: pozwoliłyby podszyć się pod innego zlecającego.
  .regex(/^[^\p{C}\p{Zl}\p{Zp}]*$/u, 'Zlecający nie może zawierać znaków sterujących ani niewidocznych znaków formatowania, na przykład końca wiersza.')
  .optional();

/**
 * „Wyślij SMS”: jeden numer i treść. Usługę, nadpis i limit części wyznacza integracja, więc tych
 * pól nie ma. Zod pomija nieznane pola: `serviceId` albo `orig` w żądaniu nic nie zmienia.
 * Pusty numer kończy wywołanie błędem i nigdy nie oznacza wysyłki do listy odbiorców integracji.
 */
export const paMessageBodySchema = z
  .object({
    // Numer na początku: Power Automate pokazuje pola w kolejności schematu.
    to: z.string({ error: (issue) => (issue.input === undefined ? 'Numer odbiorcy jest pusty.' : 'Numer odbiorcy musi być tekstem.') })
      .trim()
      .min(1, 'Numer odbiorcy jest pusty.'),
  })
  .merge(messageBodySchema.omit({ to: true, serviceId: true, orig: true, inReplyTo: true, maxParts: true }))
  .extend({ requestedBy: requestedBySchema });

/** „Wyślij rozsyłkę”: pola jak w `POST /v1/packages` bez usługi i nadpisu. */
export const paPackageBodySchema = packageBodySchema.omit({ serviceId: true, orig: true }).extend({ requestedBy: requestedBySchema });

/** „Wyślij SMS do grupy”: sama treść, odbiorców wyznacza lista integracji. */
export const paGroupBodySchema = messageBodySchema
  .omit({ to: true, serviceId: true, orig: true, inReplyTo: true, maxParts: true })
  .extend({ requestedBy: requestedBySchema });

export type PaMessageBody = z.infer<typeof paMessageBodySchema>;
export type PaPackageBody = z.infer<typeof paPackageBodySchema>;
export type PaGroupBody = z.infer<typeof paGroupBodySchema>;

/** Ścieżka wywołania, akcja potoku, schemat ciała i pola z listą obiektów (puste pola w każdym elemencie). */
const ACTIONS = [
  { path: 'messages', action: 'sms', schema: paMessageBodySchema, nested: [] },
  { path: 'packages', action: 'package', schema: paPackageBodySchema, nested: ['recipients'] },
  { path: 'group', action: 'group', schema: paGroupBodySchema, nested: [] },
] as const;

/** Zlecający z surowego ciała, także gdy reszta ciała jest błędna: dziennik pokazuje wtedy, kto wywołał. */
function requestedByOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const parsed = requestedBySchema.safeParse((raw as Record<string, unknown>).requestedBy);
  return parsed.success && parsed.data ? parsed.data : undefined;
}

export function registerPaIntegrationRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;

  app.get('/v1/integrations', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    // Tylko nazwa i liczba odbiorców: numery i nazwiska zostają w panelu bramki.
    const data = deps.integrations.listForKey(auth.apiKeyId)
      .filter((row) => row.kind === 'power_automate' && row.enabled === 1)
      .map((row) => ({ id: paIntegrationApiId(row.id), name: row.name, recipients: (row.config as PowerAutomateConfig).recipients.length }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    return { data };
  });

  for (const { path, action, schema, nested } of ACTIONS) {
    // Rozsyłka do 5000 odbiorców z własnymi treściami potrzebuje limitu tras rozsyłki.
    const options = path === 'packages' ? { bodyLimit: PACKAGE_BODY_LIMIT, onRequest: keyBeforeBody(deps) } : {};
    app.post<{ Params: { id: string } }>(`/v1/integrations/:id/${path}`, options, async (request, reply) => {
      const auth = authenticate(request.headers.authorization, deps.apiKeys);
      if (!deps.rateLimiter.check(auth.apiKeyId, auth.ratePerMin)) {
        throw new ApiError(429, 'rate_limited', `Przekroczono limit ${auth.ratePerMin} żądań na minutę.`);
      }

      // Brak, integracja innego klucza i integracja innego rodzaju dają tę samą odpowiedź - nie potwierdzamy istnienia.
      const id = parsePaIntegrationApiId(request.params.id);
      const row = id === null ? undefined : deps.integrations.getOwned(id, auth.apiKeyId, 'power_automate');
      if (!row) {
        throw new ApiError(404, 'integration_not_found', 'Nie ma integracji Power Automate o tym identyfikatorze.');
      }
      // Wyłączona bez wpisu w dzienniku: tak samo milczy wyłączony webhook.
      if (row.enabled !== 1) {
        throw new ApiError(409, 'integration_disabled', `Integracja ${row.name} jest wyłączona w panelu bramki.`);
      }
      const integration = row as PowerAutomateIntegration;
      const at = now();
      const label = paActionLabel(action);
      const subject = `integration:${integration.id}`;
      const raw = dropEmptyFields(request.body, [...nested]);
      // Kolumna „Nadawca” dziennika: zlecający z przepływu i zawsze adres wywołania, bo zlecającego
      // podaje sam przepływ i mógłby udawać adres.
      const requestedBy = requestedByOf(raw);
      const sourceIp = requestedBy ? `API · ${requestedBy} · ${request.ip}` : `API · ${request.ip}`;

      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        deps.integrationEvents.record({
          integrationId: integration.id, at, result: 'error', reason: `${label}: ${detail}`, sourceIp,
          payload: integration.storePayloads === 1 ? payloadForLog(request.body) : null, logLimit: integration.config.eventLogLimit,
        });
        deps.notifier?.notify('integration_error', subject, `${integration.name}: ${label}: ${detail}`, at);
        log.warn('integracja.blad', { integrationId: integration.id, code: 'invalid_body' });
        throw new ApiError(400, 'invalid_body', detail);
      }

      const idempotencyKey = request.headers['idempotency-key'];
      const call = { action, body: parsed.data } as PaCall;
      const outcome = runPowerAutomate(deps, integration, call, {
        sourceIp, ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
      }, at);

      switch (outcome.kind) {
        case 'sent': {
          reply.code(202);
          if ('package' in outcome) return outcome.package;
          if (action === 'sms') {
            // Kształt odpowiedzi `POST /v1/messages` dla jednego numeru.
            const { to: _to, ...accepted } = outcome.messages[0]!;
            return accepted;
          }
          // Bez numerów: odpowiedź trafia do historii przebiegów w chmurze Microsoftu, a lista zostaje w bramce.
          return {
            integration: { id: paIntegrationApiId(integration.id), name: integration.name },
            recipients: outcome.messages.length,
            messages: outcome.messages.map((m) => ({ id: m.id, status: m.status, parts: m.parts })),
          };
        }
        case 'throttled': {
          const { limit, windowMinutes, recipients } = integration.config.throttle;
          const what = outcome.by === 'calls' ? `${limit} wysyłek` : `${recipients} odbiorców`;
          if (outcome.notify) {
            const short = outcome.by === 'calls' ? `${limit}` : `${recipients} odbiorców`;
            deps.notifier?.notify('integration_throttled', subject, `${integration.name}: przekroczony limit ${short} w ${windowMinutes} min`, at);
          }
          throw new ApiError(429, 'integration_throttled',
            `Integracja ${integration.name} przekroczyła limit ${what} w ${windowMinutes} min. Spróbuj później albo poproś administratora o zmianę limitu.`);
        }
        case 'unavailable':
          deps.notifier?.notify('integration_error', subject, `${integration.name}: ${outcome.detail}`, at);
          log.warn('integracja.niedostepna', { integrationId: integration.id });
          // Powód (na przykład treść błędu certyfikatu) zostaje w dzienniku i w mailu do administratora.
          throw new ApiError(503, 'integration_unavailable',
            `Integracja ${integration.name} nie może teraz wysyłać SMS-ów. Przyczynę podaje dziennik integracji w panelu bramki.`);
        case 'error': {
          // Mail do administratora bez numeru z wywołania: numer to dana osobowa, szczegół jest w dzienniku.
          const summary = outcome.error.code === 'invalid_phone' ? 'nieprawidłowy numer odbiorcy' : outcome.error.message;
          deps.notifier?.notify('integration_error', subject, `${integration.name}: ${label}: ${summary}`, at);
          log.warn('integracja.blad', { integrationId: integration.id, code: outcome.error.code });
          throw outcome.error;
        }
      }
    });
  }
}
