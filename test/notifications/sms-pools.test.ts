import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Notifier, SMS_PER_DAY } from '../../src/notifications/notifier.ts';
import { sendNotificationSms } from '../../src/notifications/sms.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';

const T0 = new Date('2026-11-05T10:00:00Z');
const FIVE = ['48601000001', '48601000002', '48601000003', '48601000004', '48601000005'];
let notifier: Notifier;
let messages: MessagesRepo;
let notifications: NotificationsRepo;
let apiKeyId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const masterKey = randomBytes(32);
  const accounts = new AccountsRepo(db, masterKey);
  const accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent: 1, serviceIds: ['24138'],
  });
  const apiKeys = new ApiKeysRepo(db, masterKey);
  apiKeyId = apiKeys.insert({
    accountId, name: 'Dyżur IT', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  messages = new MessagesRepo(db);
  const jobs = new JobsRepo(db);
  notifications = new NotificationsRepo(db, masterKey);
  notifications.saveSmsSettings({ enabled: true, apiKeyId, orig: null, recipients: FIVE }, T0);
  const deps = { accounts, apiKeys, messages, events: new MessageEventsRepo(db), jobs, inbound: new InboundMessagesRepo(db), notifications };
  notifier = new Notifier({ notifications, jobs, sms: (text, now) => sendNotificationSms(deps, text, now) });
});

const smsCount = () => messages.list({ includeSystem: true, limit: 1000, offset: 0 }).length;

describe('dobowe pule SMS-ów powiadomień liczą SMS-y, a nie powiadomienia', () => {
  it(`pula reguł: przy pięciu numerach mieszczą się dwa powiadomienia, czyli ${SMS_PER_DAY.rules} SMS-ów`, () => {
    notifications.saveRule('integration_error', { enabled: 1, maxPerHour: 100, groupHours: 0, params: {}, sms: 1 });
    for (let n = 1; n <= 20; n += 1) notifier.notify('integration_error', `integration:${n}`, `błąd ${n}`, T0);
    notifier.flushSms(T0);
    expect(smsCount()).toBe(SMS_PER_DAY.rules);
    expect(notifications.smsCountSince(null, new Date(0))).toBe(SMS_PER_DAY.rules);
  });

  it(`pula alarmowa: przy pięciu numerach mieści się jedno powiadomienie, czyli ${SMS_PER_DAY.alarm} SMS-ów`, () => {
    for (let n = 1; n <= 10; n += 1) notifier.notify('m365_disconnected', `m365:${n}`, `konto ${n}`, T0, `m365:${n}:x`);
    notifier.flushSms(T0);
    expect(smsCount()).toBe(SMS_PER_DAY.alarm);
  });

  it('powiadomienie, które nie mieści się w reszcie puli, nie trafia do części numerów', () => {
    notifications.saveSmsSettings({ enabled: true, apiKeyId, orig: null, recipients: FIVE.slice(0, 3) }, T0);
    notifications.saveRule('integration_error', { enabled: 1, maxPerHour: 100, groupHours: 0, params: {}, sms: 1 });
    for (let n = 1; n <= 5; n += 1) notifier.notify('integration_error', `integration:${n}`, `błąd ${n}`, T0);
    notifier.flushSms(T0);
    // 3 + 3 + 3 = 9; czwarte powiadomienie wymagałoby 12 SMS-ów, a pula wynosi 10.
    expect(smsCount()).toBe(9);
  });

  it('limit reguły na godzinę liczy powiadomienia, dlatego reguła z limitem 1 wysyła jedno powiadomienie na wszystkie numery', () => {
    notifications.saveRule('integration_error', { enabled: 1, maxPerHour: 1, groupHours: 0, params: {}, sms: 1 });
    notifier.notify('integration_error', 'integration:1', 'błąd 1', T0);
    notifier.notify('integration_error', 'integration:2', 'błąd 2', T0);
    notifier.flushSms(T0);
    expect(smsCount()).toBe(5);
  });
});
