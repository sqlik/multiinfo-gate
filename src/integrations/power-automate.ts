import { ApiError } from '../api/errors.ts';
import { linkRequest } from '../api/link-fields.ts';
import type { PaGroupBody, PaMessageBody, PaPackageBody } from '../api/pa-integrations.ts';
import type { ApiDeps } from '../api/server.ts';
import { packageEncoding, submitPackage, type PackageAccepted } from '../api/submit-package.ts';
import { authFromKey, submitMessages, type SubmitResult } from '../api/submit.ts';
import { fitPrepared, onceSettings, prepareLinks, type PreparedText } from '../links/shortener.ts';
import type { IntegrationEventInput } from '../store/integration-events.ts';
import type { IntegrationRow } from '../store/integrations.ts';
import { measureText, type EncodingRequest } from '../text/measure.ts';
import { normalizePhone } from '../text/phone.ts';
import { segmentText } from '../text/segment.ts';
import type { PowerAutomateConfig } from './config.ts';
import { resolveKeyAccount, type PipelineDeps } from './pipeline.ts';

export type PowerAutomateIntegration = IntegrationRow & { kind: 'power_automate'; config: PowerAutomateConfig };

/** Jedno wywołanie akcji wysyłającej konektora, już po sprawdzeniu body. */
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

/** Największy ładunek zapisywany w dzienniku integracji; rozsyłka do 5000 odbiorców zajmuje około 1 MB. */
const PAYLOAD_LOG_LIMIT = 64 * 1024;

/**
 * Ładunek do dziennika: dziennik przechowuje do 2000 wpisów przez 7 dni, a każda kopia nocna
 * powiela bazę, więc duże rozsyłki zastępuje zdanie z rozmiarem.
 */
export function payloadForLog(body: unknown): string {
  const json = JSON.stringify(body ?? null);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= PAYLOAD_LOG_LIMIT) return json;
  return JSON.stringify({ uwaga: `Ładunek liczy ${Math.ceil(bytes / 1024)} KB, więcej niż 64 KB, dlatego dziennik go nie przechowuje.` });
}

/** Nazwa akcji tak, jak widzi ją autor przepływu; od niej zaczyna się powód wpisu w dzienniku. */
const ACTION_LABEL: Record<PaCall['action'], string> = { sms: 'Wyślij SMS', package: 'Wyślij rozsyłkę', group: 'Wyślij SMS do grupy' };
export const paActionLabel = (action: PaCall['action']): string => ACTION_LABEL[action];

const recipientsWord = (n: number): string => `${n} ${n === 1 ? 'odbiorca' : 'odbiorców'}`;

/** Liczba części bez limitu, do komunikatu o nadmiarze. */
const neededParts = (text: string, encoding: EncodingRequest): number =>
  segmentText(text, measureText(text, encoding), Number.MAX_SAFE_INTEGER).parts;

/**
 * Czy każda wysyłka tego wywołania istnieje już pod tym kluczem idempotencji. Grupa zapisuje klucz
 * z numerem pozycji (`klucz#0`, `klucz#1`), gdy ma więcej niż jednego odbiorcę. Lista, która od tamtej
 * pory urosła, zawiera nowe numery, więc takie wywołanie nie jest powtórzeniem.
 */
function seenBefore(
  deps: Pick<PipelineDeps, 'messages'> & Pick<ApiDeps, 'packages'>, apiKeyId: number, call: PaCall, config: PowerAutomateConfig, key: string,
): boolean {
  if (call.action === 'package') return deps.packages.findByIdempotencyKey(apiKeyId, key) !== undefined;
  const n = call.action === 'sms' ? 1 : config.recipients.length;
  if (n === 0) return false;
  const keys = n === 1 ? [key] : Array.from({ length: n }, (_, i) => `${key}#${i}`);
  return keys.every((k) => deps.messages.findByIdempotencyKey(apiKeyId, k) !== undefined);
}

/**
 * Potok integracji z Power Automate: klucz i konto, ochrona przed burzą, limit części każdej treści,
 * wysyłka usługą i nadpisem integracji, wpis w dzienniku. Każde wyjście zapisuje wpis; wołający
 * zamienia wynik na odpowiedź HTTP i ewentualne powiadomienie administratora.
 */
export function runPowerAutomate(
  deps: PipelineDeps & Pick<ApiDeps, 'packages' | 'log'>, integration: PowerAutomateIntegration, call: PaCall,
  meta: { sourceIp: string; idempotencyKey?: string }, now: Date,
): PaOutcome {
  const config = integration.config;
  const label = ACTION_LABEL[call.action];
  const stored = integration.storePayloads === 1 ? payloadForLog(call.body) : null;
  const note = (result: IntegrationEventInput['result'], extra: Partial<IntegrationEventInput> = {}): void => {
    deps.integrationEvents.record({ integrationId: integration.id, at: now, result, sourceIp: meta.sourceIp, payload: stored, logLimit: config.eventLogLimit, ...extra });
  };

  const resolved = resolveKeyAccount(deps, integration, now);
  if (!resolved.ok) {
    note('error', { reason: `${label}: ${resolved.detail}` });
    return { kind: 'unavailable', detail: resolved.detail };
  }

  // Powtórzenie z tym samym kluczem idempotencji niczego nie wysyła, więc nie liczy się do burzy:
  // przepływ, który ponawia akcję, otrzymuje pierwotną odpowiedź zamiast 429.
  const repeated = meta.idempotencyKey !== undefined && seenBefore(deps, resolved.key.id, call, config, meta.idempotencyKey);

  // Burza liczy wywołania i odbiorców: zapętlony przepływ zatrzymuje się, zanim cokolwiek trafi do kolejki.
  const { limit, windowMinutes, recipients: recipientLimit } = config.throttle;
  const count = call.action === 'sms' ? 1 : call.action === 'package' ? call.body.recipients.length : config.recipients.length;
  const gate = repeated ? { allowed: true as const } : deps.guards.throttle(integration.id, limit, windowMinutes, now, { count, limit: recipientLimit });
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
    // Kampania bez nazwy w żądaniu otrzymuje nazwę integracji.
    campaignFallback: integration.name,
  };
  // Pola skracania z body akcji; ustawienie klucza ma pierwszeństwo, tak jak w API.
  const links = linkRequest(call.body);
  const shortener = onceSettings(deps);
  const prepare = (text: string): PreparedText => prepareLinks(shortener, auth.apiKeyId, text, links, {});
  let cut = false;
  /**
   * Szablon w limicie części integracji: przycięty albo odrzucony z miejscem w body żądania. Limit
   * dotyczy treści po skróceniu linków, a przycięcie usuwa przecięty krótki link w całości.
   * Rozsyłka liczy każdą treść w kodowaniu całej rozsyłki, bo tak wyśle ją Multiinfo.
   */
  const fit = (template: PreparedText, where = '', encoding: EncodingRequest = call.body.encoding): PreparedText => {
    const fitted = fitPrepared(template, config.maxParts, encoding);
    if (!fitted.over) return template;
    if (config.overflow === 'reject') {
      throw new ApiError(400, 'too_many_parts',
        `${where}Treść wymaga ${neededParts(template.text, encoding)} części, a limit integracji to ${config.maxParts}.`);
    }
    cut = true;
    return fitted.prepared;
  };
  const withCut = (reason: string): string => (cut ? `${reason}; skrócono do ${config.maxParts} części` : reason);
  /**
   * Wpis po przyjęciu: „wysłano” albo „duplikat”, gdy wywołanie powtórzyło klucz idempotencji.
   * Wysyłka jest już w kolejce, więc błąd zapisu wpisu nie może zamienić wyniku w błąd: przepływ
   * ponowiłby akcję i wysłał SMS drugi raz.
   */
  const accepted = (reason: string, extra: Partial<IntegrationEventInput>): void => {
    try {
      if (repeated) note('duplicate', { reason: `${reason}, powtórzony klucz idempotencji`, ...extra });
      else note('sent', { reason: withCut(reason), ...extra });
    } catch (error) {
      deps.log?.error('integracja.dziennik_blad', { integrationId: integration.id, error });
    }
  };

  try {
    if (call.action === 'package') {
      const b = call.body;
      // Kodowanie z szablonów: polski znak wyłącznie w adresie skracanego linku nie przełącza rozsyłki na UCS-2.
      const defaultTemplate = b.defaultText === undefined ? undefined : prepare(b.defaultText);
      const ownTemplates = b.recipients.map((r) => (r.text === undefined ? undefined : prepare(r.text)));
      const encoding = packageEncoding([defaultTemplate?.text, ...ownTemplates.map((t) => t?.text)], b.encoding);
      const prepared = {
        ...(defaultTemplate === undefined ? {} : { defaultText: fit(defaultTemplate, 'defaultText: ', encoding) }),
        recipients: ownTemplates.map((t, i) => (t === undefined ? undefined : fit(t, `recipients.${i}: `, encoding))),
      };
      // Treści przed skróceniem trafiają do skrótu idempotencji, a szablony do wysyłki.
      const pkg = submitPackage(deps, auth, {
        recipients: b.recipients, defaultText: b.defaultText, startAt: b.startAt, deliveryReport: b.deliveryReport, encoding: b.encoding,
        costCenter: b.costCenter, maxParts: config.maxParts, links, prepared, ...via,
        ...(meta.idempotencyKey !== undefined ? { idempotencyKey: meta.idempotencyKey } : {}),
      }, now);
      accepted(repeated ? label : `${label}, ${recipientsWord(pkg.recipients)}`, { packageId: pkg.id });
      return { kind: 'sent', package: pkg };
    }

    const b = call.body;
    const to = call.action === 'sms' ? [call.body.to] : config.recipients.map((r) => r.phone);
    // Pusta lista przed długością treści: skrócenie treści nie pomoże, gdy nie ma do kogo wysłać.
    if (to.length === 0) {
      throw new ApiError(409, 'group_empty',
        `Integracja ${integration.name} nie ma odbiorców grupy. Listę uzupełnia administrator w panelu bramki.`);
    }
    const prepared = fit(prepare(b.text));
    const results = submitMessages(deps, auth, {
      to, text: b.text, prepared, links, encoding: b.encoding, deliveryReport: b.deliveryReport, maxParts: config.maxParts, ...via,
      ...(b.validTo !== undefined ? { validTo: b.validTo } : {}),
      ...(b.costCenter !== undefined ? { costCenter: b.costCenter } : {}),
      ...(meta.idempotencyKey !== undefined ? { idempotencyKey: meta.idempotencyKey } : {}),
    }, now);
    // Numery przeszły już sprawdzenie w `submitMessages`, więc normalizacja tutaj zawsze się udaje.
    const messages = results.map((r, i) => ({ ...r, to: normalizePhone(to[i]!, resolved.account.defaultCountryCode) }));
    const reason = call.action === 'sms' || repeated ? label : `${label}, ${recipientsWord(results.length)}`;
    accepted(reason, results[0] ? { messageId: results[0].id } : {});
    return { kind: 'sent', messages };
  } catch (e) {
    if (e instanceof ApiError) {
      note('error', { reason: `${label}: ${e.message}` });
      return { kind: 'error', error: e };
    }
    throw e;
  }
}
