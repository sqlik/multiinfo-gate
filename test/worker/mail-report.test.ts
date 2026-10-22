import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { REPORT_GIVE_UP_MS, composeReport, handleMailReport, nextCheckDelayMs, type MailReportPayload } from '../../src/worker/mail-report.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { defaultMailInConfig } from '../../src/integrations/config.ts';
import type { WorkerDeps } from '../../src/worker/send.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessagesRepo, type MessageRow } from '../../src/store/messages.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';
import { accountInput, messageInput } from '../store/helpers.ts';

/** 11:40:05 czasu polskiego (CEST). */
const SENT_AT = '2026-10-22T09:40:05.000Z';
const NOW = new Date('2026-10-22T09:41:05.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

let db: ReturnType<typeof openDatabase>;
let jobs: JobsRepo;
let messages: MessagesRepo;
let notifications: NotificationsRepo;
let deps: WorkerDeps;
let apiKeyId: number;
let accountId: number;
let integrations: IntegrationsRepo;
let integrationId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  const masterKey = randomBytes(32);
  const accounts = new AccountsRepo(db, masterKey);
  accountId = accounts.insert(accountInput());
  apiKeyId = new ApiKeysRepo(db, masterKey).insert({
    accountId, name: 'k', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 9, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  jobs = new JobsRepo(db);
  messages = new MessagesRepo(db);
  notifications = new NotificationsRepo(db, masterKey);
  integrations = new IntegrationsRepo(db, masterKey);
  integrationId = integrations.insert({
    name: 'Skrzynka', kind: 'mail_in', apiKeyId, serviceId: null, orig: null, preset: 'poczta-wlasny', enabled: 1,
    config: { ...defaultMailInConfig(), reply: { enabled: true } }, secrets: {}, storePayloads: 0, createdAt: NOW,
  });
  deps = { jobs, messages, notifications, integrations } as unknown as WorkerDeps;
});

const smtp = () => notifications.saveSmtp({ host: 'smtp.example', port: 465, security: 'tls', user: null, password: null, fromAddress: 'g@example', fromName: 'G', recipients: ['admin@example'], instanceName: 'mi', panelUrl: null }, NOW);

const payload = (over: Partial<MailReportPayload> = {}): MailReportPayload => ({
  stage: 'first', integrationId, to: ['jan@przyklad.test'], subject: 'Awaria pompy', inReplyTo: '<1@x>', references: '<1@x>',
  messageIds: ['msg_1', 'msg_2'], recipients: ['48601000001', '48601000002'], invalid: [],
  text: 'Awaria pompy. Proszę o kontakt.', parts: 5, sentAt: SENT_AT, ...over,
});

const row = (over: Partial<MessageRow>): MessageRow => ({
  ...messageInput(), orig: 'Firma Info', miIds: ['1'], status: 'sent', miStatus: null, miSubstatus: null, providerCode: null, error: null,
  createdAt: SENT_AT, sentAt: SENT_AT, finalAt: null, trace: null, inReplyTo: null, integrationId: 1, ...over,
});
const delivered = (dest: string) => row({ dest, status: 'delivered', finalAt: '2026-10-22T09:40:14.000Z' });
const inTransit = (dest: string) => row({ dest, status: 'sent' });

/** Wiersze w bazie dla `handleMailReport`: statusy po `setStatus`. */
function seed(statuses: Array<{ id: string; dest: string; status: MessageRow['status']; finalAt?: Date }>) {
  for (const s of statuses) {
    messages.insert(messageInput({ id: s.id, apiKeyId, accountId, dest: s.dest, orig: 'Firma Info' }));
    messages.setSent(s.id, ['1'], new Date(SENT_AT));
    if (s.status !== 'sent') messages.setStatus(s.id, { status: s.status, error: s.status === 'failed' ? 'numer nie istnieje' : null, finalAt: s.finalAt ?? NOW });
  }
}
const pending = () => (db.prepare('SELECT type, payload, run_at FROM jobs ORDER BY id').all() as Array<{ type: string; payload: string; run_at: string }>)
  .map((j) => ({ type: j.type, payload: JSON.parse(j.payload) as Record<string, unknown>, runAt: j.run_at }));
const reportJob = (p: MailReportPayload, attempts = 0) => ({ id: jobs.enqueue('mail.report', { ...p }, NOW), type: 'mail.report' as const, payload: { ...p }, attempts, lastError: null });

describe('composeReport', () => {
  it('pierwszy raport: nagłówek z czasem polskim, nadpis, treść z liczbą części, status na numer, zapowiedź drugiego maila', () => {
    const mail = composeReport(payload(), [delivered('48601000001'), inTransit('48601000002')], 'first');
    expect(mail).toEqual({
      subject: 'Re: Awaria pompy', to: ['jan@przyklad.test'], inReplyTo: '<1@x>', references: '<1@x>', autoReply: true,
      text: [
        'SMS z wiadomości „Awaria pompy” wysłany 2026-10-22 o 11:40:05.',
        'Nadpis: Firma Info',
        'Treść (5 części):',
        'Awaria pompy. Proszę o kontakt.',
        '',
        'Odbiorcy:',
        '48601000001 - doręczona 11:40:14',
        '48601000002 - w drodze',
        '',
        'Potwierdzenie doręczenia dla numerów w drodze zostanie dostarczone w kolejnej wiadomości.',
      ].join('\n'),
    });
  });

  it('wszystkie doręczone: bez zapowiedzi; jedna część; nadpis nieustawiony; pominięte numery', () => {
    const one = composeReport(payload({ messageIds: ['msg_1'], recipients: ['48601000001'], parts: 1, invalid: ['60010'] }), [delivered('48601000001')], 'first');
    expect(one.text).toContain('Nadpis: Firma Info');
    expect(one.text).toContain('Treść (1 część):');
    expect(one.text).toContain('Pominięto nieprawidłowy numer: 60010.');
    expect(one.text).not.toContain('w kolejnej wiadomości');
    const two = composeReport(payload({ invalid: ['1', '2'] }), [row({ dest: '48601000001', orig: null, status: 'delivered', finalAt: NOW.toISOString() }), delivered('48601000002')], 'first');
    expect(two.text).toContain('Nadpis: brak');
    expect(two.text).toContain('Pominięto nieprawidłowe numery: 1, 2.');
    expect(two.text).not.toContain('w kolejnej wiadomości');
  });

  it('raport końcowy: wynik z czasem i opisem błędu', () => {
    const mail = composeReport(payload({ stage: 'final' }), [delivered('48601000001'), row({ dest: '48601000002', status: 'failed', error: 'numer nie istnieje', finalAt: '2026-10-22T10:01:00.000Z' })], 'final');
    expect(mail.subject).toBe('Re: Awaria pompy');
    expect(mail.text).toBe([
      'Wynik końcowy SMS-a z wiadomości „Awaria pompy” wysłanego 2026-10-22 o 11:40:05.',
      '',
      'Odbiorcy:',
      '48601000001 - doręczona 11:40:14',
      '48601000002 - błąd 12:01:00: numer nie istnieje',
    ].join('\n'));
  });

  it('po 24 godzinach: informacja o braku potwierdzenia i końcu odpytań', () => {
    const mail = composeReport(payload({ stage: 'final' }), [delivered('48601000001'), inTransit('48601000002')], 'timeout');
    expect(mail.text).toBe([
      'SMS z wiadomości „Awaria pompy” wysłany 2026-10-22 o 11:40:05: doręczenia nie udało się potwierdzić w ciągu 24 godzin. Dalsze odpytania o status nie będą realizowane.',
      '',
      'Odbiorcy:',
      '48601000001 - doręczona 11:40:14',
      '48601000002 - w drodze',
    ].join('\n'));
  });

  it('wiersz usunięty: numer z ładunku i „brak danych”; pusty temat; przedawniona i zablokowana z czasem', () => {
    const mail = composeReport(payload({ subject: '' }), [undefined, row({ dest: '48601000002', status: 'expired', finalAt: '2026-10-23T09:40:05.000Z' })], 'first');
    expect(mail.subject).toBe('Re: (bez tematu)');
    expect(mail.text).toContain('SMS z wiadomości „(bez tematu)” wysłany');
    expect(mail.text).toContain('48601000001 - brak danych');
    expect(mail.text).toContain('48601000002 - przedawniona 2026-10-23 11:40:05');
    const blocked = composeReport(payload(), [row({ dest: '48601000001', status: 'blocked', error: 'numer zastrzeżony', finalAt: NOW.toISOString() }), row({ dest: '48601000002', status: 'queued' })], 'first');
    expect(blocked.text).toContain('48601000001 - zablokowana 11:41:05: numer zastrzeżony');
    expect(blocked.text).toContain('48601000002 - w kolejce');
  });

  it('status ostateczny „wysłana” bez raportu doręczenia (21/0, 21/4) jest opisany i nie zapowiada kolejnej wiadomości', () => {
    const rows = [delivered('48601000001'), row({ dest: '48601000002', status: 'sent', miStatus: 21, miSubstatus: 0, finalAt: '2026-10-22T09:40:20.000Z' })];
    const first = composeReport(payload(), rows, 'first');
    expect(first.text).toContain('48601000002 - wysłana 11:40:20, bez potwierdzenia doręczenia');
    expect(first.text).not.toContain('w kolejnej wiadomości');
    expect(composeReport(payload({ stage: 'final' }), rows, 'final').text).toContain('48601000002 - wysłana 11:40:20, bez potwierdzenia doręczenia');
  });

  it('brak wiersza liczy się jako stan ostateczny: bez zapowiedzi kolejnej wiadomości', () => {
    expect(composeReport(payload(), [delivered('48601000001'), undefined], 'first').text).not.toContain('w kolejnej wiadomości');
  });

  it('czas w nagłówku pochodzi z chwili przekazania do Multiinfo; bez przekazania „przyjęty do wysyłki”', () => {
    const later = [row({ dest: '48601000001', status: 'delivered', sentAt: '2026-10-22T09:40:30.000Z', finalAt: '2026-10-22T09:40:44.000Z' }), inTransit('48601000002')];
    expect(composeReport(payload(), later, 'first').text).toContain('wysłany 2026-10-22 o 11:40:30.');
    expect(composeReport(payload({ stage: 'final' }), later, 'final').text).toContain('wysłanego 2026-10-22 o 11:40:30.');
    const queued = [row({ dest: '48601000001', status: 'queued', sentAt: null }), row({ dest: '48601000002', status: 'queued', sentAt: null })];
    const text = composeReport(payload(), queued, 'first').text;
    expect(text).toContain('SMS z wiadomości „Awaria pompy” przyjęty do wysyłki 2026-10-22 o 11:40:05.');
    expect(text).toContain('48601000001 - w kolejce');
    expect(composeReport(payload({ stage: 'final' }), queued, 'timeout').text).toContain('przyjęty do wysyłki 2026-10-22 o 11:40:05: doręczenia nie udało się potwierdzić');
  });

  it('ładunek etapu końcowego nie zawiera treści SMS-a', () => {
    const final = composeReport(payload({ stage: 'final', text: undefined, parts: undefined, invalid: undefined }), [delivered('48601000001'), delivered('48601000002')], 'final');
    expect(final.text).toContain('Wynik końcowy');
  });
});

describe('nextCheckDelayMs', () => {
  it('odstęp rośnie z czasem od wysyłki: 1, 2, 5, 10, 30 min, potem co godzinę', () => {
    expect([60_000, 119_000, 120_000, 299_000, 300_000, 899_000, 900_000, 1_799_000, 1_800_000, 7_199_000, 7_200_000, 86_000_000].map(nextCheckDelayMs))
      .toEqual([60_000, 60_000, 120_000, 120_000, 300_000, 300_000, 600_000, 600_000, 1_800_000, 1_800_000, 3_600_000, 3_600_000]);
  });
});

describe('handleMailReport', () => {
  it('pierwszy przebieg z numerem w drodze: mail z raportem i nowe zadanie końcowe za minutę', async () => {
    smtp();
    seed([{ id: 'msg_1', dest: '48601000001', status: 'delivered' }, { id: 'msg_2', dest: '48601000002', status: 'sent' }]);
    const job = reportJob(payload());
    await handleMailReport(job, deps, NOW);
    const left = pending();
    expect(left.map((j) => j.type)).toEqual(['mail', 'mail.report']);
    expect(left[0]!.payload).toMatchObject({ subject: 'Re: Awaria pompy', to: ['jan@przyklad.test'], inReplyTo: '<1@x>', autoReply: true });
    expect(String(left[0]!.payload.text)).toContain('48601000002 - w drodze');
    expect(left[1]!.payload).toEqual({ stage: 'final', integrationId, to: ['jan@przyklad.test'], subject: 'Awaria pompy', inReplyTo: '<1@x>', references: '<1@x>', messageIds: ['msg_1', 'msg_2'], recipients: ['48601000001', '48601000002'], sentAt: SENT_AT });
    expect(left[1]!.runAt).toBe(at(60_000).toISOString());
  });

  it('brak wiersza w bazie: raport bez zapowiedzi i bez zadania końcowego', async () => {
    smtp();
    seed([{ id: 'msg_1', dest: '48601000001', status: 'delivered' }]);
    await handleMailReport(reportJob(payload()), deps, NOW);
    expect(pending().map((j) => j.type)).toEqual(['mail']);
    expect(String(pending()[0]!.payload.text)).toContain('48601000002 - brak danych');
  });

  it('odpowiedzi wyłączone albo skrzynka usunięta po wysyłce: bez maila, zadanie zakończone', async () => {
    smtp();
    seed([{ id: 'msg_1', dest: '48601000001', status: 'delivered' }, { id: 'msg_2', dest: '48601000002', status: 'delivered' }]);
    const row = integrations.get(integrationId)!;
    integrations.update(integrationId, { ...row, config: { ...(row.config as ReturnType<typeof defaultMailInConfig>), reply: { enabled: false } } } as never, NOW);
    await handleMailReport(reportJob(payload()), deps, NOW);
    expect(pending()).toEqual([]);
    await handleMailReport(reportJob(payload({ integrationId: 999 })), deps, NOW);
    expect(pending()).toEqual([]);
  });

  it('pierwszy przebieg ze wszystkimi statusami ostatecznymi: tylko mail, bez zadania końcowego', async () => {
    smtp();
    seed([{ id: 'msg_1', dest: '48601000001', status: 'delivered' }, { id: 'msg_2', dest: '48601000002', status: 'failed' }]);
    await handleMailReport(reportJob(payload()), deps, NOW);
    expect(pending().map((j) => j.type)).toEqual(['mail']);
    expect(String(pending()[0]!.payload.text)).not.toContain('w kolejnej wiadomości');
  });

  it('przebieg końcowy przed terminem bez zmian: odłożenie według czasu od wysyłki bez zużycia prób, nie później niż 24 h', async () => {
    smtp();
    seed([{ id: 'msg_1', dest: '48601000001', status: 'delivered' }, { id: 'msg_2', dest: '48601000002', status: 'sent' }]);
    const three = new Date(Date.parse(SENT_AT) + 180_000);
    await handleMailReport(reportJob(payload({ stage: 'final' })), deps, three);
    const left = db.prepare('SELECT run_at, attempts FROM jobs').all() as Array<{ run_at: string; attempts: number }>;
    expect(left).toEqual([{ run_at: new Date(three.getTime() + 120_000).toISOString(), attempts: 0 }]);
    const lateNow = new Date(Date.parse(SENT_AT) + REPORT_GIVE_UP_MS - 30_000);
    await handleMailReport(reportJob(payload({ stage: 'final' })), deps, lateNow);
    expect(pending().at(-1)!.runAt).toBe(new Date(Date.parse(SENT_AT) + REPORT_GIVE_UP_MS).toISOString());
  });

  it('przebieg końcowy po wszystkich statusach: mail końcowy i koniec zadania', async () => {
    smtp();
    seed([{ id: 'msg_1', dest: '48601000001', status: 'delivered' }, { id: 'msg_2', dest: '48601000002', status: 'failed' }]);
    await handleMailReport(reportJob(payload({ stage: 'final' }), 2), deps, NOW);
    expect(pending().map((j) => j.type)).toEqual(['mail']);
    expect(String(pending()[0]!.payload.text)).toContain('Wynik końcowy SMS-a');
    expect(String(pending()[0]!.payload.text)).toContain('48601000002 - błąd');
  });

  it('przebieg końcowy po 24 godzinach: mail o braku potwierdzenia i koniec zadania', async () => {
    smtp();
    seed([{ id: 'msg_1', dest: '48601000001', status: 'delivered' }, { id: 'msg_2', dest: '48601000002', status: 'sent' }]);
    await handleMailReport(reportJob(payload({ stage: 'final' }), 9), deps, new Date(Date.parse(SENT_AT) + REPORT_GIVE_UP_MS));
    expect(pending().map((j) => j.type)).toEqual(['mail']);
    expect(String(pending()[0]!.payload.text)).toContain('nie udało się potwierdzić w ciągu 24 godzin');
  });

  it('bez SMTP: zadanie kończy się bez maila', async () => {
    seed([{ id: 'msg_1', dest: '48601000001', status: 'delivered' }, { id: 'msg_2', dest: '48601000002', status: 'sent' }]);
    await handleMailReport(reportJob(payload()), deps, NOW);
    expect(pending()).toEqual([]);
  });
});
