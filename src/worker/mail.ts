import { createTransport } from 'nodemailer';
import { silentLogger } from '../log.ts';
import type { Job } from '../store/jobs.ts';
import type { SmtpSettings } from '../store/notifications.ts';
import type { WorkerDeps } from './send.ts';

export interface MailContent { subject: string; text: string }

/** Wysyłka jednego maila; testy podstawiają atrapę. */
export type Mailer = (settings: SmtpSettings & { password: string | null }, mail: MailContent) => Promise<void>;

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
    ...(s.user ? { auth: { user: s.user, pass: s.password ?? '' } } : {}),
    connectionTimeout: SMTP_TIMEOUT_MS, greetingTimeout: SMTP_TIMEOUT_MS, socketTimeout: SMTP_TIMEOUT_MS,
  });
  try {
    await transport.sendMail({
      from: { name: s.fromName, address: s.fromAddress }, to: s.recipients.join(', '),
      subject: mail.subject, text: mail.text,
    });
  } finally {
    transport.close();
  }
};

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
  try {
    await (deps.mailer ?? nodemailerMailer)({ ...settings, password: deps.notifications?.smtpPassword() ?? null }, mail);
    deps.jobs.complete(job.id);
    log.info('mail.wyslany', { jobId: job.id, recipients: settings.recipients.length, attempt: job.attempts + 1 });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const delay = MAIL_BACKOFF_MS[job.attempts];
    if (delay === undefined) {
      deps.jobs.fail(job.id, reason);
      log.error('mail.porzucony', { jobId: job.id, error: e });
      return;
    }
    deps.jobs.retry(job.id, new Date(now.getTime() + delay), reason);
    log.warn('mail.ponowienie', { jobId: job.id, attempt: job.attempts + 1, error: e });
  }
}
