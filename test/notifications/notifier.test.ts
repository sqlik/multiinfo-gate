import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Notifier } from '../../src/notifications/notifier.ts';
import { openDatabase } from '../../src/store/db.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';

const T0 = new Date('2026-09-02T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
let notifications: NotificationsRepo;
let jobs: JobsRepo;
let notifier: Notifier;

const smtp = () => notifications.saveSmtp({ host: 'smtp.example', port: 587, security: 'starttls', user: null, fromAddress: 'gate@example', fromName: 'Multiinfo Gate', recipients: ['admin@example'], instanceName: 'bramka-test', panelUrl: 'https://panel.example/' }, T0);
const mails = () => jobs.claim(at(1000), 100).filter((j) => j.type === 'mail').map((j) => j.payload as { subject: string; text: string });

beforeEach(() => {
  const db = openDatabase(':memory:');
  notifications = new NotificationsRepo(db, randomBytes(32));
  jobs = new JobsRepo(db);
  notifier = new Notifier({ notifications, jobs });
});

describe('Notifier', () => {
  it('bez SMTP nic nie kolejkuje maili, ale wpisy czekają', () => {
    notifier.notify('integration_error', 'integration:1', 'Kuma: pusta treść', T0);
    notifier.flush(T0);
    expect(jobs.depth()).toBe(0);
    expect(notifications.pending('integration_error')).toHaveLength(1);
    smtp();
    notifier.flush(at(61));
    expect(mails()).toHaveLength(1);
  });
  it('reguła wyłączona - notify nic nie zapisuje', () => {
    notifications.saveRule('integration_error', { enabled: 0, maxPerHour: 5, groupHours: 0, params: {} });
    notifier.notify('integration_error', null, 'x', T0);
    expect(notifications.pending('integration_error')).toHaveLength(0);
  });
  it('bez grupowania: każdy wpis osobnym mailem do maxPerHour, reszta suppressed i doliczona w następnym', () => {
    smtp();
    notifications.saveRule('integration_throttled', { enabled: 1, maxPerHour: 2, groupHours: 0, params: {} });
    for (const n of [1, 2, 3]) notifier.notify('integration_throttled', `integration:${n}`, `Integracja ${n}: przekroczony limit`, T0);
    notifier.flush(T0);
    let sent = mails();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.subject).toBe('[Multiinfo Gate bramka-test] Limit burzy przekroczony');
    expect(sent[0]!.text).toContain('Integracja 1: przekroczony limit');
    expect(sent[0]!.text).toContain('https://panel.example/integracje');
    expect(sent[0]!.text).not.toContain('Pominięto');
    expect(notifications.suppressedCountSince('integration_throttled', new Date(0))).toBe(1);
    // W tej samej godzinie limit wyczerpany - kolejne wpisy też odpadają.
    notifier.notify('integration_throttled', 'integration:4', 'Integracja 4', at(10));
    notifier.flush(at(10));
    expect(mails()).toHaveLength(0);
    // Po godzinie następny mail wspomina pominięte.
    notifier.notify('integration_throttled', 'integration:5', 'Integracja 5', at(61));
    notifier.flush(at(61));
    sent = mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Pominięto 2 podobnych');
  });
  it('z grupowaniem: pierwszy mail od razu, potem jeden z listą po upływie groupHours', () => {
    smtp();
    for (const n of [1, 2, 3]) notifier.notify('integration_error', 'integration:1', `Kuma: błąd ${n}`, T0);
    notifier.flush(T0);
    let sent = mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('[Multiinfo Gate bramka-test] Błąd integracji: 3');
    expect(sent[0]!.text).toContain('- 2026-09-02 12:00:00  Kuma: błąd 1');
    notifier.notify('integration_error', 'integration:1', 'Kuma: błąd 4', at(20));
    notifier.notify('integration_error', 'integration:1', 'Kuma: błąd 5', at(30));
    notifier.flush(at(30));
    expect(mails()).toHaveLength(0);
    expect(notifications.pending('integration_error')).toHaveLength(2);
    notifier.flush(at(60));
    sent = mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain('Błąd integracji: 2');
    expect(sent[0]!.text).toContain('Kuma: błąd 4');
    expect(sent[0]!.text).toContain('Kuma: błąd 5');
  });
  it('grupa ponad 100 pozycji pokazuje 100 i liczbę reszty', () => {
    smtp();
    for (let i = 0; i < 130; i += 1) notifier.notify('webhook_undelivered', null, `FS: ${i}`, T0);
    notifier.flush(T0);
    const [mail] = mails();
    expect(mail!.subject).toContain(': 130');
    expect(mail!.text).toContain('...i 30 więcej');
    expect(mail!.text.split('\n').filter((l) => l.startsWith('- ')).length).toBe(100);
  });
  it('dedupKey trzyma jedno powiadomienie na temat', () => {
    smtp();
    notifier.notify('certificate_expiring', 'account:1', 'Konto Firma: certyfikat wygasa', T0, 'account:1:30');
    notifier.notify('certificate_expiring', 'account:1', 'Konto Firma: certyfikat wygasa', at(1), 'account:1:30');
    notifier.flush(at(1));
    expect(mails()).toHaveLength(1);
  });
  it('treść maila nie zawiera pełnego numeru ani treści SMS-a, gdy wołający ich nie poda', () => {
    smtp();
    notifier.notify('integration_error', 'integration:7', 'Kuma: brak numeru odbiorcy (wiadomość msg_abc, odbiorca ...001)', T0);
    notifier.flush(T0);
    const [mail] = mails();
    expect(mail!.text).not.toMatch(/\d{11}/);
    expect(mail!.text).toContain('msg_abc');
    expect(mail!.text).toContain('Wiadomość wysłana automatycznie');
  });
});
