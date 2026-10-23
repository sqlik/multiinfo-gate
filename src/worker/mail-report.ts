/**
 * Raport z wysyłki Mail2SMS do nadawcy maila: zadanie `mail.report` składa treść z wierszy
 * `messages`, pierwszy raz minutę po wysyłce. Numer bez statusu ostatecznego oznacza kolejne
 * sprawdzenia, aż wszystkie numery będą ostateczne albo minie doba od wysyłki.
 */
import { statusLabel } from '../admin/views/status-labels.ts';
import type { MailInOutcome } from '../integrations/pipeline.ts';
import type { MailInConfig } from '../integrations/config.ts';
import type { ParsedMail } from '../integrations/mail/parse.ts';
import { silentLogger } from '../log.ts';
import type { GatewayStatus } from '../multiinfo/status.ts';
import type { Job } from '../store/jobs.ts';
import type { MessageRow } from '../store/messages.ts';
import { warsawDay, warsawTime } from '../time/warsaw.ts';
import type { MailContent } from './mail.ts';
import type { WorkerDeps } from './send.ts';

/** Pierwszy raport minutę po wysyłce: zwykle raporty doręczenia są już w bazie. */
export const REPORT_FIRST_DELAY_MS = 60_000;
/** Odstęp kolejnego sprawdzenia według czasu od wysyłki: do 2 min co minutę, do 5 min co 2, do 15 co 5, do 30 co 10, do 2 h co 30, potem co godzinę. */
export const REPORT_SCHEDULE: ReadonlyArray<readonly [untilMs: number, delayMs: number]> = [
  [120_000, 60_000], [300_000, 120_000], [900_000, 300_000], [1_800_000, 600_000], [7_200_000, 1_800_000],
];
export const REPORT_TAIL_MS = 3_600_000;
/** Doba od wysyłki: potem mail o braku potwierdzenia i koniec sprawdzania. */
export const REPORT_GIVE_UP_MS = 24 * 3_600_000;

export interface MailReportPayload {
  /** `first`: raport minutę po wysyłce; `final`: oczekiwanie na statusy ostateczne. */
  stage: 'first' | 'final';
  integrationId: number;
  to: string[]; subject: string; inReplyTo?: string; references?: string;
  messageIds: string[]; recipients: string[];
  /** Chwila przetworzenia maila (ISO); czas w nagłówku raportu pochodzi z wierszy `messages`, gdy już przekazane. */
  sentAt: string;
  /** Tylko etap `first`: treść SMS-a i pominięte numery nie leżą w kolejce przez dobę. */
  invalid?: string[]; text?: string; parts?: number;
}

export type ReportKind = 'first' | 'final' | 'timeout';

const FINAL_STATUSES = new Set<GatewayStatus>(['delivered', 'failed', 'expired', 'cancelled', 'blocked']);

/** Wiersz usunięty (retencja, kasacja konta) nie doczeka się statusu, więc liczy się jako ostateczny. */
export const isFinalRow = (row: MessageRow | undefined): boolean => row === undefined || row.finalAt !== null || FINAL_STATUSES.has(row.status);

const partsWord = (n: number): string => (n === 1 ? 'część' : 'części');

/** Ładunek zadania raportu z wyniku potoku dla przetworzonego maila. */
export function reportPayload(outcome: Extract<MailInOutcome, { kind: 'sent' }>, mail: ParsedMail, integrationId: number, now: Date): MailReportPayload {
  return {
    stage: 'first', integrationId, to: [mail.from], subject: mail.subject.trim(),
    ...(mail.messageId ? { inReplyTo: mail.messageId, references: mail.messageId } : {}),
    messageIds: outcome.messageIds, recipients: outcome.recipients, sentAt: now.toISOString(),
    invalid: outcome.invalid, text: outcome.text, parts: outcome.parts,
  };
}

/** Godzina w Polsce; z datą, gdy to inny dzień niż dzień wysyłki. */
const stampNear = (iso: string, baseIso: string): string => (warsawDay(iso) === warsawDay(baseIso) ? warsawTime(iso) : `${warsawDay(iso)} ${warsawTime(iso)}`);

/** Linia odbiorcy: numer, status po polsku, czas statusu ostatecznego, opis błędu. */
function recipientLine(number: string, row: MessageRow | undefined, baseIso: string): string {
  if (!row) return `${number} - brak danych`;
  if (row.status === 'sent' && row.finalAt !== null) return `${row.dest} - wysłana ${stampNear(row.finalAt, baseIso)}, bez potwierdzenia doręczenia`;
  const label = statusLabel(row.status);
  const when = row.finalAt !== null && FINAL_STATUSES.has(row.status) ? ` ${stampNear(row.finalAt, baseIso)}` : '';
  const error = (row.status === 'failed' || row.status === 'blocked') && row.error ? `: ${row.error}` : '';
  return `${row.dest} - ${label}${when}${error}`;
}

export function composeReport(payload: MailReportPayload, rows: Array<MessageRow | undefined>, kind: ReportKind): MailContent {
  const subject = payload.subject === '' ? '(bez tematu)' : payload.subject;
  // Chwila przekazania do Multiinfo z pierwszego przekazanego wiersza; przed przekazaniem (konto wstrzymane) chwila przetworzenia maila.
  const handedAt = rows.find((r) => r?.sentAt)?.sentAt ?? null;
  const baseIso = handedAt ?? payload.sentAt;
  const when = `${warsawDay(baseIso)} o ${warsawTime(baseIso)}`;
  const verb = handedAt ? 'wysłany' : 'przyjęty do wysyłki';
  const verbGen = handedAt ? 'wysłanego' : 'przyjętego do wysyłki';
  const recipients = ['Odbiorcy:', ...payload.messageIds.map((_, i) => recipientLine(payload.recipients[i] ?? '', rows[i], baseIso))];
  let lines: string[];
  if (kind === 'first') {
    const orig = rows.find((r) => r !== undefined)?.orig ?? null;
    const parts = payload.parts ?? 0;
    const invalid = payload.invalid ?? [];
    lines = [
      `SMS z wiadomości „${subject}” ${verb} ${when}.`,
      `Nadpis: ${orig ?? 'brak'}`,
      `Treść (${parts} ${partsWord(parts)}):`,
      payload.text ?? '',
      '',
      ...recipients,
    ];
    if (invalid.length === 1) lines.push('', `Pominięto nieprawidłowy numer: ${invalid[0]}.`);
    else if (invalid.length > 1) lines.push('', `Pominięto nieprawidłowe numery: ${invalid.join(', ')}.`);
    if (!rows.every(isFinalRow)) lines.push('', 'Informacja o statusie doręczenia SMS dla numerów w kolejce zostanie dostarczona w kolejnej wiadomości e-mail.');
  } else if (kind === 'final') {
    lines = [`Wynik końcowy SMS-a z wiadomości „${subject}” ${verbGen} ${when}.`, '', ...recipients];
  } else {
    lines = [
      `SMS z wiadomości „${subject}” ${verb} ${when}: doręczenia nie udało się potwierdzić w ciągu 24 godzin. Dalsze odpytania o status nie będą realizowane.`,
      '', ...recipients,
    ];
  }
  return {
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text: lines.join('\n'), to: payload.to,
    ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
    ...(payload.references ? { references: payload.references } : {}),
    autoReply: true,
  };
}

/** Odstęp do następnego sprawdzenia według czasu, jaki minął od wysyłki. */
export function nextCheckDelayMs(elapsedMs: number): number {
  for (const [until, delay] of REPORT_SCHEDULE) if (elapsedMs < until) return delay;
  return REPORT_TAIL_MS;
}

/** Następne sprawdzenie, nie później niż doba od wysyłki. */
function nextCheck(payload: MailReportPayload, now: Date): Date {
  const sent = Date.parse(payload.sentAt);
  return new Date(Math.min(now.getTime() + nextCheckDelayMs(now.getTime() - sent), sent + REPORT_GIVE_UP_MS));
}

/** Etap końcowy niesie tylko to, co potrzebne do złożenia wyniku: bez treści SMS-a. */
function finalPayload(payload: MailReportPayload): MailReportPayload {
  const { invalid: _invalid, text: _text, parts: _parts, ...rest } = payload;
  return { ...rest, stage: 'final' };
}

export async function handleMailReport(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  if (!deps.notifications?.smtp()) {
    // SMTP wyłączone między wysyłką a raportem: nie ma dokąd posłać maila.
    deps.jobs.fail(job.id, 'brak ustawień SMTP');
    log.warn('mail.raport_bez_smtp', { jobId: job.id });
    return;
  }
  const payload = job.payload as unknown as MailReportPayload;
  // Odpowiedzi wyłączone albo skrzynka usunięta po wysyłce: nadawca nie chce już raportów.
  const integration = deps.integrations?.get(payload.integrationId);
  if (deps.integrations && (!integration || !(integration.config as MailInConfig).reply?.enabled)) {
    deps.jobs.complete(job.id);
    return;
  }
  const rows = payload.messageIds.map((id) => deps.messages.get(id));
  const allFinal = rows.every(isFinalRow);
  const send = (kind: ReportKind) => deps.jobs.enqueue('mail', { ...composeReport(payload, rows, kind) }, now);

  if (payload.stage === 'first') {
    // Jedna transakcja: raport, zadanie końcowe i zakończenie bieżącego razem albo wcale.
    deps.jobs.transaction(() => {
      send('first');
      if (!allFinal) deps.jobs.enqueue('mail.report', { ...finalPayload(payload) }, nextCheck(payload, now));
      deps.jobs.complete(job.id);
    });
    return;
  }
  if (allFinal) {
    deps.jobs.transaction(() => {
      send('final');
      deps.jobs.complete(job.id);
    });
    return;
  }
  if (now.getTime() >= Date.parse(payload.sentAt) + REPORT_GIVE_UP_MS) {
    deps.jobs.transaction(() => {
      send('timeout');
      deps.jobs.complete(job.id);
    });
    log.info('mail.raport_bez_potwierdzenia', { jobId: job.id, messageIds: payload.messageIds });
    return;
  }
  // Odłożenie bez zużycia prób: licznik prób zostaje dla nieoczekiwanych wyjątków pętli.
  deps.jobs.defer(job.id, nextCheck(payload, now), '');
}
