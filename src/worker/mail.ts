import { createTransport } from 'nodemailer';
import { silentLogger } from '../log.ts';
import { ACCOUNT_NEEDS_LOGIN, type M365MailboxDeps } from '../m365/mailbox.ts';
import { M365_SMTP } from '../m365/oauth.ts';
import type { Job } from '../store/jobs.ts';
import type { SmtpSettings } from '../store/notifications.ts';
import type { WorkerDeps } from './send.ts';

export interface MailContent {
  subject: string;
  text: string;
  /** Adresaci inni niż administrator (potwierdzenie zwrotne do nadawcy maila); brak to adresaci z ustawień SMTP. */
  to?: string[];
  /** Nagłówki wątku, żeby odpowiedź wpadła pod mail nadawcy. */
  inReplyTo?: string;
  references?: string;
  /** Odpowiedź automatyczna: nagłówki RFC 3834, żeby autoresponder nadawcy nie odpisał i nie zrobił pętli. */
  autoReply?: boolean;
}

/** Ustawienia SMTP z danymi logowania: hasłem albo tokenem dostępu konta Microsoft 365. */
export type MailerSettings = SmtpSettings & { password: string | null; accessToken?: string | null };

/** Wysyłka jednego maila; testy podstawiają atrapę. */
export type Mailer = (settings: MailerSettings, mail: MailContent) => Promise<void>;

/** Ponowienia po 1, 5 i 15 minutach, potem porzucenie z wpisem w logu. */
export const MAIL_BACKOFF_MS = [60_000, 300_000, 900_000] as const;

const SMTP_TIMEOUT_MS = 20_000;

/** Transport budowany na każdy mail - maili jest kilka dziennie, a ustawienia mogą się zmienić między nimi. */
export const nodemailerMailer: Mailer = async (s, mail) => {
  const transport = createTransport({
    host: s.host, port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    ...(s.accessToken
      ? { auth: { type: 'OAuth2' as const, user: s.user ?? '', accessToken: s.accessToken } }
      : s.user ? { auth: { user: s.user, pass: s.password ?? '' } } : {}),
    connectionTimeout: SMTP_TIMEOUT_MS, greetingTimeout: SMTP_TIMEOUT_MS, socketTimeout: SMTP_TIMEOUT_MS,
  });
  try {
    await transport.sendMail({
      from: { name: s.fromName, address: s.fromAddress }, to: (mail.to ?? s.recipients).join(', '),
      subject: mail.subject, text: mail.text,
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
      ...(mail.references ? { references: mail.references } : {}),
      ...(mail.autoReply ? { headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' } } : {}),
    });
  } finally {
    transport.close();
  }
};

/** Podpowiedzi do odpowiedzi serwera SMTP Microsoftu (spec 7.3), sprawdzane w tej kolejności. */
const SMTP_HINTS: Array<[RegExp, string]> = [
  [/\b5\.7\.139\b/, 'Microsoft odrzucił logowanie, ponieważ opcja „SMTP z uwierzytelnianiem” jest wyłączona dla konta albo dla całej organizacji. Opcję włącza administrator Microsoft 365 na karcie Poczta konta technicznego'],
  [/\b5\.2\.252\b|SendAsDenied/i, 'Konto nie posiada uprawnienia „Wyślij jako” dla adresu nadawcy. Należy wpisać jako adres nadawcy adres skrzynki konta albo poprosić administratora Microsoft 365 o nadanie uprawnienia'],
  [/\b5\.7\.3\b/, 'Microsoft odrzucił token konta. Należy zalogować konto przyciskiem „Zaloguj ponownie” na ekranie Konta Microsoft 365'],
];

/** Podpowiedź do znanej odmowy serwera SMTP Microsoftu; inne odpowiedzi nie otrzymują podpowiedzi. */
export function smtpHint(message: string): string | null {
  return SMTP_HINTS.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}

/**
 * Dane logowania tuż przed wysyłką. W trybie Microsoft 365 token konta i stały serwer Microsoftu, niezależnie
 * od serwera zapisanego w bazie. Konto nieistniejące, nowe albo wymagające logowania daje błąd bez wołania
 * Microsoftu, a odmowa odświeżenia tokenu przechodzi dalej jako M365AuthError.
 */
export async function mailerSettings(
  settings: SmtpSettings, password: () => string | null, m365: M365MailboxDeps | undefined, now: Date,
): Promise<MailerSettings> {
  if (settings.authMode !== 'm365') return { ...settings, password: password() };
  const account = settings.m365AccountId === null ? undefined : m365?.accounts.get(settings.m365AccountId);
  if (!m365 || !account || account.state === 'new' || account.state === 'needs_login') throw new Error(ACCOUNT_NEEDS_LOGIN);
  const access = await m365.tokens.access(account.id, now);
  return { ...settings, ...M365_SMTP, user: access.address || account.address || settings.user, password: null, accessToken: access.token };
}

/** SMTP działa przez konto Microsoft 365, które czeka na pierwsze albo ponowne logowanie. */
function smtpAccountDown(settings: SmtpSettings, deps: WorkerDeps): boolean {
  if (settings.authMode !== 'm365' || settings.m365AccountId === null) return false;
  const state = deps.m365?.accounts.get(settings.m365AccountId)?.state;
  return state === 'new' || state === 'needs_login';
}

/** Lista adresów z ładunku zadania: tablica napisów albo jeden napis; reszta to pusta lista. */
function addressList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  return [];
}

export async function handleMail(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  const settings = deps.notifications?.smtp() ?? null;
  if (!settings) {
    // Ustawienie SMTP zniknęło między zakolejkowaniem a wysyłką - maila nie ma dokąd posłać.
    deps.jobs.fail(job.id, 'brak ustawień SMTP');
    log.warn('mail.bez_smtp', { jobId: job.id });
    return;
  }
  const mail: MailContent = { subject: String(job.payload.subject ?? ''), text: String(job.payload.text ?? '') };
  const to = addressList(job.payload.to);
  if (to.length > 0) mail.to = to;
  if (typeof job.payload.inReplyTo === 'string' && job.payload.inReplyTo !== '') mail.inReplyTo = job.payload.inReplyTo;
  if (typeof job.payload.references === 'string' && job.payload.references !== '') mail.references = job.payload.references;
  if (job.payload.autoReply === true) mail.autoReply = true;
  try {
    const credentials = await mailerSettings(settings, () => deps.notifications?.smtpPassword() ?? null, deps.m365, now);
    await (deps.mailer ?? nodemailerMailer)(credentials, mail);
    deps.jobs.complete(job.id);
    log.info('mail.wyslany', { jobId: job.id, recipients: (mail.to ?? settings.recipients).length, attempt: job.attempts + 1 });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const delay = MAIL_BACKOFF_MS[job.attempts];
    if (delay === undefined) {
      deps.jobs.fail(job.id, reason);
      log.error('mail.porzucony', { jobId: job.id, error: e });
      // Potwierdzenie zwrotne do nadawcy nie jest powiadomieniem. Przy zerwanym koncie SMTP przyczynę zgłosił już m365_disconnected.
      if (to.length === 0 && !smtpAccountDown(settings, deps)) {
        deps.notifier?.notify('mail_undeliverable', 'smtp', `Mail „${mail.subject}” niewysłany po ${job.attempts + 1} próbach: ${reason}`, now);
      }
      return;
    }
    deps.jobs.retry(job.id, new Date(now.getTime() + delay), reason);
    log.warn('mail.ponowienie', { jobId: job.id, attempt: job.attempts + 1, error: e });
  }
}
