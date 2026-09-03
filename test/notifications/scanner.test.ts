import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Notifier } from '../../src/notifications/notifier.ts';
import { daysLeft, NotificationScanner } from '../../src/notifications/scanner.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { InboundServicesRepo } from '../../src/store/inbound-services.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';
import { WebhookDeliveriesRepo } from '../../src/store/webhook-deliveries.ts';
import { accountInput } from '../store/helpers.ts';

// 2026-09-02 10:00 UTC = 12:00 w Polsce.
const T0 = new Date('2026-09-02T10:00:00Z');
const plusDays = (d: number) => new Date(T0.getTime() + d * 86_400_000);
let accounts: AccountsRepo;
let services: InboundServicesRepo;
let notifications: NotificationsRepo;
let jobs: JobsRepo;
let scanner: NotificationScanner;
let accountId: number;
let db: ReturnType<typeof openDatabase>;

const pendingOf = (event: Parameters<NotificationsRepo['pending']>[0]) => notifications.pending(event).map((r) => r.summary);
const mails = () => jobs.claim(plusDays(1000), 100).filter((j) => j.type === 'mail').map((j) => j.payload as { subject: string; text: string });

beforeEach(() => {
  db = openDatabase(':memory:');
  const key = randomBytes(32);
  accounts = new AccountsRepo(db, key);
  services = new InboundServicesRepo(db);
  notifications = new NotificationsRepo(db, key);
  jobs = new JobsRepo(db);
  // Certyfikat ważny 25 dni od T0.
  accountId = accounts.insert(accountInput({ name: 'Firma', certNotAfter: plusDays(25).toISOString() }));
  scanner = new NotificationScanner({
    accounts, inboundServices: services, messages: new MessagesRepo(db), inbound: new InboundMessagesRepo(db),
    integrations: new IntegrationsRepo(db, key), deliveries: new WebhookDeliveriesRepo(db, key), notifications,
    notifier: new Notifier({ notifications, jobs }), jobs,
  });
});

describe('daysLeft', () => {
  it('liczy dni do końca ważności w górę', () => {
    expect(daysLeft(plusDays(25).toISOString(), T0)).toBe(25);
    expect(daysLeft(new Date(T0.getTime() + 3600_000).toISOString(), T0)).toBe(1);
    expect(daysLeft(plusDays(-2).toISOString(), T0)).toBe(-2);
  });
});

describe('NotificationScanner - certyfikaty', () => {
  it('wpis na progu 30 dni raz, potem na 14, 7 i 1; po wymianie certyfikatu od nowa', () => {
    scanner.scan(T0);
    scanner.scan(new Date(T0.getTime() + 60_000));
    expect(pendingOf('certificate_expiring')).toEqual([`Konto Firma: certyfikat wygasa ${plusDays(25).toISOString().slice(0, 10)} (za 25 dni)`]);
    scanner.scan(plusDays(12));
    expect(pendingOf('certificate_expiring')).toHaveLength(2);
    expect(pendingOf('certificate_expiring')[1]).toContain('za 13 dni');
    scanner.scan(plusDays(20));
    scanner.scan(plusDays(24));
    expect(pendingOf('certificate_expiring')).toHaveLength(4);
    expect(pendingOf('certificate_expiring')[3]).toContain('za 1 dni');
    // Po wygaśnięciu ten sam próg 1 - bez kolejnego maila o tym samym certyfikacie.
    scanner.scan(plusDays(26));
    expect(pendingOf('certificate_expiring')).toHaveLength(4);
    // Nowa data ważności to nowy dedupKey - progi liczą się od nowa.
    db.prepare('UPDATE accounts SET cert_not_after = ? WHERE id = ?').run(plusDays(200).toISOString(), accountId);
    scanner.scan(plusDays(175));
    expect(pendingOf('certificate_expiring')).toHaveLength(5);
  });
  it('reguła wyłączona i konto nieaktywne nie dają wpisów', () => {
    notifications.saveRule('certificate_expiring', { enabled: 0, maxPerHour: 1, groupHours: 0, params: { days: [30] } });
    scanner.scan(T0);
    expect(pendingOf('certificate_expiring')).toEqual([]);
  });
});

describe('NotificationScanner - konto wstrzymane', () => {
  it('raz na powód', () => {
    accounts.pause(accountId, 'Certyfikat odrzucony przez Multiinfo, kod -7');
    scanner.scan(T0);
    scanner.scan(plusDays(1));
    expect(pendingOf('account_rejecting')).toEqual(['Konto Firma wstrzymane: Certyfikat odrzucony przez Multiinfo, kod -7']);
    accounts.pause(accountId, 'brak środków');
    scanner.scan(plusDays(1));
    expect(pendingOf('account_rejecting')).toHaveLength(2);
    accounts.resume(accountId);
    scanner.scan(plusDays(2));
    expect(pendingOf('account_rejecting')).toHaveLength(2);
  });
});

describe('NotificationScanner - odbiór', () => {
  it('błąd trwający ponad 15 min od ostatniego udanego pytania; raz na godzinę', () => {
    const t = { accountId, serviceId: '24138' };
    services.markPolled(t, new Date(T0.getTime() - 5 * 60_000));
    services.setError(t, '-24 usługa nieaktywna');
    scanner.scan(T0);
    expect(pendingOf('inbound_failure')).toEqual([]);
    const later = new Date(T0.getTime() + 20 * 60_000);
    scanner.scan(later);
    scanner.scan(new Date(later.getTime() + 60_000));
    expect(pendingOf('inbound_failure')).toEqual(['Konto Firma, usługa 24138: odbiór w błędzie (-24 usługa nieaktywna)']);
    scanner.scan(new Date(T0.getTime() + 2 * 3600_000));
    expect(pendingOf('inbound_failure')).toHaveLength(2);
    services.markPolled(t, new Date(T0.getTime() + 3 * 3600_000));
    scanner.scan(new Date(T0.getTime() + 3 * 3600_000 + 1000));
    expect(pendingOf('inbound_failure')).toHaveLength(2);
  });
  it('usługa bez udanego pytania od startu, w błędzie - zgłaszana', () => {
    services.setError({ accountId, serviceId: '24138' }, 'brak połączenia');
    scanner.scan(T0);
    expect(pendingOf('inbound_failure')).toHaveLength(1);
  });
});

describe('NotificationScanner - podsumowanie dzienne', () => {
  const enable = (hour: number) => notifications.saveRule('daily_summary', { enabled: 1, maxPerHour: 1, groupHours: 0, params: { hour } });
  const smtp = () => notifications.saveSmtp({ host: 'smtp.example', port: 587, security: 'starttls', user: null, fromAddress: 'g@example', fromName: 'Gate', recipients: ['a@example'], instanceName: 'mi', panelUrl: null }, T0);
  it('domyślnie wyłączone; bez SMTP nic; o zadanej godzinie w Polsce raz dziennie od razu jako mail', () => {
    scanner.scan(T0);
    expect(jobs.depth()).toBe(0);
    enable(12);
    scanner.scan(T0);
    expect(jobs.depth()).toBe(0);
    smtp();
    scanner.scan(new Date('2026-09-02T09:30:00Z'));
    expect(jobs.depth()).toBe(0);
    scanner.scan(T0);
    scanner.scan(new Date(T0.getTime() + 20 * 60_000));
    const sent = mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('[Multiinfo Gate mi] Podsumowanie dzienne 2026-09-02');
    expect(sent[0]!.text).toContain('- przyjęte: 0');
    expect(sent[0]!.text).toContain('- Firma: czynne, certyfikat ważny jeszcze 25 dni');
    expect(notifications.pending('daily_summary')).toEqual([]);
    scanner.scan(new Date('2026-09-03T10:00:00Z'));
    expect(mails()).toHaveLength(1);
  });

  it('wspomina o nowszym wydaniu, gdy jest do pokazania', () => {
    enable(12);
    smtp();
    const withRelease = new NotificationScanner({
      accounts, inboundServices: services, messages: new MessagesRepo(db), inbound: new InboundMessagesRepo(db),
      integrations: new IntegrationsRepo(db, randomBytes(32)), deliveries: new WebhookDeliveriesRepo(db, randomBytes(32)), notifications,
      notifier: new Notifier({ notifications, jobs }), jobs,
      release: () => ({ version: '9.9.9', url: 'https://github.com/sqlik/multiinfo-gate/releases/tag/v9.9.9', publishedAt: null }),
    });
    withRelease.scan(T0);
    const sent = mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Dostępne wydanie 9.9.9');
    expect(sent[0]!.text).toContain('https://github.com/sqlik/multiinfo-gate/releases/tag/v9.9.9');
  });
});
