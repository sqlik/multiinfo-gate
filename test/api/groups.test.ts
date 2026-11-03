import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { groupApiId, parseGroupApiId } from '../../src/api/groups.ts';
import { generateApiKey } from '../../src/api/keys.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { defaultInboundConfig, defaultSmsGroupConfig, type SmsGroupConfig } from '../../src/integrations/config.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import type { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import type { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';

const masterKey = randomBytes(32);
const NOW = new Date('2026-11-03T10:00:00Z');
let app: ReturnType<typeof buildApiServer>;
let db: ReturnType<typeof openDatabase>;
let messages: MessagesRepo;
let jobs: JobsRepo;
let integrations: IntegrationsRepo;
let integrationEvents: IntegrationEventsRepo;
let keyA: { id: number; key: string };
let keyB: { id: number; key: string };

beforeEach(async () => {
  db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  messages = new MessagesRepo(db);
  jobs = new JobsRepo(db);
  const accountId = accounts.insert({
    name: 'Serwis Północ', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'serwis_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'serwis_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent: 1,
    serviceIds: ['24138', '24902'], origs: ['Firma Info', 'Firma Alert'],
  });
  const addKey = (name: string) => {
    const generated = generateApiKey();
    const id = apiKeys.insert({
      accountId, name, keyHash: generated.hash, keyPrefix: generated.prefix,
      defaultServiceId: '24138', defaultOrig: 'Firma Info', maxParts: 2, ratePerMin: 60,
      webhookUrl: null, webhookSecret: null, serviceIds: ['24138', '24902'], origs: ['Firma Alert'],
    });
    return { id, key: generated.key };
  };
  keyA = addKey('Power Automate');
  keyB = addKey('Inna aplikacja');
  const integ = integrationDeps(db, masterKey);
  integrations = integ.integrations;
  integrationEvents = integ.integrationEvents;
  app = buildApiServer({
    accounts, apiKeys, messages, events: new MessageEventsRepo(db), jobs, packages: new PackagesRepo(db),
    clients: {} as never, inbound: new InboundMessagesRepo(db), rateLimiter: new RateLimiter(), now: () => NOW, ...integ,
  });
  await app.ready();
});

function addGroup(name: string, config: Partial<SmsGroupConfig>, opts: { apiKeyId?: number; enabled?: 0 | 1; serviceId?: string | null; orig?: string | null } = {}): number {
  return integrations.insert({
    name, kind: 'sms_group', apiKeyId: opts.apiKeyId ?? keyA.id, serviceId: opts.serviceId === undefined ? '24902' : opts.serviceId,
    orig: opts.orig === undefined ? 'Firma Alert' : opts.orig, preset: 'sms-grupa', enabled: opts.enabled ?? 1,
    config: { ...defaultSmsGroupConfig(), ...config }, secrets: {}, storePayloads: 0, createdAt: NOW,
  });
}

const serwis = () => addGroup('Ekipa serwisowa', { recipients: ['48601000001', '48601000002', '48601000003'] });
const kierowcy = () => addGroup('Kierowcy', {
  mode: 'closed', members: [{ phone: '48601000011', name: 'Jan Kowalski' }, { phone: '48601000012', name: 'Ewa Nowak' }],
});

const list = (key = keyA.key) =>
  app.inject({ method: 'GET', url: '/v1/groups', headers: { authorization: `Bearer ${key}` } });
const send = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/v1/groups/${id}/messages`, headers: { authorization: `Bearer ${keyA.key}`, ...headers }, payload: body });
const messageCount = () => (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;

describe('identyfikator grupy w API', () => {
  it('ma postać grp_<liczba> i wraca do liczby', () => {
    expect(groupApiId(12)).toBe('grp_12');
    expect(parseGroupApiId('grp_12')).toBe(12);
    for (const bad of ['12', 'grp_0', 'grp_012', 'grp_12abc', 'grp_', 'GRP_12', 'grp_12345678901']) expect(parseGroupApiId(bad), bad).toBeNull();
  });
});

describe('GET /v1/groups', () => {
  it('pokazuje czynne grupy klucza po nazwie, z liczbą odbiorców, bez numerów i nazwisk', async () => {
    const k = kierowcy();
    const s = serwis();
    addGroup('Archiwum', { recipients: ['48601000021'] }, { enabled: 0 });
    addGroup('Magazyn', { recipients: ['48601000031'] }, { apiKeyId: keyB.id });
    integrations.insert({
      name: 'Alarmy', kind: 'webhook_in', apiKeyId: keyA.id, serviceId: null, orig: null, preset: 'wlasna', enabled: 1,
      config: defaultInboundConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [
      { id: `grp_${s}`, name: 'Ekipa serwisowa', recipients: 3 },
      { id: `grp_${k}`, name: 'Kierowcy', recipients: 2 },
    ] });
    for (const hidden of ['48601', 'Kowalski', 'Nowak', 'Firma Alert', '24902']) expect(res.body).not.toContain(hidden);
  });

  it('bez klucza odpowiada 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/groups' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/groups/{id}/messages', () => {
  it('wysyła treść do każdego odbiorcy listy usługą i nadpisem grupy, z wpisem w dzienniku grupy', async () => {
    const id = serwis();
    const res = await send(`grp_${id}`, { text: 'Awaria w hali B, zgłoszenie 4411' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.group).toEqual({ id: `grp_${id}`, name: 'Ekipa serwisowa' });
    expect(body.recipients).toBe(3);
    expect(body.messages.map((m: { to: string }) => m.to)).toEqual(['48601000001', '48601000002', '48601000003']);
    expect(body.messages[0]).toMatchObject({ status: 'queued', parts: 1 });
    expect(body.messages[0].id).toMatch(/^msg_/);
    for (const m of body.messages) {
      const row = messages.get(m.id)!;
      expect(row).toMatchObject({ integrationId: id, serviceId: '24902', orig: 'Firma Alert', body: 'Awaria w hali B, zgłoszenie 4411', apiKeyId: keyA.id });
    }
    expect(jobs.claim(new Date(NOW.getTime() + 1000), 10)).toHaveLength(3);
    expect(integrationEvents.list(id, 10)).toEqual([
      expect.objectContaining({ result: 'sent', reason: 'wysyłka przez API, 3 odbiorców', messageId: body.messages[0].id }),
    ]);
  });

  it('w grupie zamkniętej wysyła do wszystkich członków', async () => {
    const id = kierowcy();
    const res = await send(`grp_${id}`, { text: 'Zmiana trasy na jutro' });
    expect(res.statusCode).toBe(202);
    expect(res.json().messages.map((m: { to: string }) => m.to)).toEqual(['48601000011', '48601000012']);
  });

  it('nadpis z żądania ma pierwszeństwo, pominięty albo pusty oznacza nadpis grupy', async () => {
    const id = serwis();
    const origOf = async (body: Record<string, unknown>) => messages.get((await send(`grp_${id}`, body)).json().messages[0].id)!.orig;
    expect(await origOf({ text: 'a' })).toBe('Firma Alert');
    expect(await origOf({ text: 'b', orig: '' })).toBe('Firma Alert');
    expect(await origOf({ text: 'c', orig: 'Firma Info' })).toBe('Firma Info');
  });

  it('grupa bez usługi i nadpisu wysyła usługą i nadpisem domyślnym klucza', async () => {
    const id = addGroup('Dyżur IT', { recipients: ['48601000041'] }, { serviceId: null, orig: null });
    const sent = (await send(`grp_${id}`, { text: 'Serwer poczty nie odpowiada' })).json();
    expect(messages.get(sent.messages[0].id)).toMatchObject({ serviceId: '24138', orig: 'Firma Info' });
  });

  it('cudza, nieistniejąca i źle zapisana grupa to ta sama odpowiedź 404', async () => {
    const other = addGroup('Magazyn', { recipients: ['48601000031'] }, { apiKeyId: keyB.id });
    for (const raw of [`grp_${other}`, 'grp_999', '12', 'grp_0', 'grp_12abc']) {
      const res = await send(raw, { text: 'x' });
      expect(res.statusCode, raw).toBe(404);
      expect(res.json().error.code, raw).toBe('group_not_found');
    }
    expect(messageCount()).toBe(0);
  });

  it('integracja innego rodzaju pod identyfikatorem grupy to 404', async () => {
    const id = integrations.insert({
      name: 'Alarmy', kind: 'webhook_in', apiKeyId: keyA.id, serviceId: null, orig: null, preset: 'wlasna', enabled: 1,
      config: defaultInboundConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    const res = await send(`grp_${id}`, { text: 'x' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('group_not_found');
  });

  it('wyłączona grupa to 409 group_disabled bez żadnej wiadomości', async () => {
    const id = addGroup('Archiwum', { recipients: ['48601000021'] }, { enabled: 0 });
    const res = await send(`grp_${id}`, { text: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('group_disabled');
    expect(messageCount()).toBe(0);
  });

  it('grupa bez odbiorców to 409 group_empty bez żadnej wiadomości', async () => {
    const id = addGroup('Nowa ekipa', { recipients: [] });
    const res = await send(`grp_${id}`, { text: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('group_empty');
    expect(messageCount()).toBe(0);
  });

  it('treść ponad limit części klucza to 400 too_many_parts bez żadnej wiadomości', async () => {
    const id = serwis();
    const res = await send(`grp_${id}`, { text: 'x'.repeat(400) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('too_many_parts');
    expect(messageCount()).toBe(0);
  });

  it('brak treści to 400 invalid_body', async () => {
    const id = serwis();
    const res = await send(`grp_${id}`, { text: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
  });

  it('pola to i serviceId w żądaniu nie zmieniają odbiorców ani usługi', async () => {
    const id = serwis();
    const res = await send(`grp_${id}`, { text: 'x', to: '48601000099', serviceId: '24138' });
    expect(res.statusCode).toBe(202);
    expect(res.json().messages.map((m: { to: string }) => m.to)).not.toContain('48601000099');
    expect(messages.get(res.json().messages[0].id)!.serviceId).toBe('24902');
  });

  it('powtórzony klucz idempotencji zwraca te same wiadomości', async () => {
    const id = serwis();
    const first = (await send(`grp_${id}`, { text: 'Przegląd o 8:00' }, { 'idempotency-key': 'zgloszenie-4411' })).json();
    const second = (await send(`grp_${id}`, { text: 'Przegląd o 8:00' }, { 'idempotency-key': 'zgloszenie-4411' })).json();
    expect(second.messages.map((m: { id: string }) => m.id)).toEqual(first.messages.map((m: { id: string }) => m.id));
    expect(messageCount()).toBe(3);
  });

  it('bez klucza odpowiada 401', async () => {
    const id = serwis();
    const res = await app.inject({ method: 'POST', url: `/v1/groups/grp_${id}/messages`, payload: { text: 'x' } });
    expect(res.statusCode).toBe(401);
  });
});
