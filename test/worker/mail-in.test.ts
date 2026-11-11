import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIL_IN_PASSWORD_REF, defaultMailInConfig, type MailInConfig } from '../../src/integrations/config.ts';
import { MailboxError } from '../../src/integrations/mail/client.ts';
import { M365AuthError, M365_IMAP } from '../../src/m365/oauth.ts';
import { M365AccountsRepo } from '../../src/store/m365-accounts.ts';
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
import { REPORT_FIRST_DELAY_MS } from '../../src/worker/mail-report.ts';
import { FakeMailbox, fakeConnect } from '../helpers/fake-mailbox.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-10-21T10:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const PASSWORD = 'TajneHaslo9';
let deps: MailInDeps;
let db: ReturnType<typeof openDatabase>;
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
const pendingJobs = () => (db.prepare('SELECT type, payload, run_at FROM jobs ORDER BY id').all() as Array<{ type: string; payload: string; run_at: string }>)
  .map((j) => ({ type: j.type, payload: JSON.parse(j.payload) as Record<string, unknown>, runAt: j.run_at }));

beforeEach(() => {
  seq = 0;
  db = openDatabase(':memory:');
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
    box.add({ uid: 1, seen: false, source: eml('jan@przyklad.test', 'Stare', 'x', '<1@x>') });
    await poller.tick(NOW);
    expect(mailIn.state(integ.id)).toMatchObject({ uidFloor: 1, uidvalidity: 7, unseen: 1, error: null, lastOkAt: NOW.toISOString(), nextPollAt: at(60_000).toISOString() });
    expect(smsCount()).toBe(0);
    expect(box.calls).not.toContain('source:1');
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Nowe', 'y', '<2@x>') });
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
    box.add({ uid: 1, seen: false, source: eml('jan@przyklad.test', 'Stare', 'x', '<1@x>') });
    mailIn.ensureState(integ.id, NOW);
    mailIn.setBacklog(integ.id, 1);
    await poller.tick(NOW);
    expect(smsCount()).toBe(1);
    expect(mailIn.state(integ.id)).toMatchObject({ backlog: 0, uidFloor: 1, uidvalidity: 7 });
  });

  it('nie wysyła drugi raz: po ponownym oznaczeniu jako nieprzeczytany, po restarcie w połowie ani po zmianie UIDVALIDITY z tym samym Message-ID', async () => {
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Nowe', 'y', '<2@x>') });
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
    expect(events(integ.id)[0]).toEqual(['skipped', 'wiadomość już przetworzona · temat „Nowe”']);
    expect(box.messages('INBOX').find((m) => m.uid === 2)?.seen).toBe(false);
    // Odtworzenie folderu u dostawcy: nowa UIDVALIDITY unieważnia UID-y, próg od nowa, Message-ID dalej chroni.
    box.resetUidValidity(8);
    await poller.tick(at(240_000));
    expect(mailIn.state(integ.id)).toMatchObject({ uidvalidity: 8, uidFloor: box.uidNext - 1 });
    box.add({ uid: 9, seen: false, source: eml('jan@przyklad.test', 'Nowe', 'y', '<2@x>') });
    await poller.tick(at(300_000));
    expect(smsCount()).toBe(1);
    expect(events(integ.id)[0]).toEqual(['skipped', 'wiadomość już przetworzona · temat „Nowe”']);
  });

  it('nadawca spoza listy nie zatruwa deduplikacji: późniejszy mail z listy z tym samym Message-ID idzie normalnie', async () => {
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('obcy@inna.test', 'Podszycie', 'x', '<ups-17@ups.local>') });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(0);
    expect(events(integ.id)[0]![0]).toBe('skipped');
    box.add({ uid: 3, seen: false, source: eml('ups@przyklad.test', 'Alarm', 'ON BATTERY', '<ups-17@ups.local>') });
    await poller.tick(at(120_000));
    expect(smsCount()).toBe(1);
    expect(events(integ.id)[0]![0]).toBe('sent');
  });

  it('podrobiony From z listy bez SPF/DKIM też nie zatruwa deduplikacji po Message-ID', async () => {
    integrations.setEnabled(integ.id, false, NOW);
    integ = make({ requireAuthResults: true });
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('ups@przyklad.test', 'Podszycie', 'x', '<ups-18@ups.local>') });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(0);
    expect(events(integ.id)[0]).toEqual(['skipped', 'brak potwierdzenia SPF/DKIM od serwera · temat „Podszycie”']);
    const auth = 'Authentication-Results: mx.przyklad.test; dkim=pass header.d=przyklad.test\r\n';
    box.add({ uid: 3, seen: false, source: eml('ups@przyklad.test', 'Alarm', 'ON BATTERY', '<ups-18@ups.local>').replace('From:', `${auth}From:`) });
    await poller.tick(at(120_000));
    expect(smsCount()).toBe(1);
    expect(events(integ.id)[0]![0]).toBe('sent');
  });

  it('za duży mail jest pomijany bez pobierania treści, ale podlega działaniu po przetworzeniu', async () => {
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Duży', 'x', '<2@x>'), size: MAX_MAIL_BYTES + 1 });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(0);
    expect(events(integ.id)[0]).toEqual(['skipped', 'wiadomość zbyt duża (2.0 MB) · temat „Duży”']);
    expect(box.calls).not.toContain('source:2');
    expect(box.messages('INBOX').find((m) => m.uid === 2)?.seen).toBe(true);
  });

  it('bierze najwyżej 50 maili na odpytanie, od najstarszego; reszta czeka', async () => {
    await poller.tick(NOW);
    for (let uid = 2; uid <= 62; uid += 1) box.add({ uid, seen: false, source: eml('jan@przyklad.test', `M${uid}`, 'x', `<${uid}@x>`) });
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
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'A', 'x', '<2@x>') });
    box.add({ uid: 3, seen: false, source: eml('obcy@inna.pl', 'B', 'x', '<3@x>') });
    await poller.tick(at(60_000));
    expect(box.messages('Przetworzone').map((m) => [m.uid, m.seen])).toEqual([[2, true], [3, true]]);
    expect(box.messages('INBOX')).toHaveLength(0);
    expect(events(move.id).map((e) => e[0])).toEqual(['skipped', 'sent']);
    only(del.id);
    box.add({ uid: 4, seen: false, source: eml('jan@przyklad.test', 'C', 'x', '<4@x>') });
    await poller.tick(at(120_000));
    expect(box.messages('INBOX')).toHaveLength(0);
    expect(events(del.id)[0]![0]).toBe('sent');
    only(integ.id);
    box.add({ uid: 5, seen: false, source: eml('jan@przyklad.test', 'D', 'x', '<5@x>') });
    await poller.tick(at(180_000));
    expect(box.messages('INBOX').map((m) => [m.uid, m.seen])).toEqual([[5, true]]);
    expect(smsCount()).toBe(3);
  });

  it('MOVE odrzucone przez serwer: SMS poszedł, wpis sent, stan folder, następny mail dalej przetwarzany', async () => {
    const move = make({ after: { action: 'move', folder: 'Archiwum' } });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    box.rejectMove = true;
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'A', 'x', '<2@x>') });
    box.add({ uid: 3, seen: false, source: eml('jan@przyklad.test', 'B', 'x', '<3@x>') });
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
    expect(notified).toEqual([{ event: 'mailbox_failure', subjectKey: `mailbox:${integ.id}`, summary: `Skrzynka Skrzynka 1: logowanie odrzucone od 12:00 (LOGIN failed: Authentication failed.)`, dedupKey: `mailbox:${integ.id}:${NOW.toISOString()}` }]);
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
    expect(notified[0]!.summary).toBe(`Skrzynka Skrzynka 1: serwer nie odpowiada od 12:00 (serwer odrzucił połączenie na tym porcie (ECONNREFUSED))`);
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

  it('odpytanie, które wisi dłużej niż limit, kończy się błędem sieci; spóźniona sesja jest zamykana bez pracy', async () => {
    vi.useFakeTimers({ now: NOW });
    box.delayMs = 120_000;
    const t = poller.tick(NOW);
    await vi.advanceTimersByTimeAsync(61_000);
    await t;
    expect(mailIn.state(integ.id)).toMatchObject({ errorKind: 'network' });
    expect(mailIn.state(integ.id)?.error).toContain('60 s');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(box.calls).toContain('close');
    expect(box.calls).not.toContain('open:INBOX');
  });

  it('odpytanie przerwane w połowie kończy bieżący mail, zostawia resztę na następny raz i nie zgłasza „już przetworzony”', async () => {
    vi.useFakeTimers({ now: NOW });
    await poller.tick(NOW);
    for (const uid of [2, 3, 4, 5]) box.add({ uid, seen: false, source: eml('jan@przyklad.test', `M${uid}`, 'x', `<${uid}@x>`) });
    box.delaySourceMs = 25_000;
    const t = poller.tick(at(60_000));
    await vi.advanceTimersByTimeAsync(130_000);
    await t;
    expect(smsCount()).toBe(3);
    expect(mailIn.state(integ.id)).toMatchObject({ errorKind: 'network', uidFloor: 4 });
    box.delaySourceMs = 0;
    const t2 = poller.tick(at(1_000_000));
    await vi.advanceTimersByTimeAsync(1_000);
    await t2;
    expect(smsCount()).toBe(4);
    expect(events(integ.id).filter((e) => e[1]?.startsWith('wiadomość już przetworzona'))).toEqual([]);
  });
});

describe('MailInPoller: powiadomienia i odpowiedzi', () => {
  it('pominięty nieprawidłowy numer z maila daje powiadomienie integration_error, SMS idzie do pozostałych', async () => {
    const num = make({ recipientsFromMail: { enabled: true, where: 'subject' } });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', '48601000001, 4860100000: Awaria', 'x', '<2@x>') });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(1);
    expect(notified.map((n) => [n.event, n.summary])).toEqual([['integration_error', `${num.name}: pominięto 1 nieprawidłowy numer: 4860100000`]]);
  });

  it('nieczytelny mail dostaje wpis błąd i działanie po przetworzeniu, a reszta partii idzie dalej', async () => {
    await poller.tick(NOW);
    for (const uid of [2, 3, 4]) box.add({ uid, seen: false, source: eml('jan@przyklad.test', `M${uid}`, 'x', `<${uid}@x>`) });
    box.failSource.set(3, new Error('boom'));
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(2);
    expect(events(integ.id)).toContainEqual(['error', 'nieczytelna wiadomość: boom']);
    expect(mailIn.outcomes(integ.id).find((o) => o.uid === 3)?.outcome).toBe('failed');
    expect(box.calls).toContain('markSeen:3');
    expect(mailIn.state(integ.id)).toMatchObject({ errorKind: null, uidFloor: 4 });
    await poller.tick(at(120_000));
    expect(events(integ.id).filter((e) => e[1]?.startsWith('wiadomość już przetworzona'))).toEqual([]);
  });

  it('nieczytelny mail nie zajmuje cudzego Message-ID: późniejszy czytelny mail z listy z tym samym identyfikatorem idzie normalnie', async () => {
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('obcy@inna.test', 'Zepsuty', 'x', '<ups-19@ups.local>') });
    box.failSource.set(2, new Error('boom'));
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(0);
    box.add({ uid: 3, seen: false, source: eml('ups@przyklad.test', 'Alarm', 'ON BATTERY', '<ups-19@ups.local>') });
    await poller.tick(at(120_000));
    expect(smsCount()).toBe(1);
    expect(events(integ.id)[0]![0]).toBe('sent');
  });

  it('wyjątek po sprawdzeniu nadawcy (np. powiadomienie) zostawia Message-ID, więc ponowna dostawa tego maila jest już przetworzona', async () => {
    const bez = make({ to: { fallback: [] } });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    deps.notifier = { notify: () => { throw new Error('smtp down'); } };
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Bez numeru', 'x', '<bn@x>') });
    await poller.tick(at(60_000));
    expect(mailIn.outcomes(bez.id).find((o) => o.uid === 2)?.outcome).toBe('failed');
    deps.notifier = { notify: () => undefined };
    box.add({ uid: 3, seen: false, source: eml('jan@przyklad.test', 'Bez numeru', 'x', '<bn@x>') });
    await poller.tick(at(120_000));
    expect(events(bez.id)[0]).toEqual(['skipped', 'wiadomość już przetworzona · temat „Bez numeru”']);
  });

  it('kolejne odpytania w jednym torze dostają bieżący czas, nie czas początku tury', async () => {
    vi.useFakeTimers({ now: NOW });
    const p = new MailInPoller(deps, { concurrency: 1 });
    const b = make();
    const c = make();
    box.delayMs = 10_000;
    const t = p.tick(NOW);
    await vi.advanceTimersByTimeAsync(35_000);
    await t;
    expect([integ, b, c].map((i) => mailIn.state(i.id)!.lastPollAt)).toEqual([NOW.toISOString(), at(10_000).toISOString(), at(20_000).toISOString()]);
  });

  it('limit pięciu skrzynek naraz obowiązuje między turami, nie tylko w jednej', async () => {
    vi.useFakeTimers({ now: NOW });
    const p = new MailInPoller(deps, { concurrency: 2 });
    make(); make(); make();
    box.delayMs = 10_000;
    const connects = () => box.calls.filter((c) => c === 'connect').length;
    const t1 = p.tick(NOW);
    await vi.advanceTimersByTimeAsync(1_000);
    const t2 = p.tick(at(1_000));
    await vi.advanceTimersByTimeAsync(1_000);
    // Druga tura nie dokłada połączeń ponad limit, dopóki trwają dwa z pierwszej.
    expect(connects()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connects()).toBe(4);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([t1, t2]);
    expect(connects()).toBe(4);
  });

  it('błąd potoku daje integration_error, burza integration_throttled raz na okno', async () => {
    const pusta = make({ to: { fallback: [] }, throttle: { limit: 1, windowMinutes: 10 } });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'A', 'x', '<2@x>') });
    box.add({ uid: 3, seen: false, source: eml('jan@przyklad.test', 'B', 'x', '<3@x>') });
    box.add({ uid: 4, seen: false, source: eml('jan@przyklad.test', 'C', 'x', '<4@x>') });
    await poller.tick(at(60_000));
    expect(notified.map((n) => [n.event, n.subjectKey])).toEqual([
      ['integration_error', `integration:${pusta.id}`], ['integration_throttled', `integration:${pusta.id}`],
    ]);
    expect(notified[0]!.summary).toContain('Skrzynka 2: ');
  });

  it('odpowiedź do nadawcy: raport minutę po wysyłce przy sent, mail od ręki przy error; brak przy sender_not_allowed, condition i bez SMTP', async () => {
    const odp = make({ reply: { enabled: true }, condition: { mode: 'builder', rules: [{ path: 'subject', op: 'ne', value: 'cicho' }] } });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'A', 'x', '<2@x>') });
    await poller.tick(at(60_000));
    expect(mails()).toEqual([]);
    notifications.saveSmtp({ host: 'smtp.przyklad.test', port: 465, security: 'tls', user: null, password: null, fromAddress: 'g@przyklad.test', fromName: 'G', recipients: ['admin@przyklad.test'], instanceName: 'mi', panelUrl: null }, NOW);
    box.add({ uid: 3, seen: false, source: eml('jan@przyklad.test', 'B', 'y', '<3@x>') });
    box.add({ uid: 4, seen: false, source: eml('obcy@inna.pl', 'C', 'y', '<4@x>') });
    box.add({ uid: 5, seen: false, source: eml('jan@przyklad.test', 'cicho', 'y', '<5@x>') });
    box.add({ uid: 6, seen: false, source: eml('jan@przyklad.test', 'D', 'x'.repeat(500), '<6@x>') });
    integrations.update(odp.id, { ...odp, config: { ...odp.config, overflow: 'reject' } } as never, at(120_000));
    await poller.tick(at(120_000));
    const sent = mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ subject: 'Re: D', text: 'SMS nie został wysłany: treść wymaga więcej niż 1 części.', to: ['jan@przyklad.test'], inReplyTo: '<6@x>' });
    const reports = pendingJobs().filter((j) => j.type === 'mail.report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.payload).toEqual({
      stage: 'first', integrationId: odp.id, to: ['jan@przyklad.test'], subject: 'B', inReplyTo: '<3@x>', references: '<3@x>',
      messageIds: [expect.stringMatching(/^msg_/)], recipients: ['48601000009'], invalid: [], text: 'B\ny', parts: 1, sentAt: at(120_000).toISOString(),
    });
    expect(reports[0]!.runAt).toBe(at(120_000 + REPORT_FIRST_DELAY_MS).toISOString());
  });

  it('mail automatyczny (Auto-Submitted) z udaną wysyłką nie dostaje raportu ani odpowiedzi', async () => {
    const odp = make({ reply: { enabled: true } });
    integrations.setEnabled(integ.id, false, NOW);
    notifications.saveSmtp({ host: 'smtp.przyklad.test', port: 465, security: 'tls', user: null, password: null, fromAddress: 'g@przyklad.test', fromName: 'G', recipients: ['admin@przyklad.test'], instanceName: 'mi', panelUrl: null }, NOW);
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Alarm', 'x', '<2@x>').replace('MIME-Version', 'Auto-Submitted: auto-generated\r\nMIME-Version') });
    await poller.tick(at(60_000));
    expect(deps.messages.list({ limit: 10, offset: 0 }).map((m) => m.dest)).toEqual(['48601000009']);
    expect(pendingJobs().filter((j) => j.type === 'mail' || j.type === 'mail.report')).toEqual([]);
    expect(odp.id).toBeGreaterThan(0);
  });
});

describe('MailInPoller: limit wieku maila', () => {
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
  const smtp = () => notifications.saveSmtp({ host: 'smtp.przyklad.test', port: 465, security: 'tls', user: null, password: null, fromAddress: 'g@przyklad.test', fromName: 'G', recipients: ['admin@przyklad.test'], instanceName: 'mi', panelUrl: null }, NOW);

  it('mail starszy niż limit: wpis w dzienniku, bez SMS-a, bez odpowiedzi, bez przeniesienia, mail zostaje nieprzeczytany', async () => {
    const odp = make({ maxAgeHours: 24, after: { action: 'move', folder: 'Przetworzone' }, reply: { enabled: true } });
    integrations.setEnabled(integ.id, false, NOW);
    smtp();
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Stary alarm', 'x', '<2@x>'), internalDate: hoursAgo(25) });
    // Stary i zarazem zbyt duży: limit wieku działa przed rozmiarem, więc mail nie zostaje oznaczony jako przeczytany.
    box.add({ uid: 3, seen: false, source: eml('jan@przyklad.test', 'Stary duży', 'x', '<3@x>'), internalDate: hoursAgo(30), size: MAX_MAIL_BYTES + 1 });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(0);
    expect(events(odp.id)).toEqual([['skipped', 'wiadomość starsza niż 24 h · temat „Stary duży”'], ['skipped', 'wiadomość starsza niż 24 h · temat „Stary alarm”']]);
    // Nadawca w kolumnie „Nadawca” dziennika, jak przy mailach przetworzonych: administrator wie, który alarm pominięto.
    expect(deps.integrationEvents.list(odp.id, 10).map((e) => e.sourceIp)).toEqual(['jan@przyklad.test', 'jan@przyklad.test']);
    expect(box.messages('INBOX').filter((m) => !m.seen).map((m) => m.uid)).toEqual([2, 3]);
    expect(box.messages('Przetworzone')).toEqual([]);
    expect(box.calls.filter((c) => /^(source|markSeen|move|remove):/.test(c))).toEqual([]);
    expect(pendingJobs().filter((j) => j.type === 'mail' || j.type === 'mail.report')).toEqual([]);
    expect(notified).toEqual([]);
    expect(mailIn.outcomes(odp.id)).toEqual([{ uid: 2, outcome: 'skipped' }, { uid: 3, outcome: 'skipped' }]);
    expect(mailIn.state(odp.id)).toMatchObject({ uidFloor: 3, error: null });
    // Następne odpytanie nie wraca do pominiętych maili.
    await poller.tick(at(120_000));
    expect(events(odp.id)).toHaveLength(2);
  });

  it('mail sprzed 23 h przy limicie 24 h zostaje wysłany', async () => {
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Alarm', 'x', '<2@x>'), internalDate: hoursAgo(23) });
    await poller.tick(at(60_000));
    expect(integ.config.maxAgeHours).toBe(24);
    expect(smsCount()).toBe(1);
  });

  it('limit 1 h: mail sprzed 61 minut pominięty, sprzed 59 minut wysłany', async () => {
    const odp = make({ maxAgeHours: 1 });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    // Wiek liczony od chwili odpytania, a nie od pierwszego odpytania.
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Stary', 'x', '<2@x>'), internalDate: at(60_000 - 61 * 60_000) });
    box.add({ uid: 3, seen: false, source: eml('jan@przyklad.test', 'Świeży', 'y', '<3@x>'), internalDate: at(60_000 - 59 * 60_000) });
    await poller.tick(at(60_000));
    expect(deps.messages.list({ limit: 10, offset: 0 }).map((m) => m.body)).toEqual(['Świeży\ny']);
    expect(events(odp.id)).toContainEqual(['skipped', 'wiadomość starsza niż 1 h · temat „Stary”']);
  });

  it('stary mail bez tematu i bez nadawcy: wpis „temat (bez tematu)”, kolumna nadawcy pusta', async () => {
    const odp = make({ maxAgeHours: 1 });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: 'To: bramka@przyklad.test\r\nMessage-ID: <2@x>\r\n\r\nx\r\n', internalDate: hoursAgo(3) });
    await poller.tick(at(60_000));
    expect(events(odp.id)).toEqual([['skipped', 'wiadomość starsza niż 1 h · temat (bez tematu)']]);
    expect(deps.integrationEvents.list(odp.id, 10)[0]!.sourceIp).toBeNull();
  });

  it('integracja zapisana przed 1.10 (bez pola limitu) przetwarza mail sprzed 3 dni', async () => {
    db.prepare("UPDATE integrations SET config = json_remove(config, '$.maxAgeHours') WHERE id = ?").run(integ.id);
    expect((integrations.get(integ.id) as MailInIntegration).config.maxAgeHours).toBeNull();
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Alarm', 'x', '<2@x>'), internalDate: hoursAgo(72) });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(1);
  });

  it('mail bez daty przyjęcia przy limicie 1 h jest przetwarzany normalnie, nigdy nie znika po cichu', async () => {
    const odp = make({ maxAgeHours: 1 });
    integrations.setEnabled(integ.id, false, NOW);
    await poller.tick(NOW);
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Alarm', 'x', '<2@x>'), internalDate: null });
    await poller.tick(at(60_000));
    expect(smsCount()).toBe(1);
    expect(mailIn.outcomes(odp.id)).toEqual([{ uid: 2, outcome: 'sent' }]);
  });

  it('jednorazowe przetworzenie zaległych też podlega limitowi', async () => {
    box.add({ uid: 1, seen: false, source: eml('jan@przyklad.test', 'Stary', 'x', '<1@x>'), internalDate: hoursAgo(30) });
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'Świeży', 'y', '<2@x>'), internalDate: hoursAgo(2) });
    mailIn.ensureState(integ.id, NOW);
    mailIn.setBacklog(integ.id, 1);
    await poller.tick(NOW);
    expect(deps.messages.list({ limit: 10, offset: 0 }).map((m) => m.body)).toEqual(['Świeży\ny']);
    expect(events(integ.id)).toContainEqual(['skipped', 'wiadomość starsza niż 24 h · temat „Stary”']);
    expect(box.messages('INBOX').find((m) => m.uid === 1)?.seen).toBe(false);
    expect(mailIn.state(integ.id)).toMatchObject({ backlog: 0, uidFloor: 2 });
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
    box.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'A', 'x', '<2@x>') });
    box2.add({ uid: 2, seen: false, source: eml('jan@przyklad.test', 'B', 'y', '<b2@x>') });
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

  it('treść odpowiedzi o błędzie; wysyłka udana nie dostaje odpowiedzi od ręki, tylko raport', () => {
    const m = { from: 'a@x', fromName: '', subject: 'Awaria', textFull: '', date: '', to: [], messageId: '<1@x>', authResults: [], exchangeAuthAs: null, auto: false } satisfies ParsedMail;
    const c = { ...defaultMailInConfig(), maxParts: 3, throttle: { limit: 10, windowMinutes: 10 } };
    const sent = { kind: 'sent', messageIds: ['a'], recipients: ['48601000200'], invalid: [], parts: 1, text: 'x' } as const;
    expect(replyFor(sent, m, c)).toBeNull();
    expect(replyFor({ kind: 'error', code: 'too_many_parts', detail: 'x' }, { ...m, subject: '' }, c)?.subject).toBe('Re: (bez tematu)');
    expect(replyFor({ kind: 'error', code: 'too_many_parts', detail: 'x' }, m, c))
      .toEqual({ subject: 'Re: Awaria', text: 'SMS nie został wysłany: treść wymaga więcej niż 3 części.', to: ['a@x'], inReplyTo: '<1@x>', references: '<1@x>', autoReply: true });
    expect(replyFor({ kind: 'error', code: 'no_recipient', detail: 'x' }, m, c)?.text).toBe('SMS nie został wysłany: nie udało się ustalić odbiorcy.');
    expect(replyFor({ kind: 'error', code: 'empty_text', detail: 'x' }, m, c)?.text).toBe('SMS nie został wysłany: treść maila po usunięciu podpisu i cytatów jest pusta.');
    expect(replyFor({ kind: 'error', code: 'invalid_phone', detail: 'Wszystkie numery są złe: 1.' }, m, c)?.text).toBe('SMS nie został wysłany: Wszystkie numery są złe: 1.');
    expect(replyFor({ kind: 'throttled', notify: false }, m, c)?.text).toBe('SMS nie został wysłany: przekroczono limit integracji (10 w 10 min).');
    // Wynik `unavailable` powstaje przed sprawdzeniem nadawcy, więc odpowiedź poszłaby także do obcego.
    expect(replyFor({ kind: 'unavailable', detail: 'x' }, m, c)).toBeNull();
    // Mail automatyczny (autoresponder, urządzenie, lista) nie dostaje odpowiedzi: inaczej pętla odpowiedzi.
    expect(replyFor({ kind: 'error', code: 'no_recipient', detail: 'x' }, { ...m, auto: true }, c)).toBeNull();
    expect(replyFor({ kind: 'skipped', reason: 'condition' }, m, c)).toBeNull();
    expect(replyFor({ kind: 'skipped', reason: 'sender_not_allowed' }, m, c)).toBeNull();
    expect(replyFor({ kind: 'error', code: 'no_recipient', detail: 'x' }, { ...m, subject: 'Re: Awaria', messageId: null }, c))
      .toEqual({ subject: 'Re: Awaria', text: 'SMS nie został wysłany: nie udało się ustalić odbiorcy.', to: ['a@x'], autoReply: true });
  });

  it('checkMailbox podaje authserv-id z ostatniej wiadomości, a null bez nagłówka', async () => {
    const settings = { host: 'h', port: 993, security: 'tls' as const, verifyCert: true, user: 'u', auth: { kind: 'password' as const, password: PASSWORD } };
    box.authservId = 'mx.google.com';
    expect(await checkMailbox(fakeConnect(box), settings, 'INBOX')).toMatchObject({ ok: true, authservId: 'mx.google.com' });
    box.authservId = null;
    expect(await checkMailbox(fakeConnect(box), settings, 'INBOX')).toMatchObject({ ok: true, authservId: null });
  });
  it('checkMailbox z sesją bez metody authservId (starsza atrapa) daje null', async () => {
    const connect: typeof fakeConnect = (b) => async (s) => { const session = await fakeConnect(b)(s, 1000); const { authservId: _x, ...rest } = session; return rest as typeof session; };
    expect(await checkMailbox(connect(box), { host: 'h', port: 993, security: 'tls', verifyCert: true, user: 'u', auth: { kind: 'password' as const, password: PASSWORD } }, 'INBOX')).toMatchObject({ ok: true, authservId: null });
  });
  it('checkMailbox: sukces z liczbą nieprzeczytanych i folderami; błąd logowania bez hasła w treści', async () => {
    box.add({ uid: 1, seen: false, source: 'Subject: a\r\n\r\nx' });
    const settings = { host: 'h', port: 993, security: 'tls' as const, verifyCert: true, user: 'u', auth: { kind: 'password' as const, password: PASSWORD } };
    expect(await checkMailbox(fakeConnect(box), settings, 'INBOX')).toEqual({ ok: true, unseen: 1, folders: ['INBOX'], authservId: null });
    expect(box.calls).toContain('close');
    box.failConnect = new Error(`LOGIN ${PASSWORD} rejected`);
    expect(await checkMailbox(fakeConnect(box), settings, 'INBOX')).toEqual({ ok: false, kind: 'other', error: 'LOGIN *** rejected', folders: [] });
    box.failConnect = null;
    expect(await checkMailbox(fakeConnect(box), { ...settings, auth: { kind: 'password' as const, password: 'x' } }, 'INBOX')).toMatchObject({ ok: false, kind: 'auth' });
    expect(await checkMailbox(fakeConnect(box), settings, 'Niema')).toMatchObject({ ok: false, kind: 'folder' });
  });
});

describe('MailInPoller: skrzynka Microsoft 365', () => {
  let m365: M365AccountsRepo;
  let tokenCalls: number;
  let tokenError: Error | null;
  let p: MailInPoller;

  beforeEach(() => {
    m365 = new M365AccountsRepo(db, randomBytes(32));
    tokenCalls = 0;
    tokenError = null;
    const tokens = { access: async () => { tokenCalls += 1; if (tokenError) throw tokenError; return { token: 'token-dostepu-1', address: 'alarmy@firma.pl' }; } };
    p = new MailInPoller({ ...deps, m365: { tokens, accounts: m365 } });
  });

  const account = (state: 'new' | 'connected' | 'needs_login'): number => {
    const id = m365.create({ name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, NOW);
    if (state === 'new') return id;
    m365.connected(id, {
      refreshToken: 'r', address: 'alarmy@firma.pl', addressManual: false, loginName: 'alarmy@firma.pl', loginOid: null,
      redirectUri: 'http://localhost:8081/m365/powrot', by: 'admin',
    }, NOW);
    if (state === 'needs_login') m365.failed(id, { state: 'needs_login', code: '50173', message: 'x' }, NOW);
    return id;
  };
  const mailbox = (accountId: number) => make({
    imap: { ...M365_IMAP, user: 'alarmy@firma.pl', passRef: MAIL_IN_PASSWORD_REF, auth: { mode: 'm365', accountId } },
  }, { password: '' });

  for (const [label, prepare] of [
    ['wymagające logowania', () => account('needs_login')],
    ['nowe, bez logowania', () => account('new')],
    ['usunięte', () => 999],
  ] as const) {
    it(`konto ${label}: bez połączenia, stan account, następne odpytanie po interwale, bez mailbox_failure`, async () => {
      const row = mailbox(prepare());
      await p.poll(row, NOW);
      await p.poll(row, at(60_000));
      const state = mailIn.state(row.id)!;
      expect(state).toMatchObject({ errorKind: 'account', error: 'Konto Microsoft 365 wymaga logowania', failures: 2 });
      expect(Date.parse(state.nextPollAt) - at(60_000).getTime()).toBe(60_000);
      expect(box.calls).not.toContain('connect');
      expect(tokenCalls).toBe(0);
      expect(notified).toEqual([]);
      // Po czasie, po którym reguła mailbox_failure zgłasza awarię sieci, konto nadal nie daje powiadomienia skrzynki.
      await p.poll(row, at(20 * 60_000));
      expect(notified).toEqual([]);
    });
  }

  it('konto połączone: logowanie XOAUTH2 tokenem dostępu na adres skrzynki, stan bez błędu', async () => {
    const row = mailbox(account('connected'));
    await p.poll(row, NOW);
    expect(box.lastAuth).toEqual({ kind: 'oauth2', accessToken: box.accessToken });
    expect(box.lastUser).toBe('alarmy@firma.pl');
    expect(mailIn.state(row.id)).toMatchObject({ errorKind: null, error: null });
  });

  it('serwer odrzuca token przy sprawnym koncie: błąd auth z podpowiedzią, konto zostaje połączone', async () => {
    const id = account('connected');
    const row = mailbox(id);
    box.accessToken = 'inny-token';
    await p.poll(row, NOW);
    const state = mailIn.state(row.id)!;
    expect(state.errorKind).toBe('auth');
    expect(state.error).toContain('Najczęstszą przyczyną jest literówka w adresie skrzynki, wyłączony IMAP na koncie albo brak dostępu konta do skrzynki współdzielonej. Odpowiedź serwera: AUTHENTICATE failed.');
    expect(m365.get(id)!.state).toBe('connected');
  });

  // Exchange odrzuca czasem pojedyncze logowanie przy sprawnym koncie („Command Argument Error. 11”, 2026-11-10).
  it('pojedyncze odrzucenie logowania przy sprawnym koncie nie wywołuje powiadomienia', async () => {
    const row = mailbox(account('connected'));
    const token = box.accessToken;
    box.accessToken = 'inny-token';
    await p.poll(row, NOW);
    box.accessToken = token;
    await p.poll(row, at(5 * 60_000));
    expect(mailIn.state(row.id)).toMatchObject({ errorKind: null, error: null });
    expect(notified).toEqual([]);
  });

  it('dwa odrzucenia logowania z rzędu wywołują jedno powiadomienie', async () => {
    const row = mailbox(account('connected'));
    box.accessToken = 'inny-token';
    await p.poll(row, NOW);
    expect(notified).toEqual([]);
    await p.poll(row, at(5 * 60_000));
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ event: 'mailbox_failure', subjectKey: `mailbox:${row.id}` });
    expect(notified[0]!.summary).toContain('logowanie odrzucone od 12:00');
    await p.poll(row, at(10 * 60_000));
    expect(notified).toHaveLength(1);
  });

  it('skrzynka sprawdzana co godzinę potwierdza odrzucenie logowania po 5 minutach i wtedy zgłasza awarię', async () => {
    const row = make({
      imap: { ...M365_IMAP, user: 'alarmy@firma.pl', passRef: MAIL_IN_PASSWORD_REF, auth: { mode: 'm365', accountId: account('connected') } },
      intervalSec: 3600,
    }, { password: '' });
    box.accessToken = 'inny-token';
    await p.poll(row, NOW);
    expect(Date.parse(mailIn.state(row.id)!.nextPollAt) - NOW.getTime()).toBe(AUTH_RETRY_MS);
    expect(notified).toEqual([]);
    await p.poll(row, at(AUTH_RETRY_MS));
    expect(notified).toHaveLength(1);
    // Po potwierdzeniu awarii skrzynka wraca do ustawionej częstotliwości.
    expect(Date.parse(mailIn.state(row.id)!.nextPollAt) - at(AUTH_RETRY_MS).getTime()).toBe(3_600_000);
  });

  it('błąd sieci, a po nim jedno odrzucenie logowania nie wywołują powiadomienia', async () => {
    const row = mailbox(account('connected'));
    box.failConnect = Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:993'), { code: 'ECONNREFUSED' });
    await p.poll(row, NOW);
    box.failConnect = null;
    box.accessToken = 'inny-token';
    await p.poll(row, at(60_000));
    expect(mailIn.state(row.id)).toMatchObject({ errorKind: 'auth', failures: 2 });
    expect(notified).toEqual([]);
  });

  it('odrzucenie logowania po stanie konta wymagającego logowania nie wywołuje powiadomienia', async () => {
    const row = mailbox(account('connected'));
    tokenError = new M365AuthError('needs_login', '50173', 'Konto Microsoft 365 wymaga logowania');
    await p.poll(row, NOW);
    tokenError = null;
    box.accessToken = 'inny-token';
    await p.poll(row, at(60_000));
    expect(mailIn.state(row.id)).toMatchObject({ errorKind: 'auth' });
    expect(notified).toEqual([]);
  });

  it('dostawca tokenów: needs_login daje stan account bez połączenia, błąd usługi daje stan network', async () => {
    const row = mailbox(account('connected'));
    tokenError = new M365AuthError('needs_login', '50173', 'Konto Microsoft 365 wymaga logowania');
    await p.poll(row, NOW);
    expect(mailIn.state(row.id)).toMatchObject({ errorKind: 'account', error: 'Konto Microsoft 365 wymaga logowania' });
    expect(notified).toEqual([]);
    tokenError = new M365AuthError('error', null, 'usługa Microsoft nie odpowiada');
    await p.poll(row, at(60_000));
    expect(mailIn.state(row.id)).toMatchObject({ errorKind: 'network', error: 'usługa Microsoft nie odpowiada' });
    expect(box.calls).not.toContain('connect');
  });

  it('komunikat błędu nie zawiera tokenu dostępu', async () => {
    const row = mailbox(account('connected'));
    box.failConnect = new Error(`AUTHENTICATE ${box.accessToken} rejected`);
    await p.poll(row, NOW);
    expect(mailIn.state(row.id)!.error).toBe('AUTHENTICATE *** rejected');
  });

  it('poller bez usług Microsoft 365 traktuje skrzynkę jak konto wymagające logowania', async () => {
    const row = mailbox(1);
    await poller.poll(row, NOW);
    expect(mailIn.state(row.id)).toMatchObject({ errorKind: 'account' });
    expect(box.calls).not.toContain('connect');
  });
});

describe('MailInPoller - serwer w sieci wewnętrznej', () => {
  it('bez MIG_MAIL_ALLOW_PRIVATE: stan „sieć” z komunikatem o zmiennej, bez połączenia', async () => {
    const p = new MailInPoller({ ...deps, resolve: async () => ['192.168.1.10'], allowPrivateMail: false });
    await p.poll(integ, NOW);
    const state = mailIn.state(integ.id)!;
    expect(state.errorKind).toBe('network');
    expect(state.error).toContain('MIG_MAIL_ALLOW_PRIVATE=1');
    expect(box.calls).not.toContain('connect');
  });
  it('ze zgodą łączy się jak dotąd', async () => {
    const p = new MailInPoller({ ...deps, resolve: async () => ['192.168.1.10'], allowPrivateMail: true });
    await p.poll(integ, NOW);
    expect(box.calls).toContain('connect');
    expect(mailIn.state(integ.id)!.errorKind).toBeNull();
  });
});
