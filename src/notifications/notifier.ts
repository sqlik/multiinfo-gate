import { silentLogger, type Logger } from '../log.ts';
import type { JobsRepo } from '../store/jobs.ts';
import type { NotificationsRepo, QueueRow } from '../store/notifications.ts';
import { composeGroup, composeSingle } from './compose.ts';
import type { AdminNotifier, NotificationEvent } from './rules.ts';

const HOUR_MS = 3_600_000;

export interface NotifierDeps { notifications: NotificationsRepo; jobs: JobsRepo; log?: Logger }

/**
 * Powiadomienia administratora: `notify` odkłada wpis do kolejki w bazie, `flush` (co minutę
 * z workera) zamienia oczekujące wpisy na zadania `mail` według reguł. Liczniki i bufor
 * grupowania są w tabeli, więc restart nic nie gubi, a bez SMTP wpisy po prostu czekają.
 */
export class Notifier implements AdminNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  notify(event: NotificationEvent, subjectKey: string | null, summary: string, now: Date, dedupKey?: string): void {
    if (this.deps.notifications.rule(event).enabled === 0) return;
    this.deps.notifications.enqueue({
      event, at: now, summary,
      ...(subjectKey !== null ? { subjectKey } : {}),
      ...(dedupKey !== undefined ? { dedupKey } : {}),
    });
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
