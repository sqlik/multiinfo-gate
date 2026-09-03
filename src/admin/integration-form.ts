import { RULE_OPS, type Rule, type RuleOp } from '../integrations/conditions.ts';
import {
  OUTBOUND_EVENTS, parseConfig, type InboundConfig, type IntegrationConfig, type IntegrationKind, type OutboundConfig, type OutboundEvent,
} from '../integrations/config.ts';
import { isValidPath } from '../integrations/paths.ts';
import { parseSourceEntry } from '../integrations/sources.ts';
import type { TemplateEngine } from '../integrations/templates.ts';
import { INBOUND_BASIC_REF, INBOUND_TOKEN_REF, type IntegrationFormValues } from './views/integrations.ts';

type Body = Record<string, string | string[] | undefined>;

/** Pole powtórzone przychodzi raz jako tekst, raz jako tablica; puste wartości zostają, bo trzymają wyrównanie wierszy. */
function list(field: string | string[] | undefined): string[] {
  if (field === undefined) return [];
  return (Array.isArray(field) ? field : [field]).map((x) => String(x));
}

const lines = (raw: string): string[] => raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');

export function formValues(body: Body): IntegrationFormValues {
  const s = (k: string) => String(body[k] ?? '').trim();
  const paths = list(body.rulePath);
  const ops = list(body.ruleOp);
  const ruleValues = list(body.ruleValue);
  const headerNames = list(body.headerName);
  const headerValues = list(body.headerValue);
  const headerSecrets = list(body.headerSecret);
  const fieldNames = list(body.formFieldName);
  const fieldTemplates = list(body.formFieldTemplate);
  return {
    name: s('name'), apiKeyId: s('apiKeyId'), serviceId: s('serviceId'), orig: s('orig'), enabled: s('enabled') === '1', preset: s('preset'),
    storePayloads: s('storePayloads') === '1', throttleLimit: s('throttleLimit'), throttleWindow: s('throttleWindow'), eventLogLimit: s('eventLogLimit'),
    conditionMode: s('conditionMode') === 'liquid' ? 'liquid' : 'builder',
    rules: paths.map((path, i) => ({ path: path.trim(), op: ops[i] ?? 'eq', value: ruleValues[i] ?? '' })).filter((r) => r.path !== ''),
    conditionExpr: String(body.conditionExpr ?? ''),
    authHeaderName: s('authHeaderName'), authHeaderValue: String(body.authHeaderValue ?? '').trim(),
    authBasicUser: s('authBasicUser'), authBasicPass: String(body.authBasicPass ?? ''),
    sources: String(body.sources ?? ''),
    toPath: s('toPath'), toFallback: String(body.toFallback ?? ''), ticketRefPath: s('ticketRefPath'), eventIdPath: s('eventIdPath'),
    textMode: s('textMode') === 'path' ? 'path' : 'liquid', textPath: s('textPath'), textTemplate: String(body.textTemplate ?? ''),
    maxParts: s('maxParts'), overflow: s('overflow') === 'reject' ? 'reject' : 'truncate',
    events: list(body.events).filter((e) => e !== ''), url: s('url'), method: s('method') || 'POST',
    headers: headerNames.map((name, i) => ({ name: name.trim(), value: headerValues[i] ?? '', secret: headerSecrets[i] === '1' })).filter((h) => h.name !== ''),
    bodyMode: s('bodyMode') === 'form' ? 'form' : s('bodyMode') === 'text' ? 'text' : 'json',
    bodyTemplate: String(body.bodyTemplate ?? ''),
    formFields: fieldNames.map((name, i) => ({ name: name.trim(), template: fieldTemplates[i] ?? '' })).filter((f) => f.name !== ''),
    responseRefPath: s('responseRefPath'), sign: s('sign') === '1',
    sample: String(body.sample ?? ''),
  };
}

export interface ExistingSecrets {
  /** Nazwy sekretów już zapisanych. */
  names: string[];
  /** Dotychczasowe nagłówki wychodzącej: nazwa → odniesienie do sekretu; pozwala przenieść sekret bez wpisywania go ponownie. */
  headerRefs: Record<string, string>;
}

export type FormToConfig =
  | { ok: true; config: IntegrationConfig; secrets: Record<string, string>; carried: Record<string, string> }
  | { ok: false; error: string };

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

function int(raw: string, min: number, max: number, what: string): number | string {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return `${what}: podaj liczbę od ${min} do ${max}.`;
  return n;
}

/** Walidacja ścieżki po polsku: pusta jest dozwolona tam, gdzie pole jest opcjonalne. */
function pathOr(raw: string, what: string): { path?: string } | string {
  if (raw === '') return {};
  if (!isValidPath(raw)) return `${what}: „${raw}” nie jest poprawną ścieżką (np. alert.labels.phone albo items[0].id).`;
  return { path: raw };
}

function condition(v: IntegrationFormValues, engine: TemplateEngine): InboundConfig['condition'] | string {
  if (v.conditionMode === 'liquid') {
    if (v.conditionExpr.trim() === '') return 'Warunek w trybie Liquid wymaga wyrażenia - albo przełącz na reguły.';
    const problem = engine.validate(v.conditionExpr);
    return problem === null ? { mode: 'liquid', expr: v.conditionExpr } : `Wyrażenie warunku: ${problem}`;
  }
  if (v.rules.length > 20) return 'Warunek: najwyżej 20 reguł.';
  const rules: Rule[] = [];
  for (const r of v.rules) {
    if (!isValidPath(r.path)) return `Reguła: „${r.path}” nie jest poprawną ścieżką.`;
    if (!(RULE_OPS as readonly string[]).includes(r.op)) return `Reguła ${r.path}: nieznany operator.`;
    rules.push({ path: r.path, op: r.op as RuleOp, value: r.value });
  }
  return { mode: 'builder', rules };
}

/**
 * Wartości formularza na konfigurację i sekrety; komunikaty po polsku, bo trasa rysuje formularz
 * z pierwszym błędem. `carried` to sekrety do przeniesienia z dotychczasowych (nowe odniesienie → stare).
 */
export function formToConfig(kind: IntegrationKind, v: IntegrationFormValues, engine: TemplateEngine, existing: ExistingSecrets): FormToConfig {
  const fail = (error: string): FormToConfig => ({ ok: false, error });
  if (v.name === '') return fail('Podaj nazwę integracji.');
  const throttleLimit = int(v.throttleLimit, 1, 1000, 'Limit burzy');
  if (typeof throttleLimit === 'string') return fail(throttleLimit);
  const throttleWindow = int(v.throttleWindow, 1, 1440, 'Okno limitu burzy');
  if (typeof throttleWindow === 'string') return fail(throttleWindow);
  const eventLogLimit = int(v.eventLogLimit, 20, 2000, 'Wpisów w dzienniku');
  if (typeof eventLogLimit === 'string') return fail(eventLogLimit);
  const cond = condition(v, engine);
  if (typeof cond === 'string') return fail(cond);
  const common = { condition: cond, throttle: { limit: throttleLimit, windowMinutes: throttleWindow }, eventLogLimit };

  const secrets: Record<string, string> = {};
  const carried: Record<string, string> = {};
  let config: IntegrationConfig;

  if (kind === 'webhook_in') {
    const auth: InboundConfig['auth'] = { sources: [] };
    if (v.authHeaderName !== '') {
      if (!HEADER_NAME.test(v.authHeaderName)) return fail('Nazwa nagłówka z tokenem: litery, cyfry i myślnik, do 64 znaków.');
      if (v.authHeaderValue !== '') secrets[INBOUND_TOKEN_REF] = v.authHeaderValue;
      else if (existing.names.includes(INBOUND_TOKEN_REF)) carried[INBOUND_TOKEN_REF] = INBOUND_TOKEN_REF;
      else return fail('Podaj wartość nagłówka z tokenem albo wyczyść jego nazwę.');
      auth.header = { name: v.authHeaderName, valueRef: INBOUND_TOKEN_REF };
    }
    if (v.authBasicUser !== '') {
      if (v.authBasicPass !== '') secrets[INBOUND_BASIC_REF] = v.authBasicPass;
      else if (existing.names.includes(INBOUND_BASIC_REF)) carried[INBOUND_BASIC_REF] = INBOUND_BASIC_REF;
      else return fail('Podaj hasło basic auth albo wyczyść login.');
      auth.basic = { user: v.authBasicUser, passRef: INBOUND_BASIC_REF };
    }
    for (const entry of lines(v.sources)) {
      if (parseSourceEntry(entry) === null) return fail(`Dozwolone źródła: „${entry}” nie jest adresem IP, zakresem CIDR ani nazwą.`);
      auth.sources.push(entry);
    }
    if (auth.sources.length > 50) return fail('Dozwolone źródła: najwyżej 50 pozycji.');

    const toPath = pathOr(v.toPath, 'Ścieżka numeru');
    if (typeof toPath === 'string') return fail(toPath);
    const fallback = lines(v.toFallback);
    if (fallback.length > 50) return fail('Lista zapasowa: najwyżej 50 numerów.');
    const ticketRef = pathOr(v.ticketRefPath, 'Ścieżka identyfikatora zgłoszenia');
    if (typeof ticketRef === 'string') return fail(ticketRef);
    const eventId = pathOr(v.eventIdPath, 'Ścieżka identyfikatora zdarzenia');
    if (typeof eventId === 'string') return fail(eventId);

    let text: InboundConfig['text'];
    if (v.textMode === 'path') {
      if (v.textPath === '' || !isValidPath(v.textPath)) return fail('Ścieżka pola z treścią: podaj poprawną ścieżkę albo przełącz na szablon.');
      text = { mode: 'path', path: v.textPath };
    } else {
      if (v.textTemplate.trim() === '') return fail('Szablon treści jest pusty.');
      const problem = engine.validate(v.textTemplate);
      if (problem !== null) return fail(`Szablon treści: ${problem}`);
      text = { mode: 'liquid', template: v.textTemplate };
    }
    const maxParts = int(v.maxParts, 1, 9, 'Limit części');
    if (typeof maxParts === 'string') return fail(maxParts);

    config = {
      ...common, auth, to: { ...toPath, fallback }, ...(ticketRef.path ? { ticketRefPath: ticketRef.path } : {}),
      ...(eventId.path ? { eventIdPath: eventId.path } : {}), text, maxParts, overflow: v.overflow,
    };
  } else {
    const events = v.events.filter((e): e is OutboundEvent => (OUTBOUND_EVENTS as readonly string[]).includes(e));
    if (events.length === 0) return fail('Zaznacz przynajmniej jedno zdarzenie.');
    if (!/^https?:\/\/\S+$/.test(v.url)) return fail('Adres musi zaczynać się od https:// (albo http:// w sieci wewnętrznej).');
    if (!['POST', 'PUT', 'PATCH'].includes(v.method)) return fail('Metoda: POST, PUT albo PATCH.');
    if (v.headers.length > 20) return fail('Nagłówki: najwyżej 20.');
    const headers: OutboundConfig['headers'] = [];
    for (const [i, h] of v.headers.entries()) {
      if (!HEADER_NAME.test(h.name)) return fail(`Nagłówek „${h.name}”: litery, cyfry i myślnik, do 64 znaków.`);
      if (h.secret) {
        // Sekret bez wartości przenosi się z dotychczasowego nagłówka o tej samej nazwie - inaczej trzeba go wpisać.
        const ref = `h${i}`;
        const oldRef = existing.headerRefs[h.name];
        if (h.value !== '') secrets[ref] = h.value;
        else if (oldRef !== undefined && existing.names.includes(oldRef)) carried[ref] = oldRef;
        else return fail(`Nagłówek ${h.name}: podaj wartość sekretu.`);
        headers.push({ name: h.name, valueRef: ref });
      } else {
        const problem = engine.validate(h.value);
        if (problem !== null) return fail(`Nagłówek ${h.name}: ${problem}`);
        headers.push({ name: h.name, value: h.value });
      }
    }

    let body: OutboundConfig['body'];
    if (v.bodyMode === 'form') {
      if (v.formFields.length === 0) return fail('Body formularza wymaga przynajmniej jednego pola.');
      if (v.formFields.length > 30) return fail('Pola formularza: najwyżej 30.');
      for (const f of v.formFields) {
        const problem = engine.validate(f.template);
        if (problem !== null) return fail(`Pole ${f.name}: ${problem}`);
      }
      body = { mode: 'form', fields: v.formFields };
    } else {
      if (v.bodyTemplate.trim() === '') return fail('Szablon body jest pusty.');
      const problem = engine.validate(v.bodyTemplate);
      if (problem !== null) return fail(`Szablon body: ${problem}`);
      body = { mode: v.bodyMode, template: v.bodyTemplate };
    }
    const responseRef = pathOr(v.responseRefPath, 'Ścieżka identyfikatora w odpowiedzi');
    if (typeof responseRef === 'string') return fail(responseRef);

    config = {
      ...common, events, url: v.url, method: v.method as OutboundConfig['method'], headers, body,
      ...(responseRef.path ? { responseRefPath: responseRef.path } : {}), sign: v.sign,
    };
  }

  // Schemat zod jako siatka bezpieczeństwa: to, co przeszło wyżej, ma przejść i tu; inaczej błąd w kodzie, nie w danych.
  try {
    config = parseConfig(kind, config);
  } catch (e) {
    return fail(`Konfiguracja nie przeszła sprawdzenia: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  return { ok: true, config, secrets, carried };
}
