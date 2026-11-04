import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { composeSms } from '../../src/notifications/compose.ts';
import { Notifier, subjectNamer } from '../../src/notifications/notifier.ts';
import type { NotificationEvent } from '../../src/notifications/rules.ts';
import { openDatabase } from '../../src/store/db.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { M365AccountsRepo } from '../../src/store/m365-accounts.ts';
import { NotificationsRepo, type RulePatch } from '../../src/store/notifications.ts';

const T0 = new Date('2026-09-02T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
let db: Database;
let notifications: NotificationsRepo;
let jobs: JobsRepo;
let notifier: Notifier;

const smtp = () => notifications.saveSmtp({ host: 'smtp.example', port: 587, security: 'starttls', user: null, fromAddress: 'gate@example', fromName: 'Multiinfo Gate', recipients: ['admin@example'], instanceName: 'bramka-test', panelUrl: 'https://panel.example/' }, T0);
const mails = () => jobs.claim(at(1000), 100).filter((j) => j.type === 'mail').map((j) => j.payload as { subject: string; text: string });

beforeEach(() => {
  db = openDatabase(':memory:');
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
    expect(mail!.text).toContain('oraz 30 kolejnych');
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

describe('Notifier - kanał SMS', () => {
  let m365: M365AccountsRepo;
  let sent: string[];
  let smsNotifier: Notifier;
  let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  const DAY = 24 * 60;
  const smsOn = (enabled = true) => notifications.saveSmsSettings({ enabled, recipients: ['48601000001'], apiKeyId: null, orig: null }, T0);
  const rule = (event: NotificationEvent, over: Partial<RulePatch> = {}) => {
    const r = notifications.rule(event);
    notifications.saveRule(event, { enabled: r.enabled, maxPerHour: r.maxPerHour, groupHours: r.groupHours, params: r.params, sms: r.sms, ...over });
  };
  const queue = (event: NotificationEvent) => db.prepare('SELECT status, sms_status AS smsStatus FROM notification_queue WHERE event = ? ORDER BY id').all(event);
  const smsStates = (event: NotificationEvent) => (db.prepare('SELECT sms_status AS s FROM notification_queue WHERE event = ? ORDER BY id').all(event) as Array<{ s: string }>).map((r) => r.s);
  const account = (name: string) => m365.create({ name, tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, T0);
  const smtpVia = (accountId: number) => notifications.saveSmtp({
    host: 'smtp.office365.com', port: 587, security: 'starttls', user: 'alarmy@firma.pl', fromAddress: 'alarmy@firma.pl', fromName: 'Multiinfo Gate',
    recipients: ['admin@firma.pl'], instanceName: 'Biuro', panelUrl: null, authMode: 'm365', m365AccountId: accountId,
  }, T0);

  beforeEach(() => {
    m365 = new M365AccountsRepo(db, randomBytes(32));
    sent = [];
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    smsNotifier = new Notifier({
      notifications, jobs, log,
      sms: (text) => { sent.push(text); return { ok: true }; },
      subjectName: (key) => (key === null ? '' : `Temat ${key}`),
    });
  });

  it('m365_disconnected o koncie, przez które wychodzi SMTP: tylko SMS', () => {
    smsOn();
    const id = account('Alarmy');
    smtpVia(id);
    smsNotifier.notify('m365_disconnected', `m365:${id}`, 'Alarmy: token odrzucony', T0, `m365:${id}:x`);
    expect(queue('m365_disconnected')).toEqual([{ status: 'none', smsStatus: 'pending' }]);
  });

  it('m365_disconnected o innym koncie: mail i SMS', () => {
    smsOn();
    const smtpAccount = account('Alarmy');
    const other = account('Zamówienia');
    smtpVia(smtpAccount);
    smsNotifier.notify('m365_disconnected', `m365:${other}`, 'Zamówienia: token odrzucony', T0);
    expect(queue('m365_disconnected')).toEqual([{ status: 'pending', smsStatus: 'pending' }]);
  });

  it('SMS tylko przy włączonym przełączniku reguły i włączonym kanale; oba kanały wyłączone nie dają wpisu', () => {
    smsOn();
    smsNotifier.notify('integration_error', 'integration:1', 'Kuma: pusta treść', T0);
    expect(queue('integration_error')).toEqual([{ status: 'pending', smsStatus: 'none' }]);
    rule('integration_error', { sms: 1 });
    smsNotifier.notify('integration_error', 'integration:1', 'Kuma: pusta treść', at(1));
    expect(queue('integration_error')[1]).toEqual({ status: 'pending', smsStatus: 'pending' });
    smsOn(false);
    smsNotifier.notify('mail_undeliverable', 'smtp', 'mail niewysłany', T0);
    expect(queue('mail_undeliverable')).toEqual([]);
  });

  it('flushSms bez SMTP wysyła SMS z nazwą tematu, nigdy ze streszczenia', () => {
    smsOn();
    rule('integration_error', { sms: 1 });
    smsNotifier.notify('integration_error', 'integration:7', 'Kuma: odrzucone uwierzytelnienie od jan@firma.pl', T0);
    smsNotifier.flushSms(T0);
    expect(sent).toEqual(['Multiinfo Gate: Błąd integracji - Temat integration:7. Szczegóły w panelu.']);
    expect(smsStates('integration_error')).toEqual(['sent']);
    expect(jobs.depth()).toBe(0);
  });

  it('jedenaście powiadomień z SMS-em: 10 wysłanych, 11. pominięte, a zerwane konto korzysta z osobnej puli', () => {
    smsOn();
    rule('integration_error', { sms: 1, maxPerHour: 100 });
    for (let n = 1; n <= 11; n += 1) smsNotifier.notify('integration_error', `integration:${n}`, `Integracja ${n}`, at(n));
    smsNotifier.flushSms(at(20));
    expect(sent).toHaveLength(10);
    expect(smsStates('integration_error').filter((s) => s === 'sent')).toHaveLength(10);
    expect(smsStates('integration_error')[10]).toBe('suppressed');
    expect(log.warn).toHaveBeenCalledWith('powiadomienie.sms_pominiete', expect.objectContaining({ event: 'integration_error', powod: 'limit doby', count: 1 }));
    smsNotifier.notify('m365_disconnected', 'm365:1', 'Alarmy: token odrzucony', at(30));
    smsNotifier.flushSms(at(30));
    expect(sent).toHaveLength(11);
    expect(smsStates('m365_disconnected')).toEqual(['sent']);
    // Po dobie pula reguł znów przyjmuje SMS-y.
    smsNotifier.notify('integration_error', 'integration:12', 'Integracja 12', at(DAY + 21));
    smsNotifier.flushSms(at(DAY + 21));
    expect(sent).toHaveLength(12);
  });

  it('szósty SMS o zerwanym koncie albo niewysłanym mailu w ciągu doby zostaje pominięty', () => {
    smsOn();
    rule('m365_disconnected', { maxPerHour: 100 });
    for (let n = 1; n <= 3; n += 1) smsNotifier.notify('m365_disconnected', `m365:${n}`, 'x', at(n));
    for (let n = 1; n <= 3; n += 1) {
      smsNotifier.notify('mail_undeliverable', 'smtp', 'x', at(n * 61));
      smsNotifier.flushSms(at(n * 61));
    }
    expect(sent).toHaveLength(5);
    expect(smsStates('mail_undeliverable')).toEqual(['sent', 'sent', 'suppressed']);
  });

  it('limit reguły na godzinę obejmuje SMS-y', () => {
    smsOn();
    smsNotifier.notify('mail_undeliverable', 'smtp', 'x', T0);
    smsNotifier.notify('mail_undeliverable', 'smtp', 'x', at(1));
    smsNotifier.flushSms(at(1));
    expect(smsStates('mail_undeliverable')).toEqual(['sent', 'suppressed']);
    expect(log.warn).toHaveBeenCalledWith('powiadomienie.sms_pominiete', expect.objectContaining({ event: 'mail_undeliverable', powod: 'limit reguły', count: 1 }));
    smsNotifier.notify('mail_undeliverable', 'smtp', 'x', at(62));
    smsNotifier.flushSms(at(62));
    expect(smsStates('mail_undeliverable')).toEqual(['sent', 'suppressed', 'sent']);
  });

  it('wyłączony kanał: flushSms nie wysyła, a oczekujące SMS-y pomija z wpisem w logu', () => {
    smsOn();
    smsNotifier.notify('mail_undeliverable', 'smtp', 'x', T0);
    smsOn(false);
    smsNotifier.flushSms(T0);
    expect(sent).toEqual([]);
    expect(smsStates('mail_undeliverable')).toEqual(['suppressed']);
    expect(log.warn).toHaveBeenCalledWith('powiadomienie.sms_pominiete', expect.objectContaining({ event: 'mail_undeliverable', powod: 'kanał SMS wyłączony', count: 1 }));
  });

  it('odmowa wysyłki: SMS pominięty, powód w logu, bez kolejnych prób w tej turze', () => {
    smsOn();
    const attempts: string[] = [];
    const failing = new Notifier({ notifications, jobs, log, sms: (text) => { attempts.push(text); return { ok: false, reason: 'klucz wygasł' }; } });
    rule('m365_disconnected', { maxPerHour: 100 });
    failing.notify('m365_disconnected', 'm365:1', 'x', T0);
    failing.notify('m365_disconnected', 'm365:2', 'x', T0);
    failing.flushSms(T0);
    expect(attempts).toHaveLength(1);
    expect(smsStates('m365_disconnected')).toEqual(['suppressed', 'suppressed']);
    expect(log.error).toHaveBeenCalledWith('powiadomienie.sms_niewyslane', expect.objectContaining({ event: 'm365_disconnected', powod: 'klucz wygasł', count: 2 }));
  });

  it('nazwa instancji z ustawień SMTP trafia do treści, a adresy e-mail z tematu znikają', () => {
    smsOn();
    smtp();
    const named = new Notifier({ notifications, jobs, sms: (text) => { sent.push(text); return { ok: true }; }, subjectName: () => 'alarmy@firma.pl' });
    named.notify('mail_undeliverable', 'smtp', 'mail do admin@example niewysłany', T0);
    named.flushSms(T0);
    expect(sent).toEqual(['Multiinfo Gate bramka-test: Mail z powiadomieniem niewysłany. Szczegóły w panelu.']);
    expect(sent.join('')).not.toContain('@');
  });

  it('flush maili pomija wpisy tylko SMS-owe', () => {
    smsOn();
    smtp();
    smsNotifier.notify('mail_undeliverable', 'smtp', 'x', T0);
    smsNotifier.flush(T0);
    expect(mails()).toEqual([]);
  });
});

describe('composeSms', () => {
  it('wzór z instancją, etykietą i tematem', () => {
    expect(composeSms('Biuro', 'm365_disconnected', 'Alarmy')).toBe('Multiinfo Gate Biuro: Konto Microsoft 365 wymaga logowania - Alarmy. Szczegóły w panelu.');
  });
  it('bez tematu i bez nazwy instancji', () => {
    expect(composeSms(null, 'mail_undeliverable', '')).toBe('Multiinfo Gate: Mail z powiadomieniem niewysłany. Szczegóły w panelu.');
    expect(composeSms('  ', 'release_available', '  ')).toBe('Multiinfo Gate: Nowe wydanie bramki. Szczegóły w panelu.');
  });
  it('treść nie zawiera adresów e-mail', () => {
    const text = composeSms('alarmy@firma.pl', 'm365_disconnected', 'Dyżur IT alarmy@firma.pl');
    expect(text).not.toContain('@');
    expect(text).toBe('Multiinfo Gate: Konto Microsoft 365 wymaga logowania - Dyżur IT. Szczegóły w panelu.');
  });
});

describe('subjectNamer', () => {
  const name = subjectNamer({
    integrations: { get: (id: number) => (id === 3 ? { name: 'Kuma' } : undefined) },
    accounts: { get: (id: number) => (id === 4 ? { name: 'Firma' } : undefined) },
    m365Accounts: { get: (id: number) => (id === 5 ? { name: 'Alarmy' } : undefined) },
  });
  it('nazwa integracji, skrzynki, konta Multiinfo i konta Microsoft 365', () => {
    expect(name('integration:3')).toBe('Kuma');
    expect(name('mailbox:3')).toBe('Kuma');
    expect(name('account:4')).toBe('Firma');
    expect(name('m365:5')).toBe('Alarmy');
  });
  it('temat nieznany, usunięty albo pusty daje pusty napis', () => {
    expect(name('integration:9')).toBe('');
    expect(name('smtp')).toBe('');
    expect(name(null)).toBe('');
    expect(name('m365:5:x')).toBe('');
  });
});
