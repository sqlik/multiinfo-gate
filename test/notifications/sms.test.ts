import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sendNotificationSms, smsChannelProblem, SYSTEM_REQUESTER, type SmsSendDeps } from '../../src/notifications/sms.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo, type ApiKeyInput, type ApiKeyPatch } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';
import { linkDeps } from '../helpers/api-deps.ts';

const NOW = new Date('2026-11-04T10:00:00Z');
let deps: SmsSendDeps & { messages: MessagesRepo; jobs: JobsRepo; apiKeys: ApiKeysRepo; notifications: NotificationsRepo } & ReturnType<typeof linkDeps>;
let accountId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const masterKey = randomBytes(32);
  const accounts = new AccountsRepo(db, masterKey);
  accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent: 1, serviceIds: ['24138'], origs: ['Firma Info', 'Dyzur IT'],
  });
  deps = {
    accounts, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db), inbound: new InboundMessagesRepo(db),
    apiKeys: new ApiKeysRepo(db, masterKey), notifications: new NotificationsRepo(db, masterKey), ...linkDeps(db),
  };
});

const key = (over: Partial<ApiKeyInput> = {}): number => deps.apiKeys.insert({
  accountId, name: 'Dyżur IT', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
  webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], origs: ['Dyzur IT'], ...over,
});
const channel = (apiKeyId: number | null, over: Partial<{ recipients: string[]; orig: string | null; enabled: boolean }> = {}) =>
  deps.notifications.saveSmsSettings({ enabled: true, recipients: ['48601000001', '48601000002'], apiKeyId, orig: null, ...over }, NOW);
const sent = () => deps.messages.list({ includeSystem: true, limit: 50, offset: 0 });
const patchKey = (id: number, over: Partial<ApiKeyPatch>) => {
  const k = deps.apiKeys.get(id)!;
  deps.apiKeys.update(id, {
    name: k.name, defaultServiceId: k.defaultServiceId, defaultOrig: k.defaultOrig, maxParts: k.maxParts, ratePerMin: k.ratePerMin,
    webhookUrl: k.webhookUrl, expiresAt: k.expiresAt, serviceIds: k.allowedServiceIds, origs: k.allowedOrigs,
    inboundSubscribed: k.inboundSubscribed, integrationsOnly: k.integrationsOnly, ...over,
  });
};

describe('sendNotificationSms', () => {
  it('wysyła w imieniu klucza wiadomość systemową GSM-7 w jednej części na numery z ustawień', () => {
    const id = key();
    channel(id, { orig: 'Dyzur IT' });
    const result = sendNotificationSms(deps, 'Multiinfo Gate Biuro: SMS testowy kanału powiadomień.', NOW);
    expect(result).toEqual({ ok: true, ids: expect.any(Array) });
    const rows = sent();
    expect(rows.map((m) => m.dest).sort()).toEqual(['48601000001', '48601000002']);
    for (const m of rows) {
      expect(m).toMatchObject({ system: 1, requestedBy: SYSTEM_REQUESTER, encoding: 'gsm', parts: 1, apiKeyId: id, orig: 'Dyzur IT' });
    }
    expect(SYSTEM_REQUESTER).toBe('Powiadomienie bramki');
    expect(deps.jobs.depth()).toBe(2);
  });

  it('długą treść przycina do jednej części GSM-7 zakończonej trzema kropkami', () => {
    channel(key());
    const result = sendNotificationSms(deps, 'Zażółć gęślą jaźń. '.repeat(20), NOW);
    expect(result.ok).toBe(true);
    const [m] = sent();
    expect(m!.parts).toBe(1);
    expect(m!.body!.endsWith('...')).toBe(true);
  });

  it('adresaci podani jawnie zastępują numery z ustawień', () => {
    channel(key());
    sendNotificationSms(deps, 'Test', NOW, ['48601000009']);
    expect(sent().map((m) => m.dest)).toEqual(['48601000009']);
  });

  it('klucz „Tylko integracje” wysyła tak samo jak zwykły', () => {
    channel(key({ integrationsOnly: 1 }));
    expect(sendNotificationSms(deps, 'Test', NOW).ok).toBe(true);
  });

  it('klucz wygasły albo odwołany: brak wysyłki i powód', () => {
    channel(key({ expiresAt: '2026-11-01T00:00:00.000Z' }));
    const expired = sendNotificationSms(deps, 'Test', NOW);
    expect(expired.ok).toBe(false);
    expect(expired.ok ? '' : expired.reason).toContain('wygasł');
    const revoked = key({ name: 'Biuro handlowe', keyHash: 'argon2:bbb', keyPrefix: 'b1b2c3d4' });
    deps.apiKeys.revoke(revoked);
    channel(revoked);
    expect(sendNotificationSms(deps, 'Test', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('odwołany') });
    expect(sent()).toEqual([]);
  });

  it('brak ustawień, klucza albo numerów: brak wysyłki i powód', () => {
    expect(sendNotificationSms(deps, 'Test', NOW).ok).toBe(false);
    channel(null);
    expect(sendNotificationSms(deps, 'Test', NOW).ok).toBe(false);
    channel(key(), { recipients: [] });
    expect(sendNotificationSms(deps, 'Test', NOW).ok).toBe(false);
    expect(sent()).toEqual([]);
  });

  it('klucz ze skracaniem w trybie „Zawsze” wysyła SMS powiadomienia bez skracania linków', () => {
    const id = key();
    const domainId = deps.linkDomains.create({ domain: 'l.firma.pl', displayName: 'Firma Info', homeUrl: null, bareLinks: false }, NOW);
    deps.apiKeys.setLinkSettings(id, { mode: 'always', domainIds: [domainId], defaultDomainId: domainId, targets: ['firma.pl'], validityDays: 90, utm: true });
    channel(id);
    const text = 'Multiinfo Gate Biuro: konto wstrzymane. Panel: https://firma.pl/konta';
    expect(sendNotificationSms(deps, text, NOW).ok).toBe(true);
    for (const m of sent()) expect(m).toMatchObject({ body: text, campaignId: null });
    expect(deps.campaigns.list({ offset: 0, limit: 10 }).rows).toEqual([]);
  });

  it('odmowa wysyłki przez klucz (nadpis spoza dozwolonych) daje powód zamiast wyjątku', () => {
    channel(key(), { orig: 'Obcy' });
    const result = sendNotificationSms(deps, 'Test', NOW);
    expect(result.ok).toBe(false);
    expect(sent()).toEqual([]);
  });
});

describe('smsChannelProblem', () => {
  it('czynny kanał nie zgłasza problemu, także z nadpisem domyślnym konta', () => {
    channel(key(), { orig: 'Dyzur IT' });
    expect(smsChannelProblem(deps, NOW)).toBeNull();
    channel(key({ name: 'Biuro handlowe', keyHash: 'argon2:bbb', keyPrefix: 'b1b2c3d4' }));
    expect(smsChannelProblem(deps, NOW)).toBeNull();
  });

  it('brak ustawień, klucza albo numerów', () => {
    expect(smsChannelProblem(deps, NOW)).toBe('kanał nie wskazuje klucza API');
    channel(null);
    expect(smsChannelProblem(deps, NOW)).toBe('kanał nie wskazuje klucza API');
    channel(key(), { recipients: [] });
    expect(smsChannelProblem(deps, NOW)).toBe('kanał nie zawiera numerów');
  });

  it('klucz odwołany albo wygasły', () => {
    const revoked = key();
    deps.apiKeys.revoke(revoked);
    channel(revoked);
    expect(smsChannelProblem(deps, NOW)).toBe('klucz API „Dyżur IT” został odwołany');
    channel(key({ name: 'Biuro handlowe', keyHash: 'argon2:bbb', keyPrefix: 'b1b2c3d4', expiresAt: '2026-11-01T00:00:00.000Z' }));
    expect(smsChannelProblem(deps, NOW)).toBe('klucz API „Biuro handlowe” wygasł 2026-11-01');
  });

  it('konto Multiinfo klucza wstrzymane', () => {
    channel(key());
    deps.accounts.pause(accountId, 'Multiinfo odrzuca login (kod 2)');
    expect(smsChannelProblem(deps, NOW)).toBe('konto Multiinfo „Firma Info” jest wstrzymane');
  });

  it('nadpis kanału usunięty z klucza albo ze słownika konta', () => {
    const id = key({ origs: ['Dyzur IT'] });
    channel(id, { orig: 'Dyzur IT' });
    patchKey(id, { origs: [] });
    expect(smsChannelProblem(deps, NOW)).toBe('klucz API „Dyżur IT” nie może już użyć nadpisu „Dyzur IT”');
    const other = key({ name: 'Biuro handlowe', keyHash: 'argon2:bbb', keyPrefix: 'b1b2c3d4', origs: ['Dyzur IT'] });
    channel(other, { orig: 'Dyzur IT' });
    deps.accounts.setOrigs(accountId, [{ orig: 'Firma Info', label: null }]);
    expect(smsChannelProblem(deps, NOW)).toBe('klucz API „Biuro handlowe” nie może już użyć nadpisu „Dyzur IT”');
  });

  it('klucz bez dostępu do swojej domyślnej usługi', () => {
    const id = key();
    channel(id);
    patchKey(id, { serviceIds: ['25000'] });
    expect(smsChannelProblem(deps, NOW)).toBe('klucz API „Dyżur IT” nie ma dostępu do usługi 24138');
  });
});
