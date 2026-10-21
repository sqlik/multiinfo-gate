import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultMailInConfig, type MailInConfig } from '../../src/integrations/config.ts';
import { MailboxError } from '../../src/integrations/mail/client.ts';
import type { ParsedMail } from '../../src/integrations/mail/parse.ts';
import type { MailInIntegration } from '../../src/integrations/pipeline.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import type { NotificationEvent } from '../../src/notifications/rules.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MailInRepo } from '../../src/store/mail-in.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';
import { AUTH_RETRY_MS, BACKOFF_CAP_MS, MAX_MAIL_BYTES, MailInPoller, checkMailbox, nextPollDelayMs, replyFor, type MailInDeps } from '../../src/worker/mail-in.ts';
import { FakeMailbox, fakeConnect } from '../helpers/fake-mailbox.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-10-21T10:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const PASSWORD = 'TajneHaslo9';
let deps: MailInDeps;
let integrations: IntegrationsRepo;
let mailIn: MailInRepo;
let notifications: NotificationsRepo;
let box: FakeMailbox;
let notified: Array<{ event: NotificationEvent; subjectKey: string | null; summary: string; dedupKey?: string }>;
let apiKeyId: number;
let poller: MailInPoller;
let integ: MailInIntegration;
let seq = 0;

const eml = (from: string, subject: string, text: string, messageId: string) =>
  `From: ${from}\r\nTo: bramka@przyklad.test\r\nSubject: ${subject}\r\nDate: Wed, 21 Oct 2026 10:00:00 +0000\r\nMessage-ID: ${messageId}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;

const make = (config: Partial<MailInConfig> = {}, over: { password?: string; name?: string } = {}) => {
  seq += 1;
  const id = integrations.insert({
    name: over.name ?? `Skrzynka ${seq}`, kind: 'mail_in', apiKeyId, serviceId: null, orig: null, preset: 'poczta-wlasny', enabled: 1,
    config: { ...defaultMailInConfig(), imap: { ...defaultMailInConfig().imap, host: 'imap.przyklad.test', user: 'bramka@przyklad.test' }, senders: [{ pattern: '@przyklad.test', recipients: [] }], to: { fallback: ['48601000009'] }, intervalSec: 60, ...config },
    secrets: { imap_password: over.password ?? PASSWORD }, storePayloads: 0, createdAt: NOW,
  });
  return integrations.get(id) as MailInIntegration;
};
const smsCount = () => deps.messages.list({ limit: 100, offset: 0 }).length;
const events = (id: number) => deps.integrationEvents.list(id, 100).map((e) => [e.result, e.reason]);
const mails = () => deps.jobs.claim(at(86_400_000), 20).filter((j) => j.type === 'mail').map((j) => j.payload);

beforeEach(() => {
  seq = 0;
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accounts = new AccountsRepo(db, key);
  const accountId = accounts.insert(accountInput({ storeContent: 1 }));
  const apiKeys = new ApiKeysRepo(db, key);
  apiKeyId = apiKeys.insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
  integrations = new IntegrationsRepo(db, key);
  mailIn = new MailInRepo(db);
  notifications = new NotificationsRepo(db, key);
  box = new FakeMailbox({ uidValidity: 7, password: PASSWORD });
  notified = [];
  deps = {
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
    inbound: new InboundMessagesRepo(db), integrationEvents: new IntegrationEventsRepo(db, key), guards: new IntegrationGuardsRepo(db),
    engine: new TemplateEngine(), integrations, mailIn, connect: fakeConnect(box), notifications,
    notifier: { notify: (event, subjectKey, summary, _now, dedupKey) => { notified.push({ event, subjectKey, summary, ...(dedupKey ? { dedupKey } : {}) }); } },
  };
  poller = new MailInPoller(deps);
  integ = make();
});

afterEach(() => { vi.useRealTimers(); });

describe('MailInPoller: próg i zaległe', () => {
  it('pierwsze odpytanie ustawia próg na UIDNEXT-1 i nie rusza zaległych; nowy mail po progu daje SMS', async () => {
    box.add({ uid: 1, seen: false, source: eml('tomek@przyklad.test', 'Stare', 'x', '<1@x>') });
    await poller.tick(NOW);
    expect(mailIn.state(integ.id)).toMatchObject({ uidFloor: 1, uidvalidity: 7, unseen: 1, error: null, lastOkAt: NOW.toISOString(), nextPollAt: at(60_000).toISOString() });
    expect(smsCount()).toBe(0);
    expect(box.calls).not.toContain('source:1');
    box.add({ uid: 2, seen: false, source: eml('tomek@przyklad.test', 'Nowe', 'y', '<2@x>') });
    await poller.tick(at(30_000));
    expect(smsCount()).toBe(0);
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(1);
    expect(deps.messages.list({ limit: 1, offset: 0 })[0]!.body).toBe('Nowe\ny');
    expect(box.messages('INBOX').find((m) => m.uid === 2)?.seen).toBe(true);
    expect(mailIn.state(integ.id)).toMatchObject({ uidFloor: 2 });
    expect(mailIn.outcomes(integ.id)).toEqual([{ uid: 2, outcome: 'sent' }]);
  });

  it('backlog: pole wyboru bierze zaległe i gaśnie po pierwszym odpytaniu', async () => {
    box.add({ uid: 1, seen: false, source: eml('tomek@przyklad.test', 'Stare', 'x', '<1@x>') });
    mailIn.ensureState(integ.id, NOW);
    mailIn.setBacklog(integ.id, 1);
    await poller.tick(NOW);
    expect(smsCount()).toBe(1);
    expect(mailIn.state(integ.id)).toMatchObject({ backlog: 0, uidFloor: 1, uidvalidity: 7 });
  });

  it('nie wysyła drugi raz: po ponownym oznaczeniu jako nieprzeczytany, po restarcie w połowie ani po zmianie UIDVALIDITY z tym samym Message-ID', async () => {
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('tomek@przyklad.test', 'Nowe', 'y', '<2@x>') });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(1);
    // Ktoś celowo oznaczył mail jako nieprzeczytany: bramka go nie rusza i nie hałasuje w dzienniku.
    box.unsee(2);
    await poller.tick(at(120_000));
    expect(smsCount()).toBe(1);
    expect(events(integ.id)).toHaveLength(1);
    expect(box.messages('INBOX').find((m) => m.uid === 2)?.seen).toBe(false);
    // Restart w połowie: próg cofnięty, mail dalej nieprzeczytany, ale tabela przetworzonych go zna.
    mailIn.setFloor(integ.id, 1, 7);
    await poller.tick(at(180_000));
    expect(smsCount()).toBe(1);
    expect(events(integ.id)[0]).toEqual(['skipped', 'już przetworzony']);
    expect(box.messages('INBOX').find((m) => m.uid === 2)?.seen).toBe(false);
    // Odtworzenie folderu u dostawcy: nowa UIDVALIDITY unieważnia UID-y, próg od nowa, Message-ID dalej chroni.
    box.resetUidValidity(8);
    await poller.tick(at(240_000));
    expect(mailIn.state(integ.id)).toMatchObject({ uidvalidity: 8, uidFloor: box.uidNext - 1 });
    box.add({ uid: 9, seen: false, source: eml('tomek@przyklad.test', 'Nowe', 'y', '<2@x>') });
    await poller.tick(at(300_000));
    expect(smsCount()).toBe(1);
    expect(events(integ.id)[0]).toEqual(['skipped', 'już przetworzony']);
  });

  it('za duży mail jest pomijany bez pobierania treści, ale podlega działaniu po przetworzeniu', async () => {
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('tomek@przyklad.test', 'Duży', 'x', '<2@x>'), size: MAX_MAIL_BYTES + 1 });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(0);
    expect(events(integ.id)[0]).toEqual(['skipped', 'zbyt duży (2.0 MB)']);
    expect(box.calls).not.toContain('source:2');
    expect(box.messages('INBOX').find((m) => m.uid === 2)?.seen).toBe(true);
  });

  it('bierze najwyżej 50 maili na odpytanie, od najstarszego; reszta czeka', async () => {
    await poller.tick(NOW);
    for (let uid = 2; uid <= 62; uid += 1) box.add({ uid, seen: false, source: eml('tomek@przyklad.test', `M${uid}`, 'x', `<${uid}@x>`) });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(10);
    expect(events(integ.id).filter((e) => e[0] === 'throttled')).toHaveLength(40);
    expect(mailIn.state(integ.id)?.uidFloor).toBe(51);
    await poller.tick(at(120_000));
    expect(mailIn.state(integ.id)?.uidFloor).toBe(62);
  });
});

describe('MailInPoller: działanie po przetworzeniu', () => {
  it('move tworzy folder, delete usuwa, keep tylko flaguje; odrzucony mail też podlega działaniu', async () => {
    const move = make({ after: { action: 'move', folder: 'Przetworzone' } });
    const del = make({ after: { action: 'delete' } });
    // Trzy integracje na jednej podróbce: w każdej fazie włączona jest jedna.
    const only = (id: number) => { for (const i of [integ, move, del]) integrations.setEnabled(i.id, i.id === id, NOW); };
    await poller.tick(NOW);
    only(move.id);
    box.add({ uid: 2, seen: false, source: eml('tomek@przyklad.test', 'A', 'x', '<2@x>') });
    box.add({ uid: 3, seen: false, source: eml('obcy@inna.pl', 'B', 'x', '<3@x>') });
    await poller.tick(at(60_000));
    expect(box.messages('Przetworzone').map((m) => [m.uid, m.seen])).toEqual([[2, true], [3, true]]);
    expect(box.messages('INBOX')).toHaveLength(0);
    expect(events(move.id).map((e) => e[0])).toEqual(['skipped', 'sent']);
    only(del.id);
    box.add({ uid: 4, seen: false, source: eml('tomek@przyklad.test', 'C', 'x', '<4@x>') });
    await poller.tick(at(120_000));
    expect(box.messages('INBOX')).toHaveLength(0);
    expect(events(del.id)[0]![0]).toBe('sent');
    only(integ.id);
    box.add({ uid: 5, seen: false, source: eml('tomek@przyklad.test', 'D', 'x', '<5@x>') });
    await poller.tick(at(180_000));
    expect(box.messages('INBOX').map((m) => [m.uid, m.seen])).toEqual([[5, true]]);
    expect(smsCount()).toBe(3);
  });

  it('MOVE odrzucone przez serwer: SMS poszedł, wpis sent, stan folder, następny mail dalej przetwarzany', async () => {
    const move = make({ after: { action: 'move', folder: 'Archiwum' } });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    box.rejectMove = true;
    box.add({ uid: 2, seen: false, source: eml('tomek@przyklad.test', 'A', 'x', '<2@x>') });
    box.add({ uid: 3, seen: false, source: eml('tomek@przyklad.test', 'B', 'x', '<3@x>') });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(2);
    expect(events(move.id).map((e) => e[0])).toEqual(['sent', 'sent']);
    expect(mailIn.state(move.id)).toMatchObject({ errorKind: 'folder', failures: 1, uidFloor: 3 });
    expect(mailIn.state(move.id)?.error).toContain('Archiwum');
  });
});

describe('MailInPoller: awarie', () => {
  it('błąd logowania: stan auth, odstęp 5 min, powiadomienie mailbox_failure raz, po powrocie czyszczenie', async () => {
    box.password = 'inne';
    await poller.tick(NOW);
    const s1 = mailIn.state(integ.id)!;
    expect(s1.errorKind).toBe('auth');
    expect(s1.error).toBe('LOGIN failed: Authentication failed.');
    expect(Date.parse(s1.nextPollAt) - NOW.getTime()).toBe(AUTH_RETRY_MS);
    expect(notified).toEqual([{ event: 'mailbox_failure', subjectKey: `mailbox:${integ.id}`, summary: `Skrzynka Skrzynka 1: logowanie odrzucone od 10:00 (LOGIN failed: Authentication failed.)`, dedupKey: `mailbox:${integ.id}:${NOW.toISOString()}` }]);
    expect(s1.notifiedAt).toBe(NOW.toISOString());
    await poller.tick(at(AUTH_RETRY_MS));
    expect(notified).toHaveLength(1);
    expect(mailIn.state(integ.id)?.failures).toBe(2);
    box.password = PASSWORD;
    await poller.tick(at(2 * AUTH_RETRY_MS));
    expect(mailIn.state(integ.id)).toMatchObject({ error: null, errorKind: null, errorSince: null, failures: 0, notifiedAt: null });
  });

  it('brak hasła w konfiguracji to błąd logowania bez łączenia się z serwerem', async () => {
    const bez = make({}, { password: '' });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    expect(mailIn.state(bez.id)).toMatchObject({ errorKind: 'auth', error: 'brak hasła w konfiguracji' });
    expect(box.calls).toEqual([]);
  });

  it('błąd sieci: odstęp rosnący do 15 min, powiadomienie dopiero po 15 min awarii, drugiej awarii nowy klucz', async () => {
    box.failConnect = Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:993'), { code: 'ECONNREFUSED' });
    const expected = [60_000, 120_000, 240_000, 480_000, 900_000, 900_000];
    let t = 0;
    for (const delay of expected) {
      await poller.tick(at(t));
      const s = mailIn.state(integ.id)!;
      expect([s.errorKind, Date.parse(s.nextPollAt) - at(t).getTime()]).toEqual(['network', delay]);
      expect(s.errorSince).toBe(NOW.toISOString());
      if (t < 15 * 60_000) expect(notified).toHaveLength(0);
      t += delay;
    }
    expect(notified).toHaveLength(1);
    expect(notified[0]!.summary).toBe(`Skrzynka Skrzynka 1: serwer nie odpowiada od 10:00 (connect ECONNREFUSED 203.0.113.9:993)`);
    box.failConnect = null;
    await poller.tick(at(t));
    expect(mailIn.state(integ.id)?.error).toBeNull();
    box.failConnect = new MailboxError('other', 'cokolwiek');
    await poller.tick(at(t + 60_000));
    expect(mailIn.state(integ.id)?.errorSince).toBe(at(t + 60_000).toISOString());
  });

  it('komunikat błędu w stanie nie zawiera hasła ani loginu', async () => {
    box.failConnect = new Error(`LOGIN ${PASSWORD} for bramka@przyklad.test failed`);
    await poller.tick(NOW);
    const s = mailIn.state(integ.id)!;
    expect(s.error).toBe('LOGIN *** for *** failed');
    expect(s.error).not.toContain(PASSWORD);
    expect(mailIn.state(integ.id)?.errorKind).toBe('other');
  });

  it('nieznany folder to błąd folder; parametr afterMinutes reguły decyduje o chwili powiadomienia', async () => {
    const zly = make({ folder: 'Niema' });
    integrations.setEnabled(integ.id, false, NOW);
    notifications.saveRule('mailbox_failure', { enabled: 1, maxPerHour: 5, groupHours: 0, params: { afterMinutes: 1 } });
    await poller.tick(NOW);
    expect(mailIn.state(zly.id)?.errorKind).toBe('folder');
    expect(notified).toHaveLength(0);
    await poller.tick(at(60_000));
    expect(notified).toHaveLength(1);
    expect(notified[0]!.summary).toContain('folder niedostępny');
  });

  it('odpytanie, które wisi dłużej niż limit, kończy się błędem sieci', async () => {
    vi.useFakeTimers({ now: NOW });
    box.delayMs = 120_000;
    const t = poller.tick(NOW);
    await vi.advanceTimersByTimeAsync(61_000);
    await t;
    expect(mailIn.state(integ.id)).toMatchObject({ errorKind: 'network' });
    expect(mailIn.state(integ.id)?.error).toContain('60 s');
    await vi.advanceTimersByTimeAsync(120_000);
  });
});

describe('MailInPoller: powiadomienia i odpowiedzi', () => {
  it('błąd potoku daje integration_error, burza integration_throttled raz na okno', async () => {
    const pusta = make({ to: { fallback: [] }, throttle: { limit: 1, windowMinutes: 10 } });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('tomek@przyklad.test', 'A', 'x', '<2@x>') });
    box.add({ uid: 3, seen: false, source: eml('tomek@przyklad.test', 'B', 'x', '<3@x>') });
    box.add({ uid: 4, seen: false, source: eml('tomek@przyklad.test', 'C', 'x', '<4@x>') });
    await poller.tick(at(60_000));
    expect(notified.map((n) => [n.event, n.subjectKey])).toEqual([
      ['integration_error', `integration:${pusta.id}`], ['integration_throttled', `integration:${pusta.id}`],
    ]);
    expect(notified[0]!.summary).toContain('Skrzynka 2: ');
  });

  it('odpowiedź do nadawcy: zadanie mail z adresatem i In-Reply-To przy sent oraz error; brak przy sender_not_allowed, condition i bez SMTP', async () => {
    const odp = make({ reply: { enabled: true }, condition: { mode: 'builder', rules: [{ path: 'subject', op: 'ne', value: 'cicho' }] } });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('tomek@przyklad.test', 'A', 'x', '<2@x>') });
    await poller.tick(at(60_000));
    expect(mails()).toEqual([]);
    notifications.saveSmtp({ host: 'smtp.przyklad.test', port: 465, security: 'tls', user: null, password: null, fromAddress: 'g@przyklad.test', fromName: 'G', recipients: ['admin@przyklad.test'], instanceName: 'mi', panelUrl: null }, NOW);
    box.add({ uid: 3, seen: false, source: eml('tomek@przyklad.test', 'B', 'y', '<3@x>') });
    box.add({ uid: 4, seen: false, source: eml('obcy@inna.pl', 'C', 'y', '<4@x>') });
    box.add({ uid: 5, seen: false, source: eml('tomek@przyklad.test', 'cicho', 'y', '<5@x>') });
    box.add({ uid: 6, seen: false, source: eml('tomek@przyklad.test', 'D', 'x'.repeat(500), '<6@x>') });
    integrations.update(odp.id, { ...odp, config: { ...odp.config, overflow: 'reject' } } as never, at(120_000));
    await poller.tick(at(120_000));
    const sent = mails();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ subject: 'Re: B', text: 'SMS wysłany do 1 odbiorcy (…009), 1 część.', to: ['tomek@przyklad.test'], inReplyTo: '<3@x>', references: '<3@x>', autoReply: true });
    expect(sent[1]).toMatchObject({ subject: 'Re: D', text: 'SMS nie został wysłany: treść wymaga więcej niż 1 części.', to: ['tomek@przyklad.test'], inReplyTo: '<6@x>' });
  });
});

describe('MailInPoller: równoległość', () => {
  it('dwie skrzynki odpytywane równolegle, jedna wisząca nie blokuje drugiej; wisząca nie jest odpytana drugi raz', async () => {
    vi.useFakeTimers({ now: NOW });
    const box2 = new FakeMailbox({ uidValidity: 3, password: PASSWORD });
    const boxes: Record<number, FakeMailbox> = {};
    const second = make({ imap: { ...defaultMailInConfig().imap, host: 'imap2.przyklad.test', user: 'u' } });
    boxes[integ.id] = box;
    boxes[second.id] = box2;
    deps.connect = async (settings, timeout) => fakeConnect(settings.host === 'imap2.przyklad.test' ? box2 : box)(settings, timeout);
    poller = new MailInPoller(deps);
    await poller.tick(NOW);
    box.delayMs = 5000;
    box.add({ uid: 2, seen: false, source: eml('tomek@przyklad.test', 'A', 'x', '<2@x>') });
    box2.add({ uid: 2, seen: false, source: eml('tomek@przyklad.test', 'B', 'y', '<b2@x>') });
    const first = poller.tick(at(60_000));
    await vi.advanceTimersByTimeAsync(10);
    expect(smsCount()).toBe(1);
    expect(deps.messages.list({ limit: 1, offset: 0 })[0]!.body).toBe('B\ny');
    mailIn.pollNow(integ.id, at(60_010));
    const again = poller.tick(at(60_010));
    await vi.advanceTimersByTimeAsync(10);
    await again;
    expect(box.calls.filter((c) => c === 'connect')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    expect(smsCount()).toBe(2);
  });

  it('wyłączona skrzynka nie jest odpytywana, włączona z powrotem tak', async () => {
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    expect(box.calls).toEqual([]);
    integrations.setEnabled(integ.id, true, NOW);
    await poller.tick(NOW);
    expect(box.calls).toContain('connect');
  });
});

describe('nextPollDelayMs, replyFor, checkMailbox', () => {
  it('odstęp po błędzie rośnie od interwału do 15 min, logowanie nie częściej niż co 5 min', () => {
    expect([1, 2, 3, 4, 5, 6].map((f) => nextPollDelayMs(60, f, 'network'))).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    expect(nextPollDelayMs(30, 1, 'auth')).toBe(AUTH_RETRY_MS);
    expect(nextPollDelayMs(1800, 1, 'auth')).toBe(1_800_000);
    expect(nextPollDelayMs(3600, 2, 'other')).toBe(3_600_000);
    expect(nextPollDelayMs(900, 3, 'other')).toBe(BACKOFF_CAP_MS);
  });

  it('treść odpowiedzi według sekcji 10 specu', () => {
    const m = { from: 'a@x', fromName: '', subject: 'Awaria', textFull: '', date: '', to: [], messageId: '<1@x>', authResults: [], auto: false } satisfies ParsedMail;
    const c = { ...defaultMailInConfig(), maxParts: 3, throttle: { limit: 10, windowMinutes: 10 } };
    expect(replyFor({ kind: 'sent', messageIds: ['a', 'b'], recipients: ['48601000200', '48601000201'], invalid: [], parts: 1 }, m, c))
      .toEqual({ subject: 'Re: Awaria', text: 'SMS wysłany do 2 odbiorców (…200, …201), 1 część.', to: ['a@x'], inReplyTo: '<1@x>', references: '<1@x>', autoReply: true });
    expect(replyFor({ kind: 'sent', messageIds: ['a'], recipients: ['48601000200'], invalid: ['60010'], parts: 2 }, m, c)?.text)
      .toBe('SMS wysłany do 1 odbiorcy (…200), 2 części. Pominięto nieprawidłowy numer: 60010.');
    expect(replyFor({ kind: 'sent', messageIds: ['a'], recipients: ['48601000200'], invalid: ['1', '2'], parts: 5 }, m, c)?.text)
      .toBe('SMS wysłany do 1 odbiorcy (…200), 5 części. Pominięto nieprawidłowe numery: 1, 2.');
    expect(replyFor({ kind: 'error', code: 'too_many_parts', detail: 'x' }, m, c)?.text).toBe('SMS nie został wysłany: treść wymaga więcej niż 3 części.');
    expect(replyFor({ kind: 'error', code: 'no_recipient', detail: 'x' }, m, c)?.text).toBe('SMS nie został wysłany: nie udało się ustalić odbiorcy.');
    expect(replyFor({ kind: 'error', code: 'empty_text', detail: 'x' }, m, c)?.text).toBe('SMS nie został wysłany: treść maila po usunięciu podpisu i cytatów jest pusta.');
    expect(replyFor({ kind: 'error', code: 'invalid_phone', detail: 'Wszystkie numery są złe: 1.' }, m, c)?.text).toBe('SMS nie został wysłany: Wszystkie numery są złe: 1.');
    expect(replyFor({ kind: 'throttled', notify: false }, m, c)?.text).toBe('SMS nie został wysłany: przekroczono limit integracji (10 w 10 min).');
    // Wynik `unavailable` powstaje przed sprawdzeniem nadawcy, więc odpowiedź poszłaby także do obcego.
    expect(replyFor({ kind: 'unavailable', detail: 'x' }, m, c)).toBeNull();
    // Mail automatyczny (autoresponder, urządzenie, lista) nie dostaje odpowiedzi: inaczej pętla odpowiedzi.
    expect(replyFor({ kind: 'sent', messageIds: ['a'], recipients: ['48601000200'], invalid: [], parts: 1 }, { ...m, auto: true }, c)).toBeNull();
    expect(replyFor({ kind: 'sent', messageIds: ['a'], recipients: ['48601000200'], invalid: [], parts: 1 }, m, c)?.autoReply).toBe(true);
    expect(replyFor({ kind: 'skipped', reason: 'condition' }, m, c)).toBeNull();
    expect(replyFor({ kind: 'skipped', reason: 'sender_not_allowed' }, m, c)).toBeNull();
    expect(replyFor({ kind: 'sent', messageIds: ['a'], recipients: ['48601000200'], invalid: [], parts: 1 }, { ...m, subject: 'Re: Awaria', messageId: null }, c))
      .toEqual({ subject: 'Re: Awaria', text: 'SMS wysłany do 1 odbiorcy (…200), 1 część.', to: ['a@x'], autoReply: true });
  });

  it('checkMailbox: sukces z liczbą nieprzeczytanych i folderami; błąd logowania bez hasła w treści', async () => {
    box.add({ uid: 1, seen: false, source: 'Subject: a\r\n\r\nx' });
    const settings = { host: 'h', port: 993, security: 'tls' as const, verifyCert: true, user: 'u', password: PASSWORD };
    expect(await checkMailbox(fakeConnect(box), settings, 'INBOX')).toEqual({ ok: true, unseen: 1, folders: ['INBOX'] });
    expect(box.calls).toContain('close');
    box.failConnect = new Error(`LOGIN ${PASSWORD} rejected`);
    expect(await checkMailbox(fakeConnect(box), settings, 'INBOX')).toEqual({ ok: false, kind: 'other', error: 'LOGIN *** rejected' });
    box.failConnect = null;
    expect(await checkMailbox(fakeConnect(box), { ...settings, password: 'x' }, 'INBOX')).toMatchObject({ ok: false, kind: 'auth' });
    expect(await checkMailbox(fakeConnect(box), settings, 'Niema')).toMatchObject({ ok: false, kind: 'folder' });
  });
});
