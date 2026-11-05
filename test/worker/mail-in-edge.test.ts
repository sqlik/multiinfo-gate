// Poller Mail2SMS: przerwy, zaległości, Message-ID niesprawdzonych maili i serwer skrzynki Microsoft 365.
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAIL_IN_PASSWORD_REF, defaultMailInConfig, type MailInConfig } from '../../src/integrations/config.ts';
import type { MailboxSettings } from '../../src/integrations/mail/client.ts';
import { M365_IMAP } from '../../src/m365/oauth.ts';
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
import { M365AccountsRepo } from '../../src/store/m365-accounts.ts';
import { MailInRepo } from '../../src/store/mail-in.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';
import { MAX_MAIL_BYTES, MailInPoller, type MailInDeps } from '../../src/worker/mail-in.ts';
import { FakeMailbox, fakeConnect } from '../helpers/fake-mailbox.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-10-21T10:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const PASSWORD = 'TajneHaslo9';
let deps: MailInDeps;
let integrations: IntegrationsRepo;
let mailIn: MailInRepo;
let box: FakeMailbox;
let notified: Array<{ event: NotificationEvent; summary: string }>;
let apiKeyId: number;
let poller: MailInPoller;
let m365: M365AccountsRepo;
let seq = 0;

const eml = (from: string, subject: string, text: string, messageId: string) =>
  `From: ${from}\r\nTo: bramka@przyklad.test\r\nSubject: ${subject}\r\nDate: Wed, 21 Oct 2026 10:00:00 +0000\r\nMessage-ID: ${messageId}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;

const make = (config: Partial<MailInConfig> = {}, password = PASSWORD) => {
  seq += 1;
  const id = integrations.insert({
    name: `Skrzynka ${seq}`, kind: 'mail_in', apiKeyId, serviceId: null, orig: null, preset: 'poczta-wlasny', enabled: 1,
    config: { ...defaultMailInConfig(), imap: { ...defaultMailInConfig().imap, host: 'imap.przyklad.test', user: 'bramka@przyklad.test' }, senders: [{ pattern: '@przyklad.test', recipients: [] }], to: { fallback: ['48601000009'] }, intervalSec: 60, ...config },
    secrets: { imap_password: password }, storePayloads: 0, createdAt: NOW,
  });
  return integrations.get(id) as MailInIntegration;
};
const smsCount = () => deps.messages.list({ limit: 100, offset: 0 }).length;

const m365Account = (state: 'connected' | 'needs_login'): number => {
  const id = m365.create({ name: 'Dyżur IT', tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, NOW);
  m365.connected(id, {
    refreshToken: 'r', address: 'alarmy@firma.pl', addressManual: false, loginName: 'alarmy@firma.pl', loginOid: null,
    redirectUri: 'http://localhost:8081/m365/powrot', by: 'admin',
  }, NOW);
  if (state === 'needs_login') m365.failed(id, { state: 'needs_login', code: '50173', message: 'x' }, NOW);
  return id;
};
const tokens = { access: async () => ({ token: 'token-dostepu-1', address: 'alarmy@firma.pl' }) };

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
  m365 = new M365AccountsRepo(db, randomBytes(32));
  box = new FakeMailbox({ uidValidity: 7, password: PASSWORD });
  notified = [];
  deps = {
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
    inbound: new InboundMessagesRepo(db), integrationEvents: new IntegrationEventsRepo(db, key), guards: new IntegrationGuardsRepo(db),
    engine: new TemplateEngine(), integrations, mailIn, connect: fakeConnect(box), notifications: new NotificationsRepo(db, key),
    notifier: { notify: (event, _subjectKey, summary) => { notified.push({ event, summary }); } },
    m365: { tokens, accounts: m365 },
  };
  poller = new MailInPoller(deps);
});

describe('czekanie na konto Microsoft 365 nie przechodzi na następny błąd', () => {
  it('po ponownym logowaniu pierwsza awaria sieci liczy się od zera: bez natychmiastowego mailbox_failure i bez odstępu 15 min', async () => {
    const id = m365Account('needs_login');
    const row = make({ imap: { ...M365_IMAP, user: 'alarmy@firma.pl', passRef: MAIL_IN_PASSWORD_REF, auth: { mode: 'm365', accountId: id } } }, '');
    // Konto czeka na logowanie przez 20 minut: 20 odpytań bez połączenia.
    for (let i = 0; i < 20; i += 1) await poller.poll(row, at(i * 60_000));
    expect(mailIn.state(row.id)).toMatchObject({ errorKind: 'account', failures: 20, errorSince: NOW.toISOString() });
    // Administrator loguje konto ponownie, a pierwsze połączenie trafia na chwilową awarię sieci.
    m365.connected(id, {
      refreshToken: 'r2', address: 'alarmy@firma.pl', addressManual: false, loginName: 'alarmy@firma.pl', loginOid: null,
      redirectUri: 'http://localhost:8081/m365/powrot', by: 'admin',
    }, at(21 * 60_000));
    box.failConnect = Object.assign(new Error('connect ECONNREFUSED 192.0.2.1:993'), { code: 'ECONNREFUSED' });
    const failedAt = at(22 * 60_000);
    await poller.poll(row, failedAt);
    const state = mailIn.state(row.id)!;
    // Awaria sieci trwa od tej chwili, a nie od początku czekania na konto.
    expect(state.errorSince).toBe(failedAt.toISOString());
    // Pierwsza awaria sieci: następne odpytanie po interwale, nie po 15 minutach z licznika czekania.
    expect(Date.parse(state.nextPollAt) - failedAt.getTime()).toBe(60_000);
    // Reguła mailbox_failure zgłasza awarię sieci po 15 minutach jej trwania, a nie od razu.
    expect(notified.filter((n) => n.event === 'mailbox_failure')).toEqual([]);
  });
});

describe('Message-ID zajmuje tylko mail po sprawdzeniu nadawcy', () => {
  it('mail zbyt duży od obcego nadawcy nie wycisza późniejszego alarmu z tym samym Message-ID', async () => {
    const row = make();
    await poller.poll(row, NOW);
    box.add({ uid: 1, seen: false, source: eml('obcy@zly.test', 'Duży', 'x', '<alarm-7@ups.przyklad.test>'), size: MAX_MAIL_BYTES + 1 });
    await poller.poll(row, at(60_000));
    box.add({ uid: 2, seen: false, source: eml('ups@przyklad.test', 'Awaria zasilania', 'UPS-01 na baterii', '<alarm-7@ups.przyklad.test>') });
    await poller.poll(row, at(120_000));
    expect(smsCount()).toBe(1);
  });

  it('mail starszy niż limit od obcego nadawcy nie wycisza późniejszego alarmu z tym samym Message-ID', async () => {
    const row = make({ maxAgeHours: 1 });
    await poller.poll(row, NOW);
    box.add({ uid: 1, seen: false, source: eml('obcy@zly.test', 'Stary', 'x', '<alarm-8@ups.przyklad.test>'), internalDate: at(-3 * 3_600_000) });
    await poller.poll(row, at(60_000));
    box.add({ uid: 2, seen: false, source: eml('ups@przyklad.test', 'Awaria zasilania', 'UPS-01 na baterii', '<alarm-8@ups.przyklad.test>'), internalDate: at(110_000) });
    await poller.poll(row, at(120_000));
    expect(smsCount()).toBe(1);
  });
});

describe('zaległość po przerwie nie opóźnia świeżego alarmu', () => {
  it('120 maili starszych niż limit i jeden świeży: świeży wychodzi w pierwszym odpytaniu po przerwie', async () => {
    const row = make({ maxAgeHours: 1 });
    await poller.poll(row, NOW);
    // Przerwa (na przykład konto Microsoft 365 czekające na logowanie przez weekend): w skrzynce narosły stare alarmy.
    const back = at(48 * 3_600_000);
    for (let uid = 1; uid <= 120; uid += 1) {
      box.add({ uid, seen: false, source: eml('zabbix@przyklad.test', `Stary ${uid}`, 'x', `<stary-${uid}@x>`), internalDate: at(uid * 60_000) });
    }
    box.add({ uid: 121, seen: false, source: eml('zabbix@przyklad.test', 'Pożar serwerowni', 'Czujnik dymu S1', '<swiezy@x>'), internalDate: at(48 * 3_600_000 - 30_000) });
    await poller.poll(row, back);
    expect(deps.messages.list({ limit: 10, offset: 0 }).map((m) => m.body)).toEqual(['Pożar serwerowni\nCzujnik dymu S1']);
  });
});

describe('skrzynka Microsoft 365 łączy się wyłącznie z serwerem Microsoftu', () => {
  it('serwer, port, zabezpieczenie i sprawdzanie certyfikatu ze stałej M365_IMAP, niezależnie od zapisu w bazie', async () => {
    const id = m365Account('connected');
    const row = make({
      imap: { host: 'imap.obcy.test', port: 143, security: 'none', verifyCert: false, user: 'alarmy@firma.pl', passRef: MAIL_IN_PASSWORD_REF, auth: { mode: 'm365', accountId: id } },
    }, '');
    let used: MailboxSettings | null = null;
    const inner = fakeConnect(box);
    const p = new MailInPoller({ ...deps, connect: async (settings, timeout) => { used = settings; return inner(settings, timeout); } });
    await p.poll(row, NOW);
    expect(used).toMatchObject({ host: 'outlook.office365.com', port: 993, security: 'tls', verifyCert: true, auth: { kind: 'oauth2' } });
  });
});
