/**
 * Kanał SMS powiadomień administratora (spec 8.1): wysyłka w imieniu klucza wskazanego w ustawieniach,
 * z jego konta, usługi, limitów i nadpisu. Wiadomości są systemowe, więc API, webhook klucza
 * i integracje wychodzące ich nie widzą.
 */
import { ApiError } from '../api/errors.ts';
import { authFromKey, keyUsable, submitMessages, type SubmitDeps } from '../api/submit.ts';
import { fitToParts } from '../integrations/pipeline.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { NotificationsRepo } from '../store/notifications.ts';

/** Zlecający widoczny w panelu przy wiadomościach kanału SMS. */
export const SYSTEM_REQUESTER = 'Powiadomienie bramki';

export type SmsSendDeps = SubmitDeps & { apiKeys: Pick<ApiKeysRepo, 'get'>; notifications: Pick<NotificationsRepo, 'smsSettings'> };

/**
 * Jedna część GSM-7 na każdy numer. Przełącznik „Wysyłaj powiadomienia SMS” sprawdza wołający, bo SMS
 * testowy działa także przed włączeniem kanału. `to` zastępuje numery z ustawień.
 */
export function sendNotificationSms(deps: SmsSendDeps, text: string, now: Date, to?: string[]):
  { ok: true; ids: string[] } | { ok: false; reason: string } {
  const settings = deps.notifications.smsSettings();
  if (!settings || settings.apiKeyId === null) return { ok: false, reason: 'kanał SMS nie wskazuje klucza API' };
  const recipients = to ?? settings.recipients;
  if (recipients.length === 0) return { ok: false, reason: 'kanał SMS nie zawiera numerów' };
  const key = deps.apiKeys.get(settings.apiKeyId);
  if (!key) return { ok: false, reason: 'klucz API kanału SMS nie istnieje' };
  const usable = keyUsable(key, now);
  if (!usable.ok) return usable;
  try {
    const results = submitMessages(deps, authFromKey(key), {
      to: recipients, text: fitToParts(text, 1, 'gsm').text, encoding: 'gsm', maxParts: 1,
      system: true, requestedBy: SYSTEM_REQUESTER, ...(settings.orig ? { orig: settings.orig } : {}),
    }, now);
    return { ok: true, ids: results.map((r) => r.id) };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, reason: e.message };
    throw e;
  }
}
