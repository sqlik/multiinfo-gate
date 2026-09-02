import type { IntegrationKind } from '../integrations/config.ts';
import type { Preset, SimpleSecret } from '../integrations/presets/types.ts';
import type { IntegrationFormValues } from './views/integrations.ts';

type Body = Record<string, string | string[] | undefined>;

/**
 * Tryb prosty: użytkownik wybiera z list gotowego ustawienia, a formularz zaawansowany dostaje
 * z tego komplet wartości. Dzięki temu obie drogi zapisują tę samą konfigurację tą samą walidacją.
 */
export interface SimpleValues {
  name: string; apiKeyId: string; enabled: boolean;
  /** Przychodząca: numery (jeden na linię), wybory z list i hasło aplikacji. */
  numbers: string; whenId: string; textId: string; secret: string;
  /** Wychodząca: adres aplikacji, sekrety po odniesieniu i parametry po kluczu. */
  url: string; secrets: Record<string, string>; params: Record<string, string>;
}

export function simpleValuesFromBody(body: Body, preset: Preset): SimpleValues {
  const s = (k: string) => String(body[k] ?? '').trim();
  const out = preset.simple?.outbound;
  return {
    name: s('name'), apiKeyId: s('apiKeyId'), enabled: s('enabled') === '1',
    numbers: String(body.numbers ?? ''), whenId: s('whenId'), textId: s('textId'), secret: String(body.secret ?? '').trim(),
    url: s('url'),
    secrets: Object.fromEntries((out?.secrets ?? []).map((sec) => [sec.ref, String(body[`secret_${sec.ref}`] ?? '').trim()])),
    params: Object.fromEntries((out?.params ?? []).map((p) => [p.key, s(`param_${p.key}`)])),
  };
}

/** Wartości początkowe trybu prostego: pierwszy wariant każdej listy, numery i sekrety puste. */
export function simpleDefaults(preset: Preset, base: IntegrationFormValues, fresh = false): SimpleValues {
  const inbound = preset.simple?.inbound;
  // Nowa integracja zaczyna od pierwszych wariantów; edycja od tych, które siedzą w zapisanej konfiguracji.
  const detected = fresh ? null : detectSimple(preset, 'webhook_in', base);
  return {
    name: base.name, apiKeyId: base.apiKeyId, enabled: base.enabled,
    numbers: base.toFallback, whenId: detected?.whenId ?? inbound?.when[0]?.id ?? '', textId: detected?.textId ?? inbound?.text[0]?.id ?? '', secret: '',
    url: base.url, secrets: {}, params: paramsFromTemplate(preset, base.bodyTemplate),
  };
}

const paramPattern = (key: string) => new RegExp(`"${key}":\\s*("[^"]*"|\\d+)`);

function paramsFromTemplate(preset: Preset, template: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of preset.simple?.outbound?.params ?? []) {
    const m = paramPattern(p.key).exec(template);
    out[p.key] = m ? m[1]!.replace(/^"|"$/g, '') : '';
  }
  return out;
}

export function transformSecret(kind: SimpleSecret['transform'], raw: string): string {
  if (kind === 'bearer') return `Bearer ${raw}`;
  if (kind === 'basic-x') return `Basic ${Buffer.from(`${raw}:X`, 'utf8').toString('base64')}`;
  return raw;
}

export type SimpleToValues = { ok: true; values: IntegrationFormValues } | { ok: false; error: string };

/**
 * Wybory z list na pełne wartości formularza. `base` to wartości ustawienia (nowa) albo zapisanej
 * integracji (edycja) - wszystko, czego tryb prosty nie pokazuje, zostaje z bazy bez zmian.
 */
export function simpleToValues(kind: IntegrationKind, preset: Preset, sv: SimpleValues, base: IntegrationFormValues): SimpleToValues {
  const fail = (error: string): SimpleToValues => ({ ok: false, error });
  const v: IntegrationFormValues = { ...base, name: sv.name, apiKeyId: sv.apiKeyId || base.apiKeyId, enabled: sv.enabled };
  if (kind === 'webhook_in') {
    const simple = preset.simple?.inbound;
    if (!simple) return fail('To ustawienie nie ma trybu prostego.');
    const when = simple.when.find((w) => w.id === sv.whenId);
    if (!when) return fail('Wybierz, kiedy wysyłać SMS.');
    const text = simple.text.find((t) => t.id === sv.textId);
    if (!text) return fail('Wybierz, co ma być w SMS-ie.');
    v.conditionMode = when.condition.mode;
    v.rules = when.condition.mode === 'builder' ? when.condition.rules.map((r) => ({ path: r.path, op: r.op, value: r.value })) : [];
    v.conditionExpr = when.condition.mode === 'liquid' ? when.condition.expr : '';
    v.textMode = text.text.mode;
    v.textTemplate = text.text.mode === 'liquid' ? text.text.template : '';
    v.textPath = text.text.mode === 'path' ? text.text.path : '';
    v.toFallback = sv.numbers;
    if (simple.recipients.source === 'list' && sv.numbers.trim() === '') return fail('Podaj przynajmniej jeden numer telefonu, na który ma iść SMS.');
    const auth = simple.auth;
    if (auth.kind === 'header') {
      v.authHeaderName = auth.name;
      v.authHeaderValue = sv.secret === '' ? '' : `${auth.prefix}${sv.secret}`;
      v.authBasicUser = '';
      v.authBasicPass = '';
    } else if (auth.kind === 'basic') {
      v.authBasicUser = auth.user;
      v.authBasicPass = sv.secret;
      v.authHeaderName = '';
      v.authHeaderValue = '';
    } else {
      v.authHeaderName = '';
      v.authHeaderValue = '';
      v.authBasicUser = '';
      v.authBasicPass = '';
    }
    return { ok: true, values: v };
  }
  const simple = preset.simple?.outbound;
  if (!simple) return fail('To ustawienie nie ma trybu prostego.');
  v.url = sv.url;
  v.headers = base.headers.map((h) => ({ ...h }));
  for (const sec of simple.secrets) {
    const raw = sv.secrets[sec.ref] ?? '';
    // Nagłówek, który w ustawieniu nosi ten sekret; pusta wartość zostawia zapisany (przeniesienie po nazwie).
    const target = v.headers.find((h) => h.name === (preset.outbound?.headers ?? []).find((ph) => ph.valueRef === sec.ref)?.name);
    if (!target) return fail(`Ustawienie nie ma nagłówka na sekret ${sec.ref}.`);
    target.secret = true;
    target.value = raw === '' ? '' : transformSecret(sec.transform, raw);
  }
  let template = v.bodyTemplate;
  for (const p of simple.params) {
    const raw = sv.params[p.key] ?? '';
    if (raw === '') return fail(`Podaj: ${p.label.toLowerCase()}.`);
    if (p.digits && !/^\d{1,12}$/.test(raw)) return fail(`${p.label}: podaj liczbę.`);
    if (!paramPattern(p.key).test(template)) return fail(`Szablon nie ma pola ${p.key} - zmień je w trybie zaawansowanym.`);
    template = template.replace(paramPattern(p.key), `"${p.key}": ${p.digits ? raw : JSON.stringify(raw)}`);
  }
  v.bodyTemplate = template;
  return { ok: true, values: v };
}

export interface SimpleDetected { whenId?: string; textId?: string; params?: Record<string, string> }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Czy zapisana konfiguracja mieści się w listach trybu prostego. Nie - gdy ktoś w trybie zaawansowanym
 * zmienił szablon, warunek albo zabezpieczenie na własne; wtedy formularz otwiera się zaawansowany.
 */
export function detectSimple(preset: Preset, kind: IntegrationKind, v: IntegrationFormValues): SimpleDetected | null {
  if (kind === 'webhook_in') {
    const simple = preset.simple?.inbound;
    const p = preset.inbound;
    if (!simple || !p) return null;
    const condition = v.conditionMode === 'liquid' ? { mode: 'liquid', expr: v.conditionExpr } : { mode: 'builder', rules: v.rules };
    const when = simple.when.find((w) => same(w.condition, condition));
    const text = simple.text.find((t) => same(t.text, v.textMode === 'path' ? { mode: 'path', path: v.textPath } : { mode: 'liquid', template: v.textTemplate }));
    if (!when || !text) return null;
    const auth = simple.auth;
    const authOk = auth.kind === 'header' ? v.authHeaderName === auth.name && v.authBasicUser === ''
      : auth.kind === 'basic' ? v.authBasicUser === auth.user && v.authHeaderName === ''
      : v.authHeaderName === '' && v.authBasicUser === '';
    if (!authOk) return null;
    if (v.toPath !== (p.to?.path ?? '') || v.ticketRefPath !== (p.ticketRefPath ?? '') || v.eventIdPath !== (p.eventIdPath ?? '')) return null;
    if (v.textMode === 'liquid' && (v.maxParts !== String(p.maxParts ?? 1) || v.overflow !== (p.overflow ?? 'truncate'))) return null;
    return { whenId: when.id, textId: text.id };
  }
  const simple = preset.simple?.outbound;
  const p = preset.outbound;
  if (!simple || !p) return null;
  if (v.method !== (p.method ?? 'POST') || v.conditionMode !== 'builder' || v.rules.length > 0) return null;
  if (!same(v.events, p.events ?? ['message.received'])) return null;
  const presetHeaders = (p.headers ?? []).map((h) => ({ name: h.name, secret: h.valueRef !== undefined, value: h.value ?? '' }));
  const current = v.headers.map((h) => ({ name: h.name, secret: h.secret, value: h.secret ? '' : h.value }));
  if (!same(current, presetHeaders)) return null;
  const body = p.body;
  if (!body || v.bodyMode !== body.mode) return null;
  if (body.mode === 'form') return null;
  let expected = body.template;
  const params: Record<string, string> = {};
  for (const param of simple.params) {
    const m = paramPattern(param.key).exec(v.bodyTemplate);
    if (!m) return null;
    params[param.key] = m[1]!.replace(/^"|"$/g, '');
    expected = expected.replace(paramPattern(param.key), m[0]);
  }
  if (v.bodyTemplate !== expected) return null;
  if ((v.responseRefPath || '') !== (p.responseRefPath ?? '')) return null;
  return { params };
}

/** Etykiety wybranych wariantów do ekranu szczegółu - w słowach, nie w ścieżkach. */
export function simpleLabels(preset: Preset, kind: IntegrationKind, v: IntegrationFormValues): { when: string; text: string } | null {
  const d = detectSimple(preset, kind, v);
  const simple = preset.simple?.inbound;
  if (!d || !simple || kind !== 'webhook_in') return null;
  return {
    when: simple.when.find((w) => w.id === d.whenId)?.label ?? '',
    text: simple.text.find((t) => t.id === d.textId)?.label ?? '',
  };
}

export const hasSimple = (preset: Preset, kind: IntegrationKind): boolean =>
  kind === 'webhook_in' ? preset.simple?.inbound !== undefined : preset.simple?.outbound !== undefined;

