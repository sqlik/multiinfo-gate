import { normalizeScopes, needsWarning } from '../agents/scopes.ts';
import { AGENT_SCOPES, PA_RECIPIENT_LIMIT_MAX, parseConfig, type AgentConfig, type AgentScope } from '../integrations/config.ts';
import { integrationNameError } from './integration-form.ts';
import { int } from './power-automate-form.ts';
import { validationMessage } from '../zod.ts';

type Body = Record<string, string | string[] | undefined>;

/** Pola formularza integracji Agent AI w postaci tekstowej - tak przychodzą z przeglądarki i tak wracają po błędzie. */
export interface AgentFormValues {
  name: string; apiKeyId: string; serviceId: string; orig: string; enabled: boolean; preset: string;
  /** Zaznaczone zakresy w stałej kolejności, bez nieznanych wartości. */
  scopes: AgentScope[];
  maxParts: string; overflow: 'truncate' | 'reject';
  throttleLimit: string; throttleWindow: string; throttleRecipients: string; eventLogLimit: string; storePayloads: boolean;
}

export type AgentFormBase = Pick<AgentFormValues, 'name' | 'apiKeyId' | 'serviceId' | 'orig' | 'enabled' | 'preset' | 'storePayloads'>;

const first = (field: string | string[] | undefined): string => (Array.isArray(field) ? field[0] ?? '' : field ?? '');
const on = (field: string | string[] | undefined): boolean => ['1', 'on', 'true'].includes(first(field).trim());

export function agentFormValues(body: Body): AgentFormValues {
  const s = (k: string) => first(body[k]).trim();
  const raw = body.scopes;
  const picked = new Set((Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((x) => x.trim()));
  return {
    name: s('name'), apiKeyId: s('apiKeyId'), serviceId: s('serviceId'), orig: s('orig'), enabled: on(body.enabled), preset: s('preset'),
    scopes: AGENT_SCOPES.filter((scope) => picked.has(scope)),
    maxParts: s('maxParts'), overflow: s('overflow') === 'truncate' ? 'truncate' : 'reject',
    throttleLimit: s('throttleLimit'), throttleWindow: s('throttleWindow'), throttleRecipients: s('throttleRecipients'),
    eventLogLimit: s('eventLogLimit'), storePayloads: on(body.storePayloads),
  };
}

export function agentConfigToValues(config: AgentConfig, base: AgentFormBase): AgentFormValues {
  return {
    ...base,
    scopes: AGENT_SCOPES.filter((scope) => config.scopes.includes(scope)),
    maxParts: String(config.maxParts), overflow: config.overflow,
    throttleLimit: String(config.throttle.limit), throttleWindow: String(config.throttle.windowMinutes),
    throttleRecipients: String(config.throttle.recipients), eventLogLimit: String(config.eventLogLimit),
  };
}

/**
 * Wartości formularza na konfigurację; błąd jako zdanie po polsku. Odpowiedź nadawcy bez odczytu odebranych
 * dostaje ten odczyt (`addedReadInbound`), a wysyłka razem z odczytem odebranych wymaga ostrzeżenia (`warning`).
 */
export function agentFormToConfig(v: AgentFormValues):
  { ok: true; config: AgentConfig; addedReadInbound: boolean; warning: boolean } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  const nameError = integrationNameError(v.name);
  if (nameError !== null) return fail(nameError);
  if (v.scopes.length === 0) return fail('Zakresy: zaznacz co najmniej jeden zakres.');
  const { scopes, addedReadInbound } = normalizeScopes(v.scopes);
  const maxParts = int(v.maxParts, 1, 9, 'Limit części');
  if (typeof maxParts === 'string') return fail(maxParts);
  const throttleLimit = int(v.throttleLimit, 1, 1000, 'Limit burzy');
  if (typeof throttleLimit === 'string') return fail(throttleLimit);
  const throttleWindow = int(v.throttleWindow, 1, 1440, 'Okno limitu burzy');
  if (typeof throttleWindow === 'string') return fail(throttleWindow);
  const throttleRecipients = int(v.throttleRecipients, 1, PA_RECIPIENT_LIMIT_MAX, 'Limit odbiorców');
  if (typeof throttleRecipients === 'string') return fail(throttleRecipients);
  const eventLogLimit = int(v.eventLogLimit, 20, 2000, 'Wpisów w dzienniku');
  if (typeof eventLogLimit === 'string') return fail(eventLogLimit);
  // Schemat zod jako siatka bezpieczeństwa: to, co przeszło wyżej, ma przejść i tu.
  try {
    const config = parseConfig('agent', {
      scopes, throttle: { limit: throttleLimit, windowMinutes: throttleWindow, recipients: throttleRecipients }, eventLogLimit, maxParts, overflow: v.overflow,
    });
    return { ok: true, config, addedReadInbound, warning: needsWarning(config.scopes) };
  } catch (e) {
    return fail(`Konfiguracja nie przeszła sprawdzenia: ${validationMessage(e)}`);
  }
}
