import { MAIL_IN_INTERVALS, MAIL_IN_PASSWORD_REF, MAIL_SECURITIES, parseConfig, type MailField, type MailInConfig, type MailInInterval, type MailSecurity } from '../integrations/config.ts';
import { parseMail, type ParsedMail } from '../integrations/mail/parse.ts';
import type { TemplateEngine } from '../integrations/templates.ts';
import { commonFromValues } from './integration-form.ts';
import type { RuleValues } from './views/integrations.ts';

type Body = Record<string, string | string[] | undefined>;

export interface MailFieldValues { name: string; mode: 'between' | 'regex'; after: string; until: string; pattern: string; flags: string }

/** Pola formularza skrzynki w postaci tekstowej - tak przychodzą z przeglądarki i tak wracają po błędzie. */
export interface MailFormValues {
  name: string; apiKeyId: string; serviceId: string; orig: string; enabled: boolean; preset: string; storePayloads: boolean;
  throttleLimit: string; throttleWindow: string; eventLogLimit: string;
  conditionMode: 'builder' | 'liquid'; rules: RuleValues[]; conditionExpr: string;
  host: string; port: string; security: MailSecurity; verifyCert: boolean; user: string; password: string;
  folder: string; intervalSec: string; backlog: boolean;
  /** Linia na pozycję: wzorzec, po dwukropku numery po przecinku. */
  senders: string;
  requireAuthResults: boolean;
  authservId: string;
  recipientsFromMail: boolean; recipientsWhere: 'subject' | 'body'; toFallback: string;
  /** Linia na frazę. */
  cutFrom: string;
  fields: MailFieldValues[];
  textMode: 'simple' | 'liquid'; textVariant: 'subject_text' | 'subject' | 'text'; textTemplate: string;
  maxParts: string; overflow: 'truncate' | 'reject';
  afterAction: 'keep' | 'move' | 'delete'; afterFolder: string;
  replyEnabled: boolean;
  /** Próbka do „Sprawdź szablon”: surowy mail albo trzy pola. */
  sampleRaw: string; sampleFrom: string; sampleSubject: string; sampleText: string;
}

const EMPTY_FIELD: MailFieldValues = { name: '', mode: 'between', after: '', until: '', pattern: '', flags: '' };
const SENDER_PATTERN = /^(@[^@\s]+\.[^@\s]+|[^@\s]+@[^@\s]+\.[^@\s]+)$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const AUTHSERV_ID = /^[a-z0-9.-]*$/;
const FIELD_KEY = /^fields\[(\d+)\]\[(name|mode|after|until|pattern|flags)\]$/;

const list = (field: string | string[] | undefined): string[] => (field === undefined ? [] : (Array.isArray(field) ? field : [field]).map(String));
const lines = (raw: string): string[] => raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
const first = (field: string | string[] | undefined): string => (Array.isArray(field) ? field[0] ?? '' : field ?? '');
const on = (field: string | string[] | undefined): boolean => ['1', 'on', 'true'].includes(first(field).trim());

export function mailFormValues(body: Body): MailFormValues {
  const s = (k: string) => first(body[k]).trim();
  const paths = list(body.rulePath);
  const ops = list(body.ruleOp);
  const ruleValues = list(body.ruleValue);
  const fields = new Map<number, MailFieldValues>();
  for (const [key, value] of Object.entries(body)) {
    const m = FIELD_KEY.exec(key);
    if (!m) continue;
    const index = Number(m[1]);
    const row = fields.get(index) ?? { ...EMPTY_FIELD };
    const prop = m[2] as keyof MailFieldValues;
    const text = first(value).trim();
    if (prop === 'mode') row.mode = text === 'regex' ? 'regex' : 'between';
    else row[prop] = text;
    fields.set(index, row);
  }
  const security = s('security');
  return {
    name: s('name'), apiKeyId: s('apiKeyId'), serviceId: s('serviceId'), orig: s('orig'), enabled: on(body.enabled), preset: s('preset'),
    storePayloads: on(body.storePayloads), throttleLimit: s('throttleLimit'), throttleWindow: s('throttleWindow'), eventLogLimit: s('eventLogLimit'),
    conditionMode: s('conditionMode') === 'liquid' ? 'liquid' : 'builder',
    rules: paths.map((path, i) => ({ path: path.trim(), op: ops[i] ?? 'eq', value: ruleValues[i] ?? '' })).filter((r) => r.path !== ''),
    conditionExpr: first(body.conditionExpr),
    host: s('host'), port: s('port'), security: (MAIL_SECURITIES as readonly string[]).includes(security) ? security as MailSecurity : 'tls',
    verifyCert: on(body.verifyCert), user: s('user'), password: first(body.password),
    folder: s('folder'), intervalSec: s('intervalSec'), backlog: on(body.backlog),
    senders: first(body.senders), requireAuthResults: on(body.requireAuthResults), authservId: s('authservId'),
    recipientsFromMail: on(body.recipientsFromMail), recipientsWhere: s('recipientsWhere') === 'body' ? 'body' : 'subject', toFallback: first(body.toFallback),
    cutFrom: first(body.cutFrom),
    fields: [...fields.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row),
    textMode: s('textMode') === 'liquid' ? 'liquid' : 'simple',
    textVariant: s('textVariant') === 'subject' ? 'subject' : s('textVariant') === 'text' ? 'text' : 'subject_text',
    textTemplate: first(body.textTemplate),
    maxParts: s('maxParts'), overflow: s('overflow') === 'reject' ? 'reject' : 'truncate',
    afterAction: s('afterAction') === 'move' ? 'move' : s('afterAction') === 'delete' ? 'delete' : 'keep', afterFolder: s('afterFolder'),
    replyEnabled: on(body.replyEnabled),
    sampleRaw: first(body.sampleRaw), sampleFrom: s('sampleFrom'), sampleSubject: s('sampleSubject'), sampleText: first(body.sampleText),
  };
}

export type MailFormBase = Pick<MailFormValues, 'name' | 'apiKeyId' | 'serviceId' | 'orig' | 'enabled' | 'preset' | 'storePayloads'>;

export function mailConfigToValues(config: MailInConfig, base: MailFormBase): MailFormValues {
  return {
    ...base,
    throttleLimit: String(config.throttle.limit), throttleWindow: String(config.throttle.windowMinutes), eventLogLimit: String(config.eventLogLimit),
    conditionMode: config.condition.mode,
    rules: config.condition.mode === 'builder' ? config.condition.rules.map((r) => ({ path: r.path, op: r.op, value: r.value })) : [],
    conditionExpr: config.condition.mode === 'liquid' ? config.condition.expr : '',
    host: config.imap.host, port: String(config.imap.port), security: config.imap.security, verifyCert: config.imap.verifyCert, user: config.imap.user, password: '',
    folder: config.folder, intervalSec: String(config.intervalSec), backlog: false,
    senders: config.senders.map((s) => (s.recipients.length > 0 ? `${s.pattern}: ${s.recipients.join(', ')}` : s.pattern)).join('\n'),
    requireAuthResults: config.requireAuthResults, authservId: config.authservId,
    recipientsFromMail: config.recipientsFromMail.enabled, recipientsWhere: config.recipientsFromMail.where, toFallback: config.to.fallback.join('\n'),
    cutFrom: config.clean.cutFrom.join('\n'),
    fields: config.fields.map((f) => (f.mode === 'between'
      ? { name: f.name, mode: 'between' as const, after: f.after, until: f.until ?? '', pattern: '', flags: '' }
      : { name: f.name, mode: 'regex' as const, after: '', until: '', pattern: f.pattern, flags: f.flags ?? '' })),
    textMode: config.text.mode, textVariant: config.text.mode === 'simple' ? config.text.variant : 'subject_text',
    textTemplate: config.text.mode === 'liquid' ? config.text.template : '',
    maxParts: String(config.maxParts), overflow: config.overflow,
    afterAction: config.after.action, afterFolder: config.after.action === 'move' ? config.after.folder : '',
    replyEnabled: config.reply.enabled,
    sampleRaw: '', sampleFrom: '', sampleSubject: '', sampleText: '',
  };
}

export type MailFormToConfig = { ok: true; config: MailInConfig; password: string | null } | { ok: false; error: string };

function int(raw: string, min: number, max: number, what: string): number | string {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max || String(n) !== raw.trim()) return `${what}: podaj liczbę od ${min} do ${max}.`;
  return n;
}

function fieldFrom(f: MailFieldValues): MailField | string {
  if (f.name === '') return 'Wycinek bez nazwy: podaj nazwę małymi literami, np. kod.';
  if (!FIELD_NAME.test(f.name)) return `Wycinek „${f.name}”: nazwa małymi literami, cyframi i podkreśleniem, od litery, do 40 znaków.`;
  if (f.mode === 'between') {
    if (f.after === '') return `Wycinek ${f.name}: podaj tekst, po którym zaczyna się wartość.`;
    if (f.after.length > 200 || f.until.length > 200) return `Wycinek ${f.name}: frazy do 200 znaków.`;
    return { name: f.name, mode: 'between', after: f.after, ...(f.until !== '' ? { until: f.until } : {}) };
  }
  if (f.pattern === '') return `Wycinek ${f.name}: podaj wyrażenie regularne.`;
  if (f.pattern.length > 200) return `Wycinek ${f.name}: wyrażenie do 200 znaków.`;
  if (!/^[im]{0,2}$/.test(f.flags)) return `Wycinek ${f.name}: flagi to tylko i oraz m.`;
  try {
    new RegExp(f.pattern, f.flags);
  } catch (e) {
    return `Wycinek ${f.name}: wyrażenie nie jest poprawne (${e instanceof Error ? e.message : String(e)}).`;
  }
  return { name: f.name, mode: 'regex', pattern: f.pattern, ...(f.flags !== '' ? { flags: f.flags } : {}) };
}

/** Wartości formularza na konfigurację skrzynki; hasło osobno, bo idzie do sekretów. Błąd jako zdanie po polsku. */
export function mailFormToConfig(v: MailFormValues, hasPassword: boolean, engine: TemplateEngine): MailFormToConfig {
  const fail = (error: string): MailFormToConfig => ({ ok: false, error });
  const common = commonFromValues(v, engine);
  if (typeof common === 'string') return fail(common);

  if (v.host === '') return fail('Podaj serwer IMAP.');
  if (v.host.length > 253) return fail('Serwer IMAP: nazwa do 253 znaków.');
  const port = int(v.port, 1, 65535, 'Port');
  if (typeof port === 'string') return fail(port);
  if (v.user === '') return fail('Podaj login skrzynki.');
  if (v.user.length > 254) return fail('Login skrzynki: do 254 znaków.');
  if (v.password === '' && !hasPassword) return fail('Podaj hasło skrzynki.');
  if (v.folder === '') return fail('Podaj folder skrzynki, np. INBOX.');
  if (v.folder.length > 200) return fail('Folder: nazwa do 200 znaków.');
  const interval = Number.parseInt(v.intervalSec, 10);
  if (!(MAIL_IN_INTERVALS as readonly number[]).includes(interval)) return fail('Częstotliwość: wybierz wartość z listy.');

  const senders: MailInConfig['senders'] = [];
  for (const line of lines(v.senders)) {
    const colon = line.indexOf(':');
    const pattern = (colon < 0 ? line : line.slice(0, colon)).trim().toLowerCase();
    const numbers = colon < 0 ? [] : line.slice(colon + 1).split(',').map((n) => n.trim()).filter((n) => n !== '');
    if (!SENDER_PATTERN.test(pattern) || pattern.length > 254) return fail(`Nadawca „${pattern}”: podaj pełny adres albo domenę z małpą, np. @przyklad.pl.`);
    if (numbers.length > 50) return fail(`Nadawca ${pattern}: najwyżej 50 numerów.`);
    senders.push({ pattern, recipients: numbers });
  }
  if (senders.length > 100) return fail('Lista nadawców: najwyżej 100 pozycji.');
  const authservId = v.authservId.toLowerCase();
  if (!AUTHSERV_ID.test(authservId) || authservId.length > 253) return fail('Nazwa serwera w nagłówku Authentication-Results: dozwolone litery, cyfry, kropki i myślniki, do 253 znaków.');

  const fallback = lines(v.toFallback);
  if (fallback.length > 50) return fail('Odbiorcy: najwyżej 50 numerów.');
  const cutFrom = lines(v.cutFrom);
  if (cutFrom.length > 10) return fail('Pomijaj treść od frazy: najwyżej 10 fraz.');
  if (cutFrom.some((c) => c.length > 200)) return fail('Pomijaj treść od frazy: fraza do 200 znaków.');

  const fields: MailField[] = [];
  for (const f of v.fields) {
    // Puste wiersze zapasowe formularza nie są wycinkami.
    if (f.name === '' && f.after === '' && f.until === '' && f.pattern === '') continue;
    const built = fieldFrom(f);
    if (typeof built === 'string') return fail(built);
    if (fields.some((x) => x.name === built.name)) return fail(`Wycinek ${built.name}: nazwa się powtarza.`);
    fields.push(built);
  }
  if (fields.length > 20) return fail('Wycinki: najwyżej 20.');

  let text: MailInConfig['text'];
  if (v.textMode === 'liquid') {
    if (v.textTemplate.trim() === '') return fail('Szablon treści jest pusty.');
    if (v.textTemplate.length > 4000) return fail('Szablon treści: do 4000 znaków.');
    const problem = engine.validate(v.textTemplate);
    if (problem !== null) return fail(`Szablon treści: ${problem}`);
    text = { mode: 'liquid', template: v.textTemplate };
  } else {
    text = { mode: 'simple', variant: v.textVariant };
  }
  const maxParts = int(v.maxParts, 1, 9, 'Limit części');
  if (typeof maxParts === 'string') return fail(maxParts);

  let after: MailInConfig['after'];
  if (v.afterAction === 'move') {
    if (v.afterFolder === '') return fail('Podaj folder, do którego przenosić przetworzone wiadomości.');
    if (v.afterFolder.length > 200) return fail('Folder docelowy: nazwa do 200 znaków.');
    after = { action: 'move', folder: v.afterFolder };
  } else {
    after = { action: v.afterAction };
  }

  let config: MailInConfig = {
    ...common,
    imap: { host: v.host, port, security: v.security, verifyCert: v.verifyCert, user: v.user, passRef: MAIL_IN_PASSWORD_REF },
    folder: v.folder, intervalSec: interval as MailInInterval, senders, requireAuthResults: v.requireAuthResults, authservId,
    recipientsFromMail: { enabled: v.recipientsFromMail, where: v.recipientsWhere }, to: { fallback }, clean: { cutFrom }, fields, text,
    maxParts, overflow: v.overflow, after, reply: { enabled: v.replyEnabled },
  };
  // Schemat zod jako siatka bezpieczeństwa: to, co przeszło wyżej, ma przejść i tu.
  try {
    config = parseConfig('mail_in', config);
  } catch (e) {
    return fail(`Konfiguracja nie przeszła sprawdzenia: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  return { ok: true, config, password: v.password !== '' ? v.password : null };
}

/** Zdania ostrzeżeń dla konfiguracji, która przechodzi, ale wymaga świadomości administratora. */
export function mailWarnings(config: MailInConfig): string[] {
  const out: string[] = [];
  if (config.imap.security === 'none') out.push('Połączenie bez szyfrowania: hasło i treść maili idą po sieci jawnym tekstem. Tylko w sieci wewnętrznej');
  else if (!config.imap.verifyCert) out.push('Sprawdzanie certyfikatu wyłączone: połączenie podatne na podsłuch. Tylko dla serwera z własnym certyfikatem bez zaufanego urzędu');
  if (config.recipientsFromMail.enabled) out.push('Numery z maila włączone: każdy nadawca z listy może wysłać SMS na dowolny numer na koszt konta');
  return out;
}

/** Czy konfiguracja używa pól widocznych tylko w trybie zaawansowanym: Liquid, wyrażenia regularne, wyłączone sprawdzanie certyfikatu, nazwa serwera Authentication-Results. */
export function needsAdvanced(config: MailInConfig): boolean {
  return config.text.mode === 'liquid' || config.condition.mode === 'liquid' || config.fields.some((f) => f.mode === 'regex') || !config.imap.verifyCert || config.authservId !== '';
}

/** Pole nadawcy próbki: sam adres albo „Nazwa <adres>” (nazwa może być w cudzysłowie); nazwa decyduje o ucięciu podpisu. */
export function sampleSender(field: string): { from: string; fromName: string } {
  const text = field.trim();
  const open = text.lastIndexOf('<');
  if (open < 0 || !text.endsWith('>') || open > text.length - 3) return { from: text.toLowerCase(), fromName: '' };
  let name = text.slice(0, open).trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).trim();
  return { from: text.slice(open + 1, -1).trim().toLowerCase(), fromName: name };
}

/** Próbka z formularza na ParsedMail: surowy mail przez parseMail, inaczej trzy pola; bez niczego null. */
export async function sampleMail(v: MailFormValues, now: Date): Promise<ParsedMail | null> {
  if (v.sampleRaw.trim() !== '') return parseMail(Buffer.from(v.sampleRaw.replace(/^\s+/, ''), 'utf8'), now);
  if (v.sampleFrom === '' && v.sampleSubject === '' && v.sampleText.trim() === '') return null;
  return {
    ...sampleSender(v.sampleFrom), subject: v.sampleSubject, textFull: v.sampleText.trim(), date: now.toISOString(),
    to: [], messageId: null, authResults: [], auto: false,
  };
}
