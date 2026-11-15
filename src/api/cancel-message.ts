import { ProviderError } from '../multiinfo/response.ts';
import { ApiError } from './errors.ts';
import type { ApiDeps } from './server.ts';

/** Stany, z których wiadomość już nie wyjdzie - anulowanie nie ma czego zatrzymać. */
export const FINAL_STATUSES: ReadonlySet<string> = new Set(['delivered', 'failed', 'expired', 'cancelled', 'blocked']);

/**
 * Anulowanie wiadomości klucza, wspólne dla `POST /v1/messages/{id}/cancel` i narzędzia agenta. Błędy są błędami API
 * z kodem i komunikatem dla człowieka.
 */
export async function cancelMessage(
  deps: Pick<ApiDeps, 'messages' | 'events' | 'clients' | 'shortLinks'>, apiKeyId: number, messageId: string, now: Date,
): Promise<{ id: string; status: 'cancelled' }> {
  const message = deps.messages.get(messageId);
  // Brak wiadomości, cudza wiadomość i wiadomość systemowa (SMS powiadomienia administratora) dają tę samą
  // odpowiedź - nie potwierdzamy istnienia.
  if (!message || message.apiKeyId !== apiKeyId || message.system === 1) {
    throw new ApiError(404, 'message_not_found', 'Nie ma wiadomości o tym identyfikatorze.');
  }
  if (FINAL_STATUSES.has(message.status)) {
    throw new ApiError(409, 'already_final', `Wiadomość ma już stan ostateczny: ${message.status}.`);
  }

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
          deps.events.record(message.id, now, 'cancel_partial', `anulowano części: ${cancelled.join(', ')}`);
        }
        if (e.code === -41) {
          throw new ApiError(409, 'already_passed',
            'Wiadomość została już przekazana do abonenta i nie można jej anulować.', e.code);
        }
        if (e.kind === 'certificate') {
          throw new ApiError(503, 'account_certificate', 'Multiinfo odrzuciło certyfikat bramki.', e.code);
        }
        throw new ApiError(502, 'provider_error', e.message, e.code);
      }
    }
  }

  deps.messages.setStatus(message.id, { status: 'cancelled', finalAt: now, error: null });
  // Krótkie linki anulowanej wiadomości prowadzą od tej chwili do strony „Link wygasł”.
  deps.shortLinks.disableMessage(message.id, now);
  deps.events.record(message.id, now, 'cancelled', message.miIds.length === 0
    ? 'przed przekazaniem do Multiinfo'
    : `cancelsms.aspx: ${message.miIds.join(', ')}`);
  return { id: message.id, status: 'cancelled' };
}
