import { GROUP_LIMITS, parseConfig, type PowerAutomateConfig } from '../integrations/config.ts';
import { memberLines, parseMemberLines } from '../integrations/group/members.ts';

type Body = Record<string, string | string[] | undefined>;

/** Pola formularza integracji Power Automate w postaci tekstowej - tak przychodzą z przeglądarki i tak wracają po błędzie. */
export interface PaFormValues {
  name: string; apiKeyId: string; serviceId: string; orig: string; enabled: boolean; preset: string;
  /** Lista jak w `memberLines`: jeden numer w wierszu, po numerze opcjonalna nazwa. */
  recipients: string;
  maxParts: string; overflow: 'truncate' | 'reject';
  throttleLimit: string; throttleWindow: string; eventLogLimit: string; storePayloads: boolean;
}

export type PaFormBase = Pick<PaFormValues, 'name' | 'apiKeyId' | 'serviceId' | 'orig' | 'enabled' | 'preset' | 'storePayloads'>;

const first = (field: string | string[] | undefined): string => (Array.isArray(field) ? field[0] ?? '' : field ?? '');
const on = (field: string | string[] | undefined): boolean => ['1', 'on', 'true'].includes(first(field).trim());

export function paFormValues(body: Body): PaFormValues {
  const s = (k: string) => first(body[k]).trim();
  return {
    name: s('name'), apiKeyId: s('apiKeyId'), serviceId: s('serviceId'), orig: s('orig'), enabled: on(body.enabled), preset: s('preset'),
    recipients: first(body.recipients),
    maxParts: s('maxParts'), overflow: s('overflow') === 'truncate' ? 'truncate' : 'reject',
    throttleLimit: s('throttleLimit'), throttleWindow: s('throttleWindow'), eventLogLimit: s('eventLogLimit'), storePayloads: on(body.storePayloads),
  };
}

export function paConfigToValues(config: PowerAutomateConfig, base: PaFormBase): PaFormValues {
  return {
    ...base,
    recipients: memberLines(config.recipients),
    maxParts: String(config.maxParts), overflow: config.overflow,
    throttleLimit: String(config.throttle.limit), throttleWindow: String(config.throttle.windowMinutes), eventLogLimit: String(config.eventLogLimit),
  };
}

function int(raw: string, min: number, max: number, what: string): number | string {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max || String(n) !== raw.trim()) return `${what}: podaj liczbę od ${min} do ${max}.`;
  return n;
}

/**
 * Wartości formularza na konfigurację; błąd jako zdanie po polsku. Lista odbiorców może być pusta:
 * służy wyłącznie akcji „Wyślij SMS do grupy”, która przy pustej liście kończy się błędem.
 */
export function paFormToConfig(v: PaFormValues, countryCode: string): { ok: true; config: PowerAutomateConfig } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (v.name === '') return fail('Podaj nazwę integracji.');
  const parsed = parseMemberLines(v.recipients, countryCode);
  if (!parsed.ok) return fail(parsed.error);
  if (parsed.members.length > GROUP_LIMITS.recipients) return fail(`Numery odbiorców: najwyżej ${GROUP_LIMITS.recipients}.`);
  const maxParts = int(v.maxParts, 1, 9, 'Limit części');
  if (typeof maxParts === 'string') return fail(maxParts);
  const throttleLimit = int(v.throttleLimit, 1, 1000, 'Limit burzy');
  if (typeof throttleLimit === 'string') return fail(throttleLimit);
  const throttleWindow = int(v.throttleWindow, 1, 1440, 'Okno limitu burzy');
  if (typeof throttleWindow === 'string') return fail(throttleWindow);
  const eventLogLimit = int(v.eventLogLimit, 20, 2000, 'Wpisów w dzienniku');
  if (typeof eventLogLimit === 'string') return fail(eventLogLimit);
  // Schemat zod jako siatka bezpieczeństwa: to, co przeszło wyżej, ma przejść i tu.
  try {
    const config = parseConfig('power_automate', {
      throttle: { limit: throttleLimit, windowMinutes: throttleWindow }, eventLogLimit,
      recipients: parsed.members, maxParts, overflow: v.overflow,
    });
    return { ok: true, config };
  } catch (e) {
    return fail(`Konfiguracja nie przeszła sprawdzenia: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}
