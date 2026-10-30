import { GROUP_LIMITS, parseConfig, type GroupMode, type SmsGroupConfig } from '../integrations/config.ts';
import { memberLines, parseMemberLines } from '../integrations/group/members.ts';
import type { ReceivedEvent } from '../integrations/pipeline.ts';
import type { TemplateEngine } from '../integrations/templates.ts';
import { normalizeRecipient } from '../text/phone.ts';
import { commonFromValues } from './integration-form.ts';
import type { RuleValues } from './views/integrations.ts';

type Body = Record<string, string | string[] | undefined>;

/** Pola formularza grupy w postaci tekstowej - tak przychodzą z przeglądarki i tak wracają po błędzie. */
export interface GroupFormValues {
  name: string; apiKeyId: string; serviceId: string; orig: string; enabled: boolean; preset: string; storePayloads: boolean;
  throttleLimit: string; throttleWindow: string; eventLogLimit: string;
  conditionMode: 'builder' | 'liquid'; rules: RuleValues[]; conditionExpr: string;
  /** Listy jak w `memberLines`: jeden numer w wierszu, po numerze opcjonalna nazwa. */
  mode: GroupMode; senders: string; recipients: string; members: string;
  prefix: string;
  textMode: 'body' | 'sender_body' | 'liquid'; textTemplate: string;
  confirmEnabled: boolean;
  maxParts: string; overflow: 'truncate' | 'reject';
  /** Próbka do „Sprawdź”: numer nadawcy i treść SMS-a. */
  sampleFrom: string; sampleText: string;
}

export type GroupFormBase = Pick<GroupFormValues, 'name' | 'apiKeyId' | 'serviceId' | 'orig' | 'enabled' | 'preset' | 'storePayloads'>;

const list = (field: string | string[] | undefined): string[] => (field === undefined ? [] : (Array.isArray(field) ? field : [field]).map(String));
const first = (field: string | string[] | undefined): string => (Array.isArray(field) ? field[0] ?? '' : field ?? '');
const on = (field: string | string[] | undefined): boolean => ['1', 'on', 'true'].includes(first(field).trim());

export function groupFormValues(body: Body): GroupFormValues {
  const s = (k: string) => first(body[k]).trim();
  const paths = list(body.rulePath);
  const ops = list(body.ruleOp);
  const ruleValues = list(body.ruleValue);
  const textMode = s('textMode');
  return {
    name: s('name'), apiKeyId: s('apiKeyId'), serviceId: s('serviceId'), orig: s('orig'), enabled: on(body.enabled), preset: s('preset'),
    storePayloads: on(body.storePayloads), throttleLimit: s('throttleLimit'), throttleWindow: s('throttleWindow'), eventLogLimit: s('eventLogLimit'),
    conditionMode: s('conditionMode') === 'liquid' ? 'liquid' : 'builder',
    rules: paths.map((path, i) => ({ path: path.trim(), op: ops[i] ?? 'eq', value: ruleValues[i] ?? '' })).filter((r) => r.path !== ''),
    conditionExpr: first(body.conditionExpr),
    mode: s('mode') === 'closed' ? 'closed' : 'lists',
    senders: first(body.senders), recipients: first(body.recipients), members: first(body.members),
    prefix: s('prefix'),
    textMode: textMode === 'liquid' ? 'liquid' : textMode === 'sender_body' ? 'sender_body' : 'body',
    textTemplate: first(body.textTemplate),
    confirmEnabled: on(body.confirmEnabled),
    maxParts: s('maxParts'), overflow: s('overflow') === 'reject' ? 'reject' : 'truncate',
    sampleFrom: s('sampleFrom'), sampleText: first(body.sampleText),
  };
}

export function groupConfigToValues(config: SmsGroupConfig, base: GroupFormBase): GroupFormValues {
  return {
    ...base,
    throttleLimit: String(config.throttle.limit), throttleWindow: String(config.throttle.windowMinutes), eventLogLimit: String(config.eventLogLimit),
    conditionMode: config.condition.mode,
    rules: config.condition.mode === 'builder' ? config.condition.rules.map((r) => ({ path: r.path, op: r.op, value: r.value })) : [],
    conditionExpr: config.condition.mode === 'liquid' ? config.condition.expr : '',
    mode: config.mode, senders: memberLines(config.senders), recipients: config.recipients.join('\n'), members: memberLines(config.members),
    prefix: config.prefix,
    textMode: config.text.mode, textTemplate: config.text.mode === 'liquid' ? config.text.template : '',
    confirmEnabled: config.confirm.enabled,
    maxParts: String(config.maxParts), overflow: config.overflow,
    sampleFrom: '', sampleText: '',
  };
}

export type GroupFormToConfig = { ok: true; config: SmsGroupConfig } | { ok: false; error: string };

function int(raw: string, min: number, max: number, what: string): number | string {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max || String(n) !== raw.trim()) return `${what}: podaj liczbę od ${min} do ${max}.`;
  return n;
}

/**
 * Wartości formularza na konfigurację grupy; błąd jako zdanie po polsku. Listy idą przez `parseMemberLines`
 * z kodem kraju konta: także odbiorcy, żeby wiersz z nazwą przeszedł, choć zapisują się same numery.
 * Listy drugiego trybu zapisują się puste.
 */
export function groupFormToConfig(v: GroupFormValues, countryCode: string, engine: TemplateEngine): GroupFormToConfig {
  const fail = (error: string): GroupFormToConfig => ({ ok: false, error });
  const common = commonFromValues(v, engine);
  if (typeof common === 'string') return fail(common);

  let senders: SmsGroupConfig['senders'] = [];
  let recipients: string[] = [];
  let members: SmsGroupConfig['members'] = [];
  if (v.mode === 'lists') {
    const parsedSenders = parseMemberLines(v.senders, countryCode);
    if (!parsedSenders.ok) return fail(parsedSenders.error);
    if (parsedSenders.members.length === 0) return fail('Podaj co najmniej jeden numer uprawniony do pisania.');
    if (parsedSenders.members.length > GROUP_LIMITS.senders) return fail(`Numery uprawnione do pisania: najwyżej ${GROUP_LIMITS.senders}.`);
    const parsedRecipients = parseMemberLines(v.recipients, countryCode);
    if (!parsedRecipients.ok) return fail(parsedRecipients.error);
    if (parsedRecipients.members.length === 0) return fail('Podaj co najmniej jeden numer odbiorcy.');
    if (parsedRecipients.members.length > GROUP_LIMITS.recipients) return fail(`Numery odbiorców: najwyżej ${GROUP_LIMITS.recipients}.`);
    senders = parsedSenders.members;
    recipients = parsedRecipients.members.map((m) => m.phone);
  } else {
    const parsedMembers = parseMemberLines(v.members, countryCode);
    if (!parsedMembers.ok) return fail(parsedMembers.error);
    if (parsedMembers.members.length < 2) return fail('Grupa zamknięta wymaga co najmniej dwóch członków.');
    if (parsedMembers.members.length > GROUP_LIMITS.members) return fail(`Numery członków: najwyżej ${GROUP_LIMITS.members}.`);
    members = parsedMembers.members;
  }

  if (/\s/.test(v.prefix) || v.prefix.length > GROUP_LIMITS.prefix) return fail(`Prefiks: jedno słowo bez spacji, do ${GROUP_LIMITS.prefix} znaków.`);

  let text: SmsGroupConfig['text'];
  if (v.textMode === 'liquid') {
    if (v.textTemplate.trim() === '') return fail('Szablon treści jest pusty.');
    if (v.textTemplate.length > 4000) return fail('Szablon treści: do 4000 znaków.');
    const problem = engine.validate(v.textTemplate);
    if (problem !== null) return fail(`Szablon treści: ${problem}`);
    text = { mode: 'liquid', template: v.textTemplate };
  } else {
    text = { mode: v.textMode };
  }
  const maxParts = int(v.maxParts, 1, 9, 'Limit części');
  if (typeof maxParts === 'string') return fail(maxParts);

  let config: SmsGroupConfig = {
    ...common, mode: v.mode, senders, recipients, members, prefix: v.prefix, text, confirm: { enabled: v.confirmEnabled }, maxParts, overflow: v.overflow,
  };
  // Schemat zod jako siatka bezpieczeństwa: to, co przeszło wyżej, ma przejść i tu.
  try {
    config = parseConfig('sms_group', config);
  } catch (e) {
    return fail(`Konfiguracja nie przeszła sprawdzenia: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  return { ok: true, config };
}

/** Czy konfiguracja używa pól widocznych tylko w trybie zaawansowanym: warunek albo Liquid w treści. Limit części jest w obu trybach. */
export function groupNeedsAdvanced(config: SmsGroupConfig): boolean {
  const hasCondition = config.condition.mode === 'liquid' || config.condition.rules.length > 0;
  return hasCondition || config.text.mode === 'liquid';
}

/**
 * Próbka do „Sprawdź”: numer z pola albo pierwszy nadawca lub członek; treść z pola albo
 * `<prefiks> Jutro zbiórka o 8:00`. Numer z pola przechodzi przez normalizację, żeby `+48 601…` pasowało do listy;
 * zapis niedający się znormalizować zostaje surowy, jak nadawca alfanumeryczny u odbiornika.
 */
export function groupSampleEvent(v: GroupFormValues, config: SmsGroupConfig, now: Date, countryCode = '48'): ReceivedEvent {
  const firstPhone = (config.mode === 'closed' ? config.members : config.senders)[0]?.phone ?? '';
  let from = firstPhone;
  if (v.sampleFrom !== '') {
    try {
      from = normalizeRecipient(v.sampleFrom, countryCode);
    } catch {
      from = v.sampleFrom;
    }
  }
  const text = v.sampleText.trim() !== '' ? v.sampleText : [config.prefix, 'Jutro zbiórka o 8:00'].filter((p) => p !== '').join(' ');
  return { id: 'podglad', serviceId: v.serviceId, from, to: '', kind: 'text', text, receivedAt: now.toISOString(), relatedMessageId: null };
}
