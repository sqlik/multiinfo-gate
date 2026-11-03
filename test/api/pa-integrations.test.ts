import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateApiKey } from '../../src/api/keys.ts';
import { parsePaIntegrationApiId, paIntegrationApiId } from '../../src/api/pa-integrations.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { defaultInboundConfig, defaultPowerAutomateConfig, type PowerAutomateConfig } from '../../src/integrations/config.ts';
import { fitToParts } from '../../src/integrations/pipeline.ts';
import type { AdminNotifier } from '../../src/notifications/rules.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';

const masterKey = randomBytes(32);
const NOW = new Date('2026-11-03T10:00:00Z');

let app: ReturnType<typeof buildApiServer>;
let keyA: string;
let keyB: string;
let accounts: AccountsRepo;
let accountId: number;
let messages: MessagesRepo;
let packages: PackagesRepo;
let integrations: IntegrationsRepo;
let events: IntegrationEventsRepo;
let notices: Array<{ event: string; subject: string | null; summary: string }>;
let ekipa: number;
let biuro: number;
let dyzur: number;
let flota: number;
let hook: number;

const EKIPA: PowerAutomateConfig['recipients'] = [
  { phone: '48601000011', name: 'Marek Kowalski' },
  { phone: '48601000012', name: 'Anna Wiśniewska' },
  { phone: '48601000013', name: '' },
];

beforeEach(async () => {
  const db = openDatabase(':memory:');
  accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  messages = new MessagesRepo(db);
  packages = new PackagesRepo(db);
  notices = [];
  const notifier: AdminNotifier = { notify: (event, subject, summary) => { notices.push({ event, subject, summary }); } };

  accountId = accounts.insert({
    name: 'Serwis Północ', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'serwis_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'serwis_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Serwis', storeContent: 1,
    serviceIds: ['24138', '24902'], origs: ['Serwis', 'SerwisAlarm'],
  });
  const a = generateApiKey();
  const b = generateApiKey();
  keyA = a.key;
  keyB = b.key;
  const keyAId = apiKeys.insert({
    accountId, name: 'Power Automate', keyHash: a.hash, keyPrefix: a.prefix,
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138', '24902'], origs: ['SerwisAlarm'],
  });
  const keyBId = apiKeys.insert({
    accountId, name: 'Inny', keyHash: b.hash, keyPrefix: b.prefix,
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });

  const deps = integrationDeps(db, masterKey);
  integrations = deps.integrations;
  events = deps.integrationEvents;
  const pa = (name: string, apiKeyId: number, enabled: 0 | 1, config: Partial<PowerAutomateConfig> = {}, extra: { serviceId?: string; orig?: string } = {}) =>
    integrations.insert({
      name, kind: 'power_automate', apiKeyId, serviceId: extra.serviceId ?? null, orig: extra.orig ?? null, preset: 'power-automate',
      enabled, config: { ...defaultPowerAutomateConfig(), ...config }, secrets: {}, storePayloads: 1, createdAt: NOW,
    });
  ekipa = pa('Ekipa serwisowa', keyAId, 1, { recipients: EKIPA }, { serviceId: '24902', orig: 'SerwisAlarm' });
  biuro = pa('Biuro handlowe', keyAId, 1);
  dyzur = pa('Dyżur IT', keyAId, 0);
  flota = pa('Flota', keyBId, 1);
  hook = integrations.insert({
    name: 'Alerty', kind: 'webhook_in', apiKeyId: keyAId, serviceId: null, orig: null, preset: 'custom',
    enabled: 1, config: defaultInboundConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
  });

  app = buildApiServer({
    accounts, apiKeys, messages, events: new MessageEventsRepo(db), jobs: new JobsRepo(db), packages,
    inbound: new InboundMessagesRepo(db), clients: {} as never, rateLimiter: new RateLimiter(),
    ...deps, notifier, now: () => NOW,
  });
  await app.ready();
});

const auth = (key = keyA) => ({ authorization: `Bearer ${key}` });
const post = (url: string, payload: unknown, headers: Record<string, string> = auth()) =>
  app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });
const allMessages = () => messages.list({ limit: 100, offset: 0 });
const allPackages = () => packages.list({ limit: 100, offset: 0 });
const log = (id: number) => events.list(id, 50);

describe('identyfikator integracji w API', () => {
  it('int_<numer> w obie strony, inne kształty odrzucone', () => {
    expect(paIntegrationApiId(12)).toBe('int_12');
    expect(parsePaIntegrationApiId('int_12')).toBe(12);
    for (const raw of ['int_0', '12', 'int_12abc', 'int_', 'grp_12', 'int_012', 'int_12345678901']) {
      expect(parsePaIntegrationApiId(raw)).toBeNull();
    }
  });
});

describe('GET /v1/integrations', () => {
  it('włączone integracje Power Automate klucza, po nazwie, z liczbą odbiorców, bez numerów i nazwisk', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/integrations', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [
      { id: `int_${biuro}`, name: 'Biuro handlowe', recipients: 0 },
      { id: `int_${ekipa}`, name: 'Ekipa serwisowa', recipients: 3 },
    ] });
    expect(res.body).not.toContain('48601');
    expect(res.body).not.toContain('Kowalski');
  });
  it('bez klucza 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/integrations' })).statusCode).toBe(401);
  });
});

describe('POST /v1/integrations/{id}/messages', () => {
  it('wysyła przez integrację: usługa, nadpis i zlecający z integracji, wpis „wysłano”', async () => {
    const res = await post(`/v1/integrations/int_${ekipa}/messages`, { to: '601000001', text: 'Awaria w hali B', requestedBy: 'jan.nowak@firma.pl' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toEqual({ id: expect.stringMatching(/^msg_/), status: 'queued', encoding: 'gsm', parts: 1, characters: 15, slots: 15, slotsRemaining: 145 });
    const m = messages.get(body.id)!;
    expect(m).toMatchObject({ dest: '48601000001', integrationId: ekipa, serviceId: '24902', orig: 'SerwisAlarm', requestedBy: 'jan.nowak@firma.pl' });
    const [entry] = log(ekipa);
    expect(entry).toMatchObject({ result: 'sent', reason: 'Wyślij SMS', messageId: body.id, sourceIp: 'API · jan.nowak@firma.pl' });
    expect(JSON.parse(entry!.payload!)).toMatchObject({ to: '601000001' });
  });

  it('bez zlecającego kolumna „Nadawca” pokazuje adres IP wywołania, a wiadomość nie ma zlecającego', async () => {
    const res = await post(`/v1/integrations/int_${biuro}/messages`, { to: '48601000001', text: 'Oferta gotowa' });
    expect(res.statusCode).toBe(202);
    expect(log(biuro)[0]!.sourceIp).toBe('API · 127.0.0.1');
    expect(messages.get(res.json().id)!.requestedBy).toBeNull();
    // Integracja bez usługi i nadpisu: domyślne klucza i konta.
    expect(messages.get(res.json().id)).toMatchObject({ serviceId: '24138', orig: 'Serwis' });
  });

  it.each([[''], ['  '], [null], [undefined]])('numer %j: 400 invalid_body, wpis „błąd”, zero wiadomości', async (to) => {
    const res = await post(`/v1/integrations/int_${ekipa}/messages`, { text: 'Awaria w hali B', ...(to === undefined ? {} : { to }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
    expect(allMessages()).toEqual([]);
    expect(log(ekipa)[0]).toMatchObject({ result: 'error', reason: expect.stringMatching(/^Wyślij SMS: to/) });
    expect(notices.map((n) => n.event)).toEqual(['integration_error']);
  });

  it('serviceId i orig w ciele nie zmieniają usługi ani nadpisu integracji', async () => {
    const res = await post(`/v1/integrations/int_${ekipa}/messages`, { to: '48601000001', text: 'x', serviceId: '24138', orig: 'Serwis' });
    expect(res.statusCode).toBe(202);
    expect(messages.get(res.json().id)).toMatchObject({ serviceId: '24902', orig: 'SerwisAlarm' });
  });

  it('powtórzony Idempotency-Key zwraca tę samą wiadomość', async () => {
    const headers = { ...auth(), 'idempotency-key': 'zlecenie-4411' };
    const first = await post(`/v1/integrations/int_${ekipa}/messages`, { to: '48601000001', text: 'x' }, headers);
    const second = await post(`/v1/integrations/int_${ekipa}/messages`, { to: '48601000001', text: 'x' }, headers);
    expect(second.json().id).toBe(first.json().id);
    expect(allMessages()).toHaveLength(1);
  });

  it('nieprawidłowy numer: 400 invalid_phone, wpis „błąd”, powiadomienie bez numeru', async () => {
    const res = await post(`/v1/integrations/int_${ekipa}/messages`, { to: 'abc123', text: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_phone');
    expect(log(ekipa)[0]).toMatchObject({ result: 'error', reason: expect.stringMatching(/^Wyślij SMS: /) });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.summary).not.toContain('abc123');
    expect(notices[0]!.summary).toContain('Ekipa serwisowa');
  });
});

describe('POST /v1/integrations/{id}/group', () => {
  it('wysyła do każdego numeru z listy integracji', async () => {
    const res = await post(`/v1/integrations/int_${ekipa}/group`, { text: 'Awaria w hali B, zgłoszenie 4411', requestedBy: 'Dyspozytornia' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.integration).toEqual({ id: `int_${ekipa}`, name: 'Ekipa serwisowa' });
    expect(body.recipients).toBe(3);
    expect(body.messages.map((m: { to: string }) => m.to)).toEqual(['48601000011', '48601000012', '48601000013']);
    expect(body.messages[0]).toEqual({ id: expect.stringMatching(/^msg_/), to: '48601000011', status: 'queued', parts: 1 });
    expect(allMessages()).toHaveLength(3);
    expect(allMessages().every((m) => m.integrationId === ekipa && m.requestedBy === 'Dyspozytornia')).toBe(true);
    expect(log(ekipa)[0]).toMatchObject({ result: 'sent', reason: 'Wyślij SMS do grupy, 3 odbiorców', messageId: body.messages[0].id, sourceIp: 'API · Dyspozytornia' });
  });

  it('pusta lista odbiorców: 409 group_empty, wpis „błąd”, zero wiadomości', async () => {
    const res = await post(`/v1/integrations/int_${biuro}/group`, { text: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code: 'group_empty', message: 'Integracja Biuro handlowe nie ma odbiorców grupy. Listę uzupełnia administrator w panelu bramki.' });
    expect(allMessages()).toEqual([]);
    expect(log(biuro)[0]).toMatchObject({ result: 'error', reason: expect.stringMatching(/^Wyślij SMS do grupy: /) });
  });

  it('ciało z polem to nie zmienia odbiorców', async () => {
    const res = await post(`/v1/integrations/int_${ekipa}/group`, { text: 'x', to: '48601999999' });
    expect(res.statusCode).toBe(202);
    expect(allMessages().map((m) => m.dest)).not.toContain('48601999999');
  });
});

describe('POST /v1/integrations/{id}/packages', () => {
  it('rozsyłka z integracją i zlecającym, wpis z rozsyłką', async () => {
    const res = await post(`/v1/integrations/int_${ekipa}/packages`, {
      recipients: [{ to: '48601000001' }, { to: '48601000002', text: 'Zmiana grafiku od poniedziałku' }],
      defaultText: 'Przegląd floty jutro o 8:00', requestedBy: 'kierownik@firma.pl',
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toEqual({ id: expect.stringMatching(/^pkg_/), status: 'queued', recipients: 2, encoding: 'ucs2', multipart: false });
    expect(packages.get(body.id)).toMatchObject({ integrationId: ekipa, requestedBy: 'kierownik@firma.pl', serviceId: '24902', orig: 'SerwisAlarm' });
    expect(log(ekipa)[0]).toMatchObject({ result: 'sent', reason: 'Wyślij rozsyłkę, 2 odbiorców', packageId: body.id, messageId: null });
  });

  it('pusta treść odbiorcy znaczy treść wspólną', async () => {
    const res = await post(`/v1/integrations/int_${ekipa}/packages`, { recipients: [{ to: '48601000001', text: '', clientId: null }], defaultText: 'x' });
    expect(res.statusCode).toBe(202);
  });
});

describe('limit części integracji', () => {
  const long = 'Serwis ' + 'x'.repeat(193); // 200 znaków GSM: 2 części

  it('skróć i wyślij: jedna część, powód kończy się dopiskiem o skróceniu', async () => {
    integrations.update(biuro, { ...rowPatch(biuro), config: { ...defaultPowerAutomateConfig(), maxParts: 1, overflow: 'truncate' } }, NOW);
    const res = await post(`/v1/integrations/int_${biuro}/messages`, { to: '48601000001', text: long });
    expect(res.statusCode).toBe(202);
    expect(messages.get(res.json().id)!.parts).toBe(1);
    expect(log(biuro)[0]!.reason).toBe('Wyślij SMS; skrócono do 1 części');
  });

  it('nie wysyłaj: 400 too_many_parts z liczbą części i limitem integracji, zero wiadomości', async () => {
    integrations.update(biuro, { ...rowPatch(biuro), config: { ...defaultPowerAutomateConfig(), maxParts: 1, overflow: 'reject' } }, NOW);
    const res = await post(`/v1/integrations/int_${biuro}/messages`, { to: '48601000001', text: long });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: 'too_many_parts', message: 'Treść wymaga 2 części, a limit integracji to 1.' });
    expect(allMessages()).toEqual([]);
    expect(log(biuro)[0]).toMatchObject({ result: 'error', reason: 'Wyślij SMS: Treść wymaga 2 części, a limit integracji to 1.' });
    expect(notices.map((n) => n.event)).toEqual(['integration_error']);
  });

  it('rozsyłka przy „nie wysyłaj”: jedna długa treść odbiorcy odrzuca całość z indeksem, bez rozsyłki', async () => {
    integrations.update(biuro, { ...rowPatch(biuro), config: { ...defaultPowerAutomateConfig(), maxParts: 1, overflow: 'reject' } }, NOW);
    const res = await post(`/v1/integrations/int_${biuro}/packages`, { recipients: [{ to: '48601000001' }, { to: '48601000002', text: long }], defaultText: 'krótko' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/^recipients\.1: Treść wymaga 2 części/);
    expect(allPackages()).toEqual([]);
  });

  it('rozsyłka przy „nie wysyłaj”: długa treść wspólna z przedrostkiem defaultText', async () => {
    integrations.update(biuro, { ...rowPatch(biuro), config: { ...defaultPowerAutomateConfig(), maxParts: 1, overflow: 'reject' } }, NOW);
    const res = await post(`/v1/integrations/int_${biuro}/packages`, { recipients: [{ to: '48601000001' }], defaultText: long });
    expect(res.json().error.message).toMatch(/^defaultText: Treść wymaga 2 części/);
  });

  it('rozsyłka przy „skróć i wyślij”: każda długa treść skrócona osobno', async () => {
    integrations.update(biuro, { ...rowPatch(biuro), config: { ...defaultPowerAutomateConfig(), maxParts: 1, overflow: 'truncate' } }, NOW);
    const res = await post(`/v1/integrations/int_${biuro}/packages`, {
      recipients: [{ to: '48601000001' }, { to: '48601000002', text: long }, { to: '48601000003', text: 'krótko' }], defaultText: long,
    });
    expect(res.statusCode).toBe(202);
    const pkg = packages.get(res.json().id)!;
    const cut = fitToParts(long, 1).text;
    expect(cut.endsWith('...')).toBe(true);
    expect(pkg.multipart).toBe(0);
    expect(pkg.defaultText).toBe(cut);
    expect(packages.recipients(pkg.id).map((r) => r.text)).toEqual([null, cut, 'krótko']);
    expect(log(biuro)[0]!.reason).toBe('Wyślij rozsyłkę, 3 odbiorców; skrócono do 1 części');
  });
});

describe('ochrona przed burzą', () => {
  it('ponad limit: 429 integration_throttled, wpis „limit”, powiadomienie raz na okno', async () => {
    integrations.update(biuro, { ...rowPatch(biuro), config: { ...defaultPowerAutomateConfig(), throttle: { limit: 2, windowMinutes: 10 } } }, NOW);
    const send = () => post(`/v1/integrations/int_${biuro}/messages`, { to: '48601000001', text: 'x' });
    expect((await send()).statusCode).toBe(202);
    expect((await send()).statusCode).toBe(202);
    const third = await send();
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toEqual({
      code: 'integration_throttled',
      message: 'Integracja Biuro handlowe przekroczyła limit 2 wysyłek w 10 min. Spróbuj później albo poproś administratora o zmianę limitu.',
    });
    expect(log(biuro)[0]).toMatchObject({ result: 'throttled', reason: 'ponad 2 w 10 min' });
    expect((await send()).statusCode).toBe(429);
    expect(notices.filter((n) => n.event === 'integration_throttled')).toHaveLength(1);
    expect(allMessages()).toHaveLength(2);
  });
});

describe('integracja nieznana, cudza, innego rodzaju albo wyłączona', () => {
  it.each([
    ['int_999'], ['int_0'], ['12'], ['int_12abc'],
  ])('%s: 404 integration_not_found', async (id) => {
    const res = await post(`/v1/integrations/${id}/messages`, { to: '48601000001', text: 'x' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: 'integration_not_found', message: 'Nie ma integracji Power Automate o tym identyfikatorze.' });
  });

  it('integracja innego klucza i webhook pod int_<id>: 404, zero wiadomości i wpisów', async () => {
    for (const [id, action] of [[flota, 'messages'], [hook, 'messages'], [flota, 'group'], [hook, 'packages']] as const) {
      const res = await post(`/v1/integrations/int_${id}/${action}`, { to: '48601000001', text: 'x', recipients: [{ to: '48601000001' }], defaultText: 'x' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('integration_not_found');
    }
    expect(allMessages()).toEqual([]);
    expect(log(flota)).toEqual([]);
    expect(log(hook)).toEqual([]);
  });

  it('wyłączona: 409 integration_disabled bez wpisu w dzienniku', async () => {
    const res = await post(`/v1/integrations/int_${dyzur}/messages`, { to: '48601000001', text: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code: 'integration_disabled', message: 'Integracja Dyżur IT jest wyłączona w panelu bramki.' });
    expect(log(dyzur)).toEqual([]);
    expect(allMessages()).toEqual([]);
  });

  it('bez klucza 401, z kluczem innej integracji 404', async () => {
    expect((await post(`/v1/integrations/int_${ekipa}/messages`, { to: '48601000001', text: 'x' }, {})).statusCode).toBe(401);
    expect((await post(`/v1/integrations/int_${ekipa}/messages`, { to: '48601000001', text: 'x' }, auth(keyB))).statusCode).toBe(404);
  });
});

describe('zlecający', () => {
  it.each([['Jan\u0007Nowak'], ['x'.repeat(101)], ['Jan\nNowak']])('%j: 400 invalid_body', async (requestedBy) => {
    const res = await post(`/v1/integrations/int_${ekipa}/messages`, { to: '48601000001', text: 'x', requestedBy });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
    expect(allMessages()).toEqual([]);
  });

  it('HTML przechodzi do bazy bez zmian, 100 znaków przechodzi', async () => {
    const res = await post(`/v1/integrations/int_${ekipa}/messages`, { to: '48601000001', text: 'x', requestedBy: '<b>Jan</b>' });
    expect(messages.get(res.json().id)!.requestedBy).toBe('<b>Jan</b>');
    expect(log(ekipa)[0]!.sourceIp).toBe('API · <b>Jan</b>');
    expect((await post(`/v1/integrations/int_${ekipa}/messages`, { to: '48601000002', text: 'x', requestedBy: 'x'.repeat(100) })).statusCode).toBe(202);
  });

  it('zlecający z samych spacji liczy się jak pominięty', async () => {
    const res = await post(`/v1/integrations/int_${ekipa}/messages`, { to: '48601000001', text: 'x', requestedBy: '   ' });
    expect(res.statusCode).toBe(202);
    expect(messages.get(res.json().id)!.requestedBy).toBeNull();
    expect(log(ekipa)[0]!.sourceIp).toBe('API · 127.0.0.1');
  });
});

describe('konto niedostępne', () => {
  it('konto wstrzymane: 503 integration_unavailable, wpis „błąd”, powiadomienie, zero wiadomości', async () => {
    accounts.pause(accountId, 'certyfikat wygasł');
    const res = await post(`/v1/integrations/int_${ekipa}/messages`, { to: '48601000001', text: 'x' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('integration_unavailable');
    expect(res.json().error.message).toContain('konto wstrzymane: certyfikat wygasł');
    expect(log(ekipa)[0]).toMatchObject({ result: 'error' });
    expect(notices.map((n) => n.event)).toEqual(['integration_error']);
    expect(allMessages()).toEqual([]);
  });
});

/** Łata zapisu integracji: wszystko jak w wierszu, wołający podmienia konfigurację. */
function rowPatch(id: number) {
  const row = integrations.get(id)!;
  return { name: row.name, serviceId: row.serviceId, orig: row.orig, preset: row.preset, enabled: row.enabled, config: row.config, storePayloads: row.storePayloads };
}
