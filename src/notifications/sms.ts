/**
 * Kanał SMS powiadomień administratora (spec 8.1): wysyłka w imieniu klucza wskazanego w ustawieniach,
 * z jego konta, usługi, limitów i nadpisu. Wiadomości są systemowe, więc API, webhook klucza
 * i integracje wychodzące ich nie widzą.
 */
import { ApiError } from '../api/errors.ts';
import { keyOrigs } from '../api/orig.ts';
import { authFromKey, keyUsable, submitMessages, type SubmitDeps } from '../api/submit.ts';
import { fitToParts } from '../integrations/pipeline.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { NotificationsRepo } from '../store/notifications.ts';
import { lastValidDay } from '../time/warsaw.ts';

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

/**
 * Powód, dla którego kanał nie wyśle powiadomienia, albo `null`. Sprawdza to samo co wysyłka: numery, klucz,
 * jego konto, usługę i nadpis. Panel pokazuje wynik na przeglądzie i w zakładce SMS, ponieważ zmiana klucza
 * albo konta zatrzymałaby kanał bez śladu poza logiem.
 */
export function smsChannelProblem(deps: Pick<SmsSendDeps, 'notifications' | 'apiKeys' | 'accounts'>, now: Date): string | null {
  const settings = deps.notifications.smsSettings();
  const key = settings?.apiKeyId == null ? undefined : deps.apiKeys.get(settings.apiKeyId);
  if (!settings || !key) return 'kanał nie wskazuje klucza API';
  if (settings.recipients.length === 0) return 'kanał nie zawiera numerów';
  const name = `klucz API „${key.name}”`;
  if (key.revokedAt !== null) return `${name} został odwołany`;
  if (key.expiresAt !== null && Date.parse(key.expiresAt) <= now.getTime()) return `${name} wygasł ${lastValidDay(key.expiresAt)}`;
  const account = deps.accounts.get(key.accountId);
  if (!account) return `konto Multiinfo, do którego należy ${name}, nie istnieje`;
  if (account.pausedReason !== null) return `konto Multiinfo „${account.name}” jest wstrzymane`;
  const auth = authFromKey(key);
  if (auth.defaultServiceId === null) return `${name} nie wskazuje domyślnej usługi`;
  if (!auth.allowedServiceIds.includes(auth.defaultServiceId)) return `${name} nie ma dostępu do usługi ${auth.defaultServiceId}`;
  if (settings.orig !== null && !keyOrigs(auth, account, deps.accounts).allowed.includes(settings.orig)) {
    return `${name} nie może już użyć nadpisu „${settings.orig}”`;
  }
  return null;
}
