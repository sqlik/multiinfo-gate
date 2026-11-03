import { z } from '../zod.ts';
import { RULE_OPS } from './conditions.ts';
import { isValidPath } from './paths.ts';

export type IntegrationKind = 'webhook_in' | 'webhook_out' | 'mail_in' | 'sms_group' | 'power_automate';
export const INTEGRATION_KINDS: IntegrationKind[] = ['webhook_in', 'webhook_out', 'mail_in', 'sms_group', 'power_automate'];

export const OUTBOUND_EVENTS = ['message.received', 'message.sent', 'message.delivered', 'message.failed'] as const;
export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

const path = z.string().min(1).max(200).refine(isValidPath, 'nieprawidłowa ścieżka');

const conditionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('builder'), rules: z.array(z.object({ path, op: z.enum(RULE_OPS), value: z.string().max(500) })).max(20) }),
  z.object({ mode: z.literal('liquid'), expr: z.string().max(2000) }),
]);

const common = {
  condition: conditionSchema,
  throttle: z.object({ limit: z.number().int().min(1).max(1000), windowMinutes: z.number().int().min(1).max(1440) }),
  eventLogLimit: z.number().int().min(20).max(2000),
};

/** Nazwa nagłówka HTTP: token bez spacji i dwukropka. */
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

export const inboundConfigSchema = z.object({
  ...common,
  auth: z.object({
    header: z.object({ name: headerName, valueRef: z.string().min(1) }).optional(),
    basic: z.object({ user: z.string().min(1).max(200), passRef: z.string().min(1) }).optional(),
    /**
     * Sekret w polu ładunku: aplikacje, które nie umieją nagłówka, wkładają token do treści.
     * Fakturownia wysyła go pod kluczem `api_token`. Sprawdzanie jest stałoczasowe, a wartość
     * nigdy nie trafia do dziennika.
     */
    payload: z.object({ path, valueRef: z.string().min(1) }).optional(),
    sources: z.array(z.string().min(1).max(253)).max(50),
  }),
  /**
   * Zapytanie uzupełniające: jedno pytanie do aplikacji o pole, którego nie ma w ładunku.
   * Fakturownia nie wysyła numeru klienta przy fakturze, wysyła jego identyfikator. Odpowiedź
   * wchodzi do kontekstu szablonu pod nazwą z `as`, obok ładunku pod `p`.
   */
  enrich: z.object({
    url: z.string().min(1).max(2000),
    method: z.enum(['GET', 'POST']).default('GET'),
    headers: z.array(z.object({ name: headerName, value: z.string().max(2000).optional(), valueRef: z.string().optional() })).max(10).default([]),
    query: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(2000).optional(), valueRef: z.string().optional() })).max(10).default([]),
    timeoutMs: z.number().int().min(200).max(5000).default(2000),
    as: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).default('e'),
    onError: z.enum(['error', 'skip']).default('error'),
  }).optional(),
  to: z.object({ path: path.optional(), fallback: z.array(z.string().min(1)).max(50) }),
  ticketRefPath: path.optional(),
  eventIdPath: path.optional(),
  text: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('path'), path }),
    z.object({ mode: z.literal('liquid'), template: z.string().max(4000) }),
  ]),
  maxParts: z.number().int().min(1).max(9),
  overflow: z.enum(['truncate', 'reject']),
  /**
   * Co zrobić, gdy numeru odbiorcy z ładunku nie da się odczytać. Wartość `error` to kod 422,
   * mail do administratora oraz wpis o błędzie. Wartość `skip` to kod 200 i wpis o pominięciu:
   * dla sklepów, które liczą odpowiedź inną niż 2xx jako nieudane dostarczenie i po kilku takich
   * z rzędu same wyłączają webhook. Przełącznik zmienia tylko odpowiedź oraz wpis w dzienniku,
   * nigdy tego, kto dostaje SMS. Zapisane wcześniej integracje czyta się jako `error`.
   */
  invalidRecipient: z.enum(['error', 'skip']).default('error'),
});
export type InboundConfig = z.infer<typeof inboundConfigSchema>;

export const outboundConfigSchema = z.object({
  ...common,
  events: z.array(z.enum(OUTBOUND_EVENTS)).min(1),
  url: z.string().url().max(2000),
  method: z.enum(['POST', 'PUT', 'PATCH']),
  headers: z.array(z.object({ name: headerName, value: z.string().max(2000).optional(), valueRef: z.string().optional() })).max(20),
  body: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('json'), template: z.string().max(8000) }),
    z.object({ mode: z.literal('form'), fields: z.array(z.object({ name: z.string().min(1).max(100), template: z.string().max(2000) })).max(30) }),
    /** Surowy tekst (ntfy i podobne). */
    z.object({ mode: z.literal('text'), template: z.string().max(8000) }),
  ]),
  responseRefPath: path.optional(),
  sign: z.boolean(),
});
export type OutboundConfig = z.infer<typeof outboundConfigSchema>;

/** Nazwa sekretu z hasłem IMAP w `secrets_enc`. */
export const MAIL_IN_PASSWORD_REF = 'imap_password';
/** Dopuszczalne częstotliwości odpytywania skrzynki w sekundach; dolna granica 30 s chroni przed odcięciem przez dostawcę. */
export const MAIL_IN_INTERVALS = [30, 60, 120, 300, 900, 1800, 3600] as const;
export type MailInInterval = (typeof MAIL_IN_INTERVALS)[number];
export const MAIL_SECURITIES = ['tls', 'starttls', 'none'] as const;
export type MailSecurity = (typeof MAIL_SECURITIES)[number];

/** Pozycja listy nadawców: pełny adres albo cała domena z wiodącą małpą. */
const senderPattern = z.string().min(3).max(254).regex(/^(@[^@\s]+\.[^@\s]+|[^@\s]+@[^@\s]+\.[^@\s]+)$/, 'adres albo @domena');
const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const compiles = (pattern: string): boolean => { try { new RegExp(pattern); return true; } catch { return false; } };
const phrase = z.string().min(1).max(200);

/** Wycinek z treści maila: tekst po frazie do frazy albo końca linii, albo wyrażenie regularne (do 200 znaków). */
export const mailFieldSchema = z.discriminatedUnion('mode', [
  z.object({ name: fieldName, mode: z.literal('between'), after: phrase, until: phrase.optional() }),
  z.object({ name: fieldName, mode: z.literal('regex'), pattern: z.string().min(1).max(200).refine(compiles, 'wzorzec się nie kompiluje'), flags: z.string().regex(/^[im]{0,2}$/).optional() }),
]);
export type MailField = z.infer<typeof mailFieldSchema>;

/**
 * Skrzynka pocztowa czytana przez IMAP. Pusty `host` i `user` przechodzą celowo, jak pusty `url`
 * w wychodzącej: formularz ich wymaga, a domyślna konfiguracja musi być poprawna.
 */
export const mailInConfigSchema = z.object({
  ...common,
  imap: z.object({
    host: z.string().max(253),
    port: z.number().int().min(1).max(65535),
    security: z.enum(MAIL_SECURITIES),
    verifyCert: z.boolean(),
    user: z.string().max(254),
    passRef: z.literal(MAIL_IN_PASSWORD_REF),
  }),
  folder: z.string().min(1).max(200),
  intervalSec: z.number().int().refine((n): n is MailInInterval => (MAIL_IN_INTERVALS as readonly number[]).includes(n), 'częstotliwość spoza listy'),
  senders: z.array(z.object({ pattern: senderPattern, recipients: z.array(z.string().min(1)).max(50) })).max(100),
  requireAuthResults: z.boolean(),
  /** Nazwa serwera (authserv-id) w nagłówku Authentication-Results; pusta = pierwszy nagłówek od góry. */
  authservId: z.string().max(253).regex(/^[A-Za-z0-9.-]*$/).default(''),
  recipientsFromMail: z.object({ enabled: z.boolean(), where: z.enum(['subject', 'body']) }),
  to: z.object({ fallback: z.array(z.string().min(1)).max(50) }),
  clean: z.object({ cutFrom: z.array(phrase).max(10) }),
  fields: z.array(mailFieldSchema).max(20),
  text: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('simple'), variant: z.enum(['subject_text', 'subject', 'text']) }),
    z.object({ mode: z.literal('liquid'), template: z.string().max(4000) }),
  ]),
  maxParts: z.number().int().min(1).max(9),
  overflow: z.enum(['truncate', 'reject']),
  after: z.discriminatedUnion('action', [
    z.object({ action: z.literal('keep') }),
    z.object({ action: z.literal('delete') }),
    z.object({ action: z.literal('move'), folder: z.string().min(1).max(200) }),
  ]),
  reply: z.object({ enabled: z.boolean() }),
});
export type MailInConfig = z.infer<typeof mailInConfigSchema>;

/** Tryb grupy: `lists` to osobna lista nadawców i osobna lista odbiorców, `closed` to jedna lista członków piszących do siebie nawzajem. */
export const GROUP_MODES = ['lists', 'closed'] as const;
export type GroupMode = (typeof GROUP_MODES)[number];
export const GROUP_LIMITS = { senders: 100, recipients: 500, members: 500, prefix: 20, name: 40 } as const;

/** Numer znormalizowany jak odbiorcy webhooków: same cyfry z kodem kraju. */
const groupPhone = z.string().regex(/^\d{11,15}$/, 'numer nieznormalizowany');
/** Pozycja listy nadawców albo członków: numer i opcjonalna nazwa do szablonu treści. */
export const groupMemberSchema = z.object({ phone: groupPhone, name: z.string().max(GROUP_LIMITS.name).default('') });
export type GroupMember = z.infer<typeof groupMemberSchema>;

/**
 * SMS do grupy: uprawniony numer wysyła SMS z prefiksem na numer bramki, bramka rozsyła treść bez prefiksu
 * do stałej listy numerów. Listy puste przechodzą celowo, jak pusty `host` skrzynki: minimalne liczebności
 * wymusza formularz, a potok z pustą listą nikogo nie dopuszcza. Schemat sprawdza obie pary list,
 * listy drugiego trybu zapisują się puste.
 */
export const smsGroupConfigSchema = z.object({
  ...common,
  mode: z.enum(GROUP_MODES),
  senders: z.array(groupMemberSchema).max(GROUP_LIMITS.senders),
  recipients: z.array(groupPhone).max(GROUP_LIMITS.recipients),
  members: z.array(groupMemberSchema).max(GROUP_LIMITS.members),
  /** Słowo na początku SMS-a wybierające grupę; puste = każdy SMS od uprawnionego numeru. */
  prefix: z.string().max(GROUP_LIMITS.prefix).regex(/^\S*$/, 'prefiks bez białych znaków'),
  text: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('body') }),
    z.object({ mode: z.literal('sender_body') }),
    z.object({ mode: z.literal('liquid'), template: z.string().max(4000) }),
  ]),
  /** Potwierdzenie do nadawcy po rozesłaniu, domyślnie wyłączone. */
  confirm: z.object({ enabled: z.boolean() }),
  maxParts: z.number().int().min(1).max(9),
  overflow: z.enum(['truncate', 'reject']),
});
export type SmsGroupConfig = z.infer<typeof smsGroupConfigSchema>;

/**
 * Integracja z Power Automate: konektor wywołuje ją z przepływu, a bramka prowadzi każde wywołanie
 * przez limit części, ochronę przed burzą i dziennik. Bez warunku i szablonu: treść, odbiorców
 * i warunki buduje się w przepływie. Lista odbiorców służy wyłącznie akcji „Wyślij SMS do grupy”
 * i może być pusta.
 */
/** Górna granica limitu odbiorców w oknie: dziesięć pełnych rozsyłek. */
export const PA_RECIPIENT_LIMIT_MAX = 50_000;

export const powerAutomateConfigSchema = z.object({
  // Obok wywołań liczy odbiorców: jedno wywołanie rozsyłki może objąć 5000 numerów.
  throttle: common.throttle.extend({ recipients: z.number().int().min(1).max(PA_RECIPIENT_LIMIT_MAX).default(5000) }),
  eventLogLimit: common.eventLogLimit,
  recipients: z.array(groupMemberSchema).max(GROUP_LIMITS.recipients),
  maxParts: z.number().int().min(1).max(9),
  overflow: z.enum(['truncate', 'reject']),
});
export type PowerAutomateConfig = z.infer<typeof powerAutomateConfigSchema>;

export type IntegrationConfig = InboundConfig | OutboundConfig | MailInConfig | SmsGroupConfig | PowerAutomateConfig;
export type IntegrationSecrets = Record<string, string>;

export function parseConfig(kind: 'webhook_in', raw: unknown): InboundConfig;
export function parseConfig(kind: 'webhook_out', raw: unknown): OutboundConfig;
export function parseConfig(kind: 'mail_in', raw: unknown): MailInConfig;
export function parseConfig(kind: 'sms_group', raw: unknown): SmsGroupConfig;
export function parseConfig(kind: 'power_automate', raw: unknown): PowerAutomateConfig;
export function parseConfig(kind: IntegrationKind, raw: unknown): IntegrationConfig;
export function parseConfig(kind: IntegrationKind, raw: unknown): IntegrationConfig {
  if (kind === 'webhook_in') return inboundConfigSchema.parse(raw);
  if (kind === 'mail_in') return mailInConfigSchema.parse(raw);
  if (kind === 'sms_group') return smsGroupConfigSchema.parse(raw);
  if (kind === 'power_automate') return powerAutomateConfigSchema.parse(raw);
  return outboundConfigSchema.parse(raw);
}

export const defaultInboundConfig = (): InboundConfig => ({
  condition: { mode: 'builder', rules: [] }, throttle: { limit: 10, windowMinutes: 10 }, eventLogLimit: 200,
  auth: { sources: [] }, to: { fallback: [] }, text: { mode: 'liquid', template: '' }, maxParts: 1, overflow: 'truncate',
  invalidRecipient: 'error',
});

/** Adres jest pusty celowo: formularz go wymaga, a schemat zod odrzuca - domyślna wychodząca nie przejdzie bez adresu. */
export const defaultOutboundConfig = (): OutboundConfig => ({
  condition: { mode: 'builder', rules: [] }, throttle: { limit: 10, windowMinutes: 10 }, eventLogLimit: 200,
  events: ['message.received'], url: '', method: 'POST', headers: [], body: { mode: 'json', template: '' }, sign: false,
});

/** Wartości po bezpiecznej stronie: TLS, pusta lista nadawców (nikt), numery z maila i odpowiedzi wyłączone, mail zostaje w skrzynce. */
export const defaultMailInConfig = (): MailInConfig => ({
  condition: { mode: 'builder', rules: [] }, throttle: { limit: 10, windowMinutes: 10 }, eventLogLimit: 200,
  imap: { host: '', port: 993, security: 'tls', verifyCert: true, user: '', passRef: MAIL_IN_PASSWORD_REF },
  folder: 'INBOX', intervalSec: 60, senders: [], requireAuthResults: false, authservId: '',
  recipientsFromMail: { enabled: false, where: 'subject' }, to: { fallback: [] }, clean: { cutFrom: [] }, fields: [],
  text: { mode: 'simple', variant: 'subject_text' }, maxParts: 1, overflow: 'truncate', after: { action: 'keep' }, reply: { enabled: false },
});

/** Wartości po bezpiecznej stronie: osobne listy, obie puste (nikt nie pisze), bez prefiksu, sama treść, bez potwierdzenia, jedna część i przycięcie. */
export const defaultSmsGroupConfig = (): SmsGroupConfig => ({
  condition: { mode: 'builder', rules: [] }, throttle: { limit: 10, windowMinutes: 10 }, eventLogLimit: 200,
  mode: 'lists', senders: [], recipients: [], members: [], prefix: '', text: { mode: 'body' }, confirm: { enabled: false },
  maxParts: 1, overflow: 'truncate',
});

/**
 * Burza 30 wywołań na 10 minut: przepływ wysyłający po jednym SMS-ie do kilkunastu osób nie trafia
 * od razu na limit. 5000 odbiorców w tym samym oknie: jedna pełna rozsyłka przechodzi, zapętlona
 * zatrzymuje się na drugim wywołaniu. Trzy części i odrzucenie nadmiaru: treść z przepływu nie jest
 * obcinana po cichu.
 */
export const defaultPowerAutomateConfig = (): PowerAutomateConfig => ({
  throttle: { limit: 30, windowMinutes: 10, recipients: 5000 }, eventLogLimit: 200, recipients: [], maxParts: 3, overflow: 'reject',
});
