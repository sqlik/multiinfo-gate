import type { FastifyInstance } from 'fastify';
import { ProviderError } from '../multiinfo/response.ts';
import { authenticate } from './auth.ts';
import { ApiError } from './errors.ts';
import type { ApiDeps } from './server.ts';

/** Stany, z których wiadomość już nie wyjdzie - anulowanie nie ma czego zatrzymać. */
const FINAL = new Set(['delivered', 'failed', 'expired', 'cancelled', 'blocked']);

export function registerCancelRoute(app: FastifyInstance, deps: ApiDeps): void {
  const now = deps.now ?? (() => new Date());

  app.post<{ Params: { id: string } }>('/v1/messages/:id/cancel', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    const message = deps.messages.get(request.params.id);
    // Brak wiadomości i cudza wiadomość dają tę samą odpowiedź - nie potwierdzamy istnienia.
    if (!message || message.apiKeyId !== auth.apiKeyId) {
      throw new ApiError(404, 'message_not_found', 'Nie ma wiadomości o tym identyfikatorze.');
    }
    if (FINAL.has(message.status)) {
      throw new ApiError(409, 'already_final', `Wiadomość ma już stan ostateczny: ${message.status}.`);
    }

    const at = now();
    if (message.miIds.length > 0) {
      const client = deps.clients.for(message.accountId);
      const cancelled: string[] = [];
      for (const miId of message.miIds) {
        try {
          await client.cancel(miId);
          cancelled.push(miId);
        } catch (e) {
          if (!(e instanceof ProviderError)) throw e;
          // Część już anulowanych zostaje anulowana - odnotowujemy to, choć całość się nie udała.
          if (cancelled.length > 0) {
            deps.events.record(message.id, at, 'cancel_partial', `anulowano części: ${cancelled.join(', ')}`);
          }
          if (e.code === -41) {
            throw new ApiError(409, 'already_passed',
              'Wiadomość została już przekazana do abonenta i nie da się jej anulować.', e.code);
          }
          if (e.kind === 'certificate') {
            throw new ApiError(503, 'account_certificate', 'Multiinfo odrzuciło certyfikat bramki.', e.code);
          }
          throw new ApiError(502, 'provider_error', e.message, e.code);
        }
      }
    }

    deps.messages.setStatus(message.id, { status: 'cancelled', finalAt: at, error: null });
    deps.events.record(message.id, at, 'cancelled', message.miIds.length === 0
      ? 'przed przekazaniem do Multiinfo'
      : `cancelsms.aspx: ${message.miIds.join(', ')}`);
    return { id: message.id, status: 'cancelled' };
  });
}
