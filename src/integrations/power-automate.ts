import { ApiError } from '../api/errors.ts';
import type { PaGroupBody, PaMessageBody, PaPackageBody } from '../api/pa-integrations.ts';
import type { ApiDeps } from '../api/server.ts';
import { packageEncoding, submitPackage, type PackageAccepted } from '../api/submit-package.ts';
import { authFromKey, submitMessages, type SubmitResult } from '../api/submit.ts';
import type { IntegrationEventInput } from '../store/integration-events.ts';
import type { IntegrationRow } from '../store/integrations.ts';
import { measureText, type EncodingRequest } from '../text/measure.ts';
import { normalizePhone } from '../text/phone.ts';
import { segmentText } from '../text/segment.ts';
import type { PowerAutomateConfig } from './config.ts';
import { fitToParts, resolveKeyAccount, type PipelineDeps } from './pipeline.ts';

export type PowerAutomateIntegration = IntegrationRow & { kind: 'power_automate'; config: PowerAutomateConfig };

/** Jedno wywołanie akcji wysyłającej konektora, już po sprawdzeniu ciała. */
export type PaCall =
  | { action: 'sms'; body: PaMessageBody }
  | { action: 'package'; body: PaPackageBody }
  | { action: 'group'; body: PaGroupBody };

export type PaOutcome =
  | { kind: 'sent'; messages: Array<SubmitResult & { to: string }> }
  | { kind: 'sent'; package: PackageAccepted }
  | { kind: 'throttled'; notify: boolean; by: 'calls' | 'recipients' }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'error'; error: ApiError };

/** Nazwa akcji tak, jak widzi ją autor przepływu; od niej zaczyna się powód wpisu w dzienniku. */
const ACTION_LABEL: Record<PaCall['action'], string> = { sms: 'Wyślij SMS', package: 'Wyślij rozsyłkę', group: 'Wyślij SMS do grupy' };
export const paActionLabel = (action: PaCall['action']): string => ACTION_LABEL[action];

const recipientsWord = (n: number): string => `${n} ${n === 1 ? 'odbiorca' : 'odbiorców'}`;

/** Liczba części bez limitu, do komunikatu o nadmiarze. */
const neededParts = (text: string, encoding: EncodingRequest): number =>
  segmentText(text, measureText(text, encoding), Number.MAX_SAFE_INTEGER).parts;

/**
 * Potok integracji Power Automate: klucz i konto, ochrona przed burzą, limit części każdej treści,
 * wysyłka usługą i nadpisem integracji, wpis w dzienniku. Każde wyjście zapisuje wpis; wołający
 * zamienia wynik na odpowiedź HTTP i ewentualne powiadomienie administratora.
 */
export function runPowerAutomate(
  deps: PipelineDeps & Pick<ApiDeps, 'packages'>, integration: PowerAutomateIntegration, call: PaCall,
  meta: { sourceIp: string; idempotencyKey?: string }, now: Date,
): PaOutcome {
  const config = integration.config;
  const label = ACTION_LABEL[call.action];
  const stored = integration.storePayloads === 1 ? JSON.stringify(call.body) : null;
  const note = (result: IntegrationEventInput['result'], extra: Partial<IntegrationEventInput> = {}): void => {
    deps.integrationEvents.record({ integrationId: integration.id, at: now, result, sourceIp: meta.sourceIp, payload: stored, logLimit: config.eventLogLimit, ...extra });
  };

  const resolved = resolveKeyAccount(deps, integration, now);
  if (!resolved.ok) {
    note('error', { reason: `${label}: ${resolved.detail}` });
    return { kind: 'unavailable', detail: resolved.detail };
  }

  // Burza liczy wywołania i odbiorców: zapętlony przepływ zatrzymuje się, zanim cokolwiek trafi do kolejki.
  const { limit, windowMinutes, recipients: recipientLimit } = config.throttle;
  const count = call.action === 'sms' ? 1 : call.action === 'package' ? call.body.recipients.length : config.recipients.length;
  const gate = deps.guards.throttle(integration.id, limit, windowMinutes, now, { count, limit: recipientLimit });
  if (!gate.allowed) {
    const by = gate.by ?? 'calls';
    note('throttled', { reason: by === 'calls' ? `ponad ${limit} w ${windowMinutes} min` : `ponad ${recipientLimit} odbiorców w ${windowMinutes} min` });
    return { kind: 'throttled', notify: gate.notify, by };
  }

  const auth = authFromKey(resolved.key);
  const requestedBy = call.body.requestedBy || undefined;
  const via = {
    integrationId: integration.id,
    ...(integration.serviceId ? { serviceId: integration.serviceId } : {}),
    ...(integration.orig ? { orig: integration.orig } : {}),
    ...(requestedBy ? { requestedBy } : {}),
  };
  let cut = false;
  /**
   * Treść w limicie części integracji: przycięta albo odrzucona z miejscem w ciele żądania.
   * Rozsyłka liczy każdą treść w kodowaniu całej rozsyłki, bo tak wyśle ją Multiinfo.
   */
  const fit = (text: string, where = '', encoding: EncodingRequest = call.body.encoding): string => {
    const fitted = fitToParts(text, config.maxParts, encoding);
    if (!fitted.over) return text;
    if (config.overflow === 'reject') {
      throw new ApiError(400, 'too_many_parts',
        `${where}Treść wymaga ${neededParts(text, encoding)} części, a limit integracji to ${config.maxParts}.`);
    }
    cut = true;
    return fitted.text;
  };
  const withCut = (reason: string): string => (cut ? `${reason}; skrócono do ${config.maxParts} części` : reason);

  try {
    if (call.action === 'package') {
      const b = call.body;
      const encoding = packageEncoding([b.defaultText, ...b.recipients.map((r) => r.text)], b.encoding);
      const defaultText = b.defaultText === undefined ? undefined : fit(b.defaultText, 'defaultText: ', encoding);
      const recipients = b.recipients.map((r, i) => ({
        to: r.to,
        ...(r.text !== undefined ? { text: fit(r.text, `recipients.${i}: `, encoding) } : {}),
        ...(r.clientId !== undefined ? { clientId: r.clientId } : {}),
      }));
      const accepted = submitPackage(deps, auth, {
        recipients, defaultText, startAt: b.startAt, deliveryReport: b.deliveryReport, encoding: b.encoding,
        costCenter: b.costCenter, maxParts: config.maxParts, ...via,
      }, now);
      note('sent', { reason: withCut(`${label}, ${recipientsWord(accepted.recipients)}`), packageId: accepted.id });
      return { kind: 'sent', package: accepted };
    }

    const b = call.body;
    const text = fit(b.text);
    const to = call.action === 'sms' ? [call.body.to] : config.recipients.map((r) => r.phone);
    if (to.length === 0) {
      throw new ApiError(409, 'group_empty',
        `Integracja ${integration.name} nie ma odbiorców grupy. Listę uzupełnia administrator w panelu bramki.`);
    }
    const results = submitMessages(deps, auth, {
      to, text, encoding: b.encoding, deliveryReport: b.deliveryReport, maxParts: config.maxParts, ...via,
      ...(b.validTo !== undefined ? { validTo: b.validTo } : {}),
      ...(b.costCenter !== undefined ? { costCenter: b.costCenter } : {}),
      ...(meta.idempotencyKey !== undefined ? { idempotencyKey: meta.idempotencyKey } : {}),
    }, now);
    // Numery przeszły już sprawdzenie w `submitMessages`, więc normalizacja tutaj zawsze się udaje.
    const messages = results.map((r, i) => ({ ...r, to: normalizePhone(to[i]!, resolved.account.defaultCountryCode) }));
    const reason = call.action === 'sms' ? label : `${label}, ${recipientsWord(results.length)}`;
    note('sent', { reason: withCut(reason), ...(results[0] ? { messageId: results[0].id } : {}) });
    return { kind: 'sent', messages };
  } catch (e) {
    if (e instanceof ApiError) {
      note('error', { reason: `${label}: ${e.message}` });
      return { kind: 'error', error: e };
    }
    throw e;
  }
}
