import { silentLogger, type Logger } from '../log.ts';
import type { JobsRepo } from '../store/jobs.ts';
import type { NotificationsRepo, QueueRow, RuleRow } from '../store/notifications.ts';
import { composeGroup, composeSingle, composeSms } from './compose.ts';
import { NOTIFICATION_EVENTS, SMS_ONLY_EVENTS, type AdminNotifier, type NotificationEvent } from './rules.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Zdarzenia, dla których powstał kanał SMS: osobna pula doby, której nie wyczerpią inne powiadomienia (spec 8.4). */
export const SMS_ALARM_EVENTS: NotificationEvent[] = ['m365_disconnected', 'mail_undeliverable'];
/** Dobowe pule SMS-ów powiadomień dla całej bramki: reguły z włączonym SMS-em oraz zdarzenia alarmowe. */
export const SMS_PER_DAY = { rules: 10, alarm: 5 } as const;
const RULE_POOL_EVENTS = NOTIFICATION_EVENTS.filter((e) => !SMS_ALARM_EVENTS.includes(e));

/** Wynik wysyłki SMS-a powiadomienia; odmowa niesie powód do logu. */
export type SmsSendResult = { ok: true } | { ok: false; reason: string };

type SmsPool = keyof typeof SMS_PER_DAY;
/** Stan jednej tury `flushSms`: wykorzystanie pul doby i pierwsza odmowa wysyłki. */
interface SmsTurn {
  send: (text: string, now: Date) => SmsSendResult; instance: string | null;
  used: Record<SmsPool, number>; failure: string | null;
}

export interface NotifierDeps {
  notifications: NotificationsRepo; jobs: JobsRepo; log?: Logger;
  /** Kanał SMS (`sendNotificationSms`); bez niego oczekujące SMS-y czekają. */
  sms?: (text: string, now: Date) => SmsSendResult;
  /** Nazwa integracji albo konta z klucza tematu; temat SMS-a nigdy nie pochodzi ze streszczenia. */
  subjectName?: (subjectKey: string | null) => string;
}

interface Named { get(id: number): { name: string } | undefined }

/** Nazwa tematu z klucza `integration:<id>`, `mailbox:<id>`, `account:<id>` albo `m365:<id>`; inny klucz daje pusty napis. */
export function subjectNamer(repos: { integrations: Named; accounts: Named; m365Accounts: Named }): (subjectKey: string | null) => string {
  return (subjectKey) => {
    const match = /^(integration|mailbox|account|m365):(\d+)$/.exec(subjectKey ?? '');
    if (!match) return '';
    const id = Number(match[2]);
    const repo = match[1] === 'account' ? repos.accounts : match[1] === 'm365' ? repos.m365Accounts : repos.integrations;
    return repo.get(id)?.name ?? '';
  };
}

/**
 * Powiadomienia administratora: `notify` odkłada wpis do kolejki w bazie ze stanem każdego kanału,
 * `flush` (co minutę z workera) zamienia oczekujące wpisy na zadania `mail` według reguł, a `flushSms`
 * wysyła SMS-y w granicach limitu reguły i dobowych pul. Liczniki i bufor grupowania są w tabeli,
 * więc restart nic nie gubi, a bez SMTP wpisy mailowe czekają.
 */
export class Notifier implements AdminNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  notify(event: NotificationEvent, subjectKey: string | null, summary: string, now: Date, dedupKey?: string): void {
    const rule = this.deps.notifications.rule(event);
    if (rule.enabled === 0) return;
    const mail = !SMS_ONLY_EVENTS.includes(event) && !this.aboutSmtpAccount(event, subjectKey);
    const sms = rule.sms === 1 && this.deps.notifications.smsSettings()?.enabled === true;
    if (!mail && !sms) return;
    this.deps.notifications.enqueue({
      event, at: now, summary, mail, sms,
      ...(subjectKey !== null ? { subjectKey } : {}),
      ...(dedupKey !== undefined ? { dedupKey } : {}),
    });
  }

  /** Zerwane konto Microsoft 365, przez które wychodzi SMTP: droga mailowa z definicji nie zadziała (spec 7.2). */
  private aboutSmtpAccount(event: NotificationEvent, subjectKey: string | null): boolean {
    if (event !== 'm365_disconnected') return false;
    const smtp = this.deps.notifications.smtp();
    return smtp?.authMode === 'm365' && smtp.m365AccountId !== null && subjectKey === `m365:${smtp.m365AccountId}`;
  }

  /**
   * SMS-y oczekujące w kolejce, niezależnie od SMTP. Każdy wpis kończy turę jako wysłany albo pominięty:
   * ponad limit reguły w ostatniej godzinie, ponad pulę doby, przy wyłączonym kanale albo po odmowie wysyłki.
   * Odmowa wynika z ustawień kanału (klucz, numery, nadpis), więc kolejne wpisy tej tury nie próbują ponownie.
   */
  flushSms(now: Date): void {
    const queued = this.deps.notifications.rules()
      .map((rule) => ({ rule, rows: this.deps.notifications.pendingSms(rule.event) }))
      .filter((q) => q.rows.length > 0);
    if (queued.length === 0) return;
    if (this.deps.notifications.smsSettings()?.enabled !== true) {
      for (const { rule, rows } of queued) this.dropSms(rule.event, rows, 'kanał SMS wyłączony', now);
      return;
    }
    const send = this.deps.sms;
    if (!send) return;
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const turn: SmsTurn = {
      send, instance: this.deps.notifications.smtp()?.instanceName ?? null, failure: null,
      used: {
        rules: this.deps.notifications.smsSentSince(RULE_POOL_EVENTS, dayAgo),
        alarm: this.deps.notifications.smsSentSince(SMS_ALARM_EVENTS, dayAgo),
      },
    };
    for (const { rule, rows } of queued) this.sendRule(rule, rows, turn, now);
  }

  /** SMS-y jednej reguły: najpierw limit reguły w ostatniej godzinie, potem pula doby. */
  private sendRule(rule: RuleRow, rows: QueueRow[], turn: SmsTurn, now: Date): void {
    const log = this.deps.log ?? silentLogger;
    const pool: SmsPool = SMS_ALARM_EVENTS.includes(rule.event) ? 'alarm' : 'rules';
    let hourBudget = Math.max(0, rule.maxPerHour - this.deps.notifications.smsSentSince([rule.event], new Date(now.getTime() - HOUR_MS)));
    let sent = 0;
    const overHour: QueueRow[] = [];
    const overDay: QueueRow[] = [];
    const failed: QueueRow[] = [];
    for (const row of rows) {
      if (turn.failure !== null) { failed.push(row); continue; }
      if (hourBudget === 0) { overHour.push(row); continue; }
      if (turn.used[pool] >= SMS_PER_DAY[pool]) { overDay.push(row); continue; }
      const result = turn.send(composeSms(turn.instance, rule.event, this.deps.subjectName?.(row.subjectKey) ?? ''), now);
      if (!result.ok) {
        turn.failure = result.reason;
        failed.push(row);
        continue;
      }
      this.deps.notifications.markSms([row.id], 'sent', now);
      hourBudget -= 1;
      turn.used[pool] += 1;
      sent += 1;
    }
    if (sent > 0) log.info('powiadomienie.sms_wyslane', { event: rule.event, count: sent });
    this.dropSms(rule.event, overHour, 'limit reguły', now);
    this.dropSms(rule.event, overDay, 'limit doby', now);
    if (failed.length > 0) {
      this.deps.notifications.markSms(failed.map((r) => r.id), 'suppressed', now);
      log.error('powiadomienie.sms_niewyslane', { event: rule.event, powod: turn.failure, count: failed.length });
    }
  }

  private dropSms(event: NotificationEvent, rows: QueueRow[], powod: string, now: Date): void {
    if (rows.length === 0) return;
    this.deps.notifications.markSms(rows.map((r) => r.id), 'suppressed', now);
    (this.deps.log ?? silentLogger).warn('powiadomienie.sms_pominiete', { event, powod, count: rows.length });
  }

  flush(now: Date): void {
    const settings = this.deps.notifications.smtp();
    if (!settings) return;
    const log = this.deps.log ?? silentLogger;
    for (const rule of this.deps.notifications.rules()) {
      if (rule.enabled === 0) continue;
      const pending = this.deps.notifications.pending(rule.event);
      if (pending.length === 0) continue;
      const hourAgo = new Date(now.getTime() - HOUR_MS);
      // Pominięte od ostatniego maila tej reguły - następny mail o nich wspomina.
      const lastSent = this.deps.notifications.lastSentAt(rule.event);
      const suppressed = this.deps.notifications.suppressedCountSince(rule.event, lastSent ? new Date(lastSent) : new Date(0));

      if (rule.groupHours > 0) {
        if (lastSent && now.getTime() - Date.parse(lastSent) < rule.groupHours * HOUR_MS) continue;
        this.send(composeGroup(settings, rule.event, pending, suppressed), now);
        this.deps.notifications.markSent(pending.map((r) => r.id), now);
        log.info('powiadomienie.wyslane', { event: rule.event, count: pending.length });
        continue;
      }

      // Bez grupowania: każdy wpis osobno, do `maxPerHour` w ostatniej godzinie; nadmiar liczony.
      const budget = Math.max(0, rule.maxPerHour - this.deps.notifications.sentCountSince(rule.event, hourAgo));
      const toSend: QueueRow[] = pending.slice(0, budget);
      const toDrop = pending.slice(budget);
      toSend.forEach((row, index) => {
        this.send(composeSingle(settings, rule.event, row, index === 0 ? suppressed : 0), now);
        this.deps.notifications.markSent([row.id], now);
      });
      this.deps.notifications.markSuppressed(toDrop.map((r) => r.id));
      if (toSend.length > 0) log.info('powiadomienie.wyslane', { event: rule.event, count: toSend.length, suppressed: toDrop.length });
    }
  }

  private send(mail: { subject: string; text: string }, now: Date): void {
    this.deps.jobs.enqueue('mail', { subject: mail.subject, text: mail.text }, now);
  }
}
