import { createHash } from 'node:crypto';
import { silentLogger, type Logger } from '../log.ts';
import type { AccountsRepo } from '../store/accounts.ts';
import type { InboundMessagesRepo } from '../store/inbound-messages.ts';
import type { InboundServicesRepo } from '../store/inbound-services.ts';
import type { IntegrationsRepo } from '../store/integrations.ts';
import type { JobsRepo } from '../store/jobs.ts';
import type { MessagesRepo } from '../store/messages.ts';
import type { NotificationsRepo } from '../store/notifications.ts';
import type { WebhookDeliveriesRepo } from '../store/webhook-deliveries.ts';
import { lastValidDay, warsawDay, warsawStamp } from '../time/warsaw.ts';
import { composeDaily } from './compose.ts';
import type { AdminNotifier } from './rules.ts';

const DAY_MS = 86_400_000;

export interface ScannerDeps {
  accounts: AccountsRepo;
  inboundServices: InboundServicesRepo;
  messages: MessagesRepo;
  inbound: InboundMessagesRepo;
  integrations: IntegrationsRepo;
  deliveries: WebhookDeliveriesRepo;
  notifications: NotificationsRepo;
  notifier: AdminNotifier;
  jobs: JobsRepo;
  log?: Logger;
}

const numbers = (value: unknown): number[] => (Array.isArray(value) ? value.map(Number).filter((n) => Number.isFinite(n) && n > 0) : []);
const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** Dni do końca ważności; 0 w dniu wygaśnięcia, ujemne po nim. */
export const daysLeft = (notAfter: string, now: Date): number => Math.ceil((Date.parse(notAfter) - now.getTime()) / DAY_MS);

/**
 * Stan bramki, którego nikt nie zgłasza zdarzeniem: certyfikaty na progach, konta wstrzymane,
 * odbiór w błędzie, podsumowanie dzienne. Woła go tura utrzymaniowa workera co minutę;
 * powtórki wycina `dedupKey`, więc każde sprawdzenie może być bezmyślne.
 */
export class NotificationScanner {
  constructor(private readonly deps: ScannerDeps) {}

  scan(now: Date): void {
    this.certificates(now);
    this.pausedAccounts(now);
    this.inboundFailures(now);
    this.dailySummary(now);
  }

  private certificates(now: Date): void {
    const rule = this.deps.notifications.rule('certificate_expiring');
    if (rule.enabled === 0) return;
    const thresholds = numbers(rule.params.days).sort((a, b) => a - b);
    if (thresholds.length === 0) return;
    for (const account of this.deps.accounts.list()) {
      if (account.active === 0) continue;
      const left = daysLeft(account.certNotAfter, now);
      // Najniższy próg, który już minął: przy 20 dniach próg 30, przy 10 dniach próg 14. Jeden mail na próg.
      const threshold = thresholds.find((d) => left <= d);
      if (threshold === undefined) continue;
      const when = left < 0 ? `wygasł ${lastValidDay(account.certNotAfter)}` : `wygasa ${lastValidDay(account.certNotAfter)} (za ${left} dni)`;
      this.deps.notifier.notify('certificate_expiring', `account:${account.id}`,
        `Konto ${account.name}: certyfikat ${when}`, now, `account:${account.id}:${threshold}:${account.certNotAfter}`);
    }
  }

  private pausedAccounts(now: Date): void {
    for (const account of this.deps.accounts.list()) {
      if (account.pausedReason === null) continue;
      const digest = createHash('sha256').update(account.pausedReason).digest('hex').slice(0, 16);
      this.deps.notifier.notify('account_rejecting', `account:${account.id}`,
        `Konto ${account.name} wstrzymane: ${account.pausedReason}`, now, `account:${account.id}:paused:${digest}`);
    }
  }

  private inboundFailures(now: Date): void {
    const rule = this.deps.notifications.rule('inbound_failure');
    if (rule.enabled === 0) return;
    const afterMs = numberOr(rule.params.afterMinutes, 15) * 60_000;
    const hour = now.toISOString().slice(0, 13);
    for (const account of this.deps.accounts.list()) {
      for (const state of this.deps.inboundServices.states(account.id)) {
        if (state.error === null) continue;
        // Błąd świeższy niż ostatnie udane pytanie o `afterMinutes` - chwilowa czkawka Plusa nie budzi nikogo.
        if (state.lastPollAt !== null && now.getTime() - Date.parse(state.lastPollAt) < afterMs) continue;
        this.deps.notifier.notify('inbound_failure', `inbound:${account.id}:${state.serviceId}`,
          `Konto ${account.name}, usługa ${state.serviceId}: odbiór w błędzie (${state.error})`, now,
          `inbound:${account.id}:${state.serviceId}:${hour}`);
      }
    }
  }

  /** Raz dziennie o zadanej godzinie w czasie polskim; od razu jako zadanie `mail`, bez grupowania. */
  private dailySummary(now: Date): void {
    const rule = this.deps.notifications.rule('daily_summary');
    if (rule.enabled === 0) return;
    const settings = this.deps.notifications.smtp();
    if (!settings) return;
    const iso = now.toISOString();
    if (Number(warsawStamp(iso).slice(11, 13)) !== numberOr(rule.params.hour, 8)) return;
    const day = warsawDay(iso);
    const id = this.deps.notifications.enqueue({ event: 'daily_summary', at: now, dedupKey: `daily:${day}`, summary: `Podsumowanie dzienne ${day}` });
    if (id === null) return;
    const since = new Date(now.getTime() - DAY_MS);
    const mail = composeDaily(settings, {
      day,
      messages: this.deps.messages.countSince(since),
      inbound: this.deps.inbound.countSince(since),
      integrationsTroubled: this.deps.integrations.countTroubled(since),
      deliveries: this.deps.deliveries.counts(since),
      accounts: this.deps.accounts.list().filter((a) => a.active === 1)
        .map((a) => ({ name: a.name, paused: a.pausedReason, certificateDaysLeft: daysLeft(a.certNotAfter, now) })),
    });
    this.deps.jobs.enqueue('mail', { subject: mail.subject, text: mail.text }, now);
    this.deps.notifications.markSent([id], now);
    (this.deps.log ?? silentLogger).info('powiadomienie.podsumowanie', { day });
  }
}
