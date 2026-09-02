import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApiServer } from '../../src/api/server.ts';
import { HOOK_RATE_PER_MIN } from '../../src/api/hooks.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { defaultInboundConfig, type InboundConfig } from '../../src/integrations/config.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
let app: ReturnType<typeof buildApiServer>;
let integrations: IntegrationsRepo;
let integrationEvents: IntegrationEventsRepo;
let messages: MessagesRepo;
let apiKeys: ApiKeysRepo;
let apiKeyId: number;
const notify = vi.fn();

beforeEach(async () => {
  notify.mockReset();
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accounts = new AccountsRepo(db, key);
  const accountId = accounts.insert(accountInput({ storeContent: 1 }));
  apiKeys = new ApiKeysRepo(db, key);
  apiKeyId = apiKeys.insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
  const deps = integrationDeps(db, key, async () => ['198.51.100.7']);
  integrations = deps.integrations;
  integrationEvents = deps.integrationEvents;
  messages = new MessagesRepo(db);
  app = buildApiServer({
    accounts, apiKeys, messages, events: new MessageEventsRepo(db), jobs: new JobsRepo(db), packages: new PackagesRepo(db),
    clients: {} as never, inbound: new InboundMessagesRepo(db), rateLimiter: new RateLimiter(), now: () => NOW,
    // Stały zegar: kubełek nie uzupełnia się w trakcie testu zalewu.
    ...deps, hookLimiter: new RateLimiter(() => NOW.getTime()), notifier: { notify },
  });
  await app.ready();
});

const make = (config: Partial<InboundConfig> = {}, secrets: Record<string, string> = {}) => {
  const id = integrations.insert({
    name: 'Kuma', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
    config: { ...defaultInboundConfig(), text: { mode: 'liquid', template: '{{ p.msg }}' }, to: { fallback: ['48601000009'] }, ...config },
    secrets, storePayloads: 0, createdAt: NOW,
  });
  return integrations.get(id)!;
};
const post = (hookId: string, payload: unknown, headers: Record<string, string> = {}, ip?: string) =>
  app.inject({ method: 'POST', url: `/hooks/${hookId}`, payload: payload as never, headers: { 'content-type': 'application/json', ...headers }, ...(ip ? { remoteAddress: ip } : {}) });

describe('POST /hooks/:hookId', () => {
  it('202 z identyfikatorami wiadomości', async () => {
    const integ = make();
    const res = await post(integ.hookId!, { msg: 'Serwer padł' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true });
    expect(messages.get(res.json().messageIds[0])!.body).toBe('Serwer padł');
    expect(notify).not.toHaveBeenCalled();
  });
  it('nieznany adres i wyłączona integracja to 404 bez wpisu', async () => {
    expect((await post('x'.repeat(32), { msg: 'x' })).statusCode).toBe(404);
    const integ = make();
    integrations.setEnabled(integ.id, false, NOW);
    expect((await post(integ.hookId!, { msg: 'x' })).statusCode).toBe(404);
    expect(integrationEvents.list(integ.id, 10)).toHaveLength(0);
  });
  it('GET to 405', async () => {
    const integ = make();
    expect((await app.inject({ method: 'GET', url: `/hooks/${integ.hookId}` })).statusCode).toBe(405);
    expect((await app.inject({ method: 'GET', url: '/hooks/nieistnieje' })).statusCode).toBe(405);
  });
  it('formularz urlencoded jest przyjmowany', async () => {
    const integ = make({ to: { path: 'to', fallback: [] } });
    const res = await app.inject({ method: 'POST', url: `/hooks/${integ.hookId}`, payload: 'msg=Formularz&to=48601000001', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(202);
    expect(messages.get(res.json().messageIds[0])!.dest).toBe('48601000001');
  });
  it('token w nagłówku: brak i zły to 401 z wpisem rejected i powiadomieniem, dobry przechodzi', async () => {
    const integ = make({ auth: { header: { name: 'Authorization', valueRef: 'token' }, sources: [] } }, { token: 'Bearer tajne' });
    expect((await post(integ.hookId!, { msg: 'x' })).statusCode).toBe(401);
    expect((await post(integ.hookId!, { msg: 'x' }, { authorization: 'Bearer zle' })).statusCode).toBe(401);
    const events = integrationEvents.list(integ.id, 10);
    expect(events.map((e) => e.result)).toEqual(['rejected', 'rejected']);
    expect(events[0]!.payload).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![0]).toBe('integration_error');
    expect(JSON.stringify(notify.mock.calls)).not.toContain('tajne');
    expect((await post(integ.hookId!, { msg: 'x' }, { authorization: 'Bearer tajne' })).statusCode).toBe(202);
  });
  it('basic auth', async () => {
    const integ = make({ auth: { basic: { user: 'grafana', passRef: 'basic' }, sources: [] } }, { basic: 'haslo' });
    const good = `Basic ${Buffer.from('grafana:haslo').toString('base64')}`;
    expect((await post(integ.hookId!, { msg: 'x' }, { authorization: good })).statusCode).toBe(202);
    expect((await post(integ.hookId!, { msg: 'x' }, { authorization: `Basic ${Buffer.from('grafana:zle').toString('base64')}` })).statusCode).toBe(401);
    expect((await post(integ.hookId!, { msg: 'x' })).statusCode).toBe(401);
  });
  it('lista źródeł: adres spoza listy to 403, nazwa rozwiązana pasuje', async () => {
    const integ = make({ auth: { sources: ['203.0.113.0/24', 'nas.dyndns.example'] } });
    expect((await post(integ.hookId!, { msg: 'x' }, {}, '203.0.113.9')).statusCode).toBe(202);
    expect((await post(integ.hookId!, { msg: 'x' }, {}, '198.51.100.7')).statusCode).toBe(202);
    const res = await post(integ.hookId!, { msg: 'x' }, {}, '192.0.2.1');
    expect(res.statusCode).toBe(403);
    expect(integrationEvents.list(integ.id, 1)[0]).toMatchObject({ result: 'rejected', sourceIp: '192.0.2.1' });
  });
  it('warunek niespełniony, duplikat i limit burzy to 200 accepted:false', async () => {
    const integ = make({ condition: { mode: 'builder', rules: [{ path: 'status', op: 'eq', value: 'down' }] }, eventIdPath: 'id', throttle: { limit: 1, windowMinutes: 10 } });
    const res = await post(integ.hookId!, { status: 'up', msg: 'x' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: false, reason: 'condition' });
    expect((await post(integ.hookId!, { status: 'down', id: 'e1', msg: 'x' })).statusCode).toBe(202);
    expect((await post(integ.hookId!, { status: 'down', id: 'e1', msg: 'x' })).json()).toEqual({ accepted: false, reason: 'duplicate' });
    expect((await post(integ.hookId!, { status: 'down', id: 'e2', msg: 'x' })).json()).toEqual({ accepted: false, reason: 'throttled' });
    expect((await post(integ.hookId!, { status: 'down', id: 'e3', msg: 'x' })).json()).toEqual({ accepted: false, reason: 'throttled' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe('integration_throttled');
  });
  it('pusta treść to 422 z powiadomieniem', async () => {
    const integ = make();
    const res = await post(integ.hookId!, { nic: 1 });
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe('empty_text');
    expect(notify).toHaveBeenCalledWith('integration_error', `integration:${integ.id}`, expect.stringContaining('Kuma'), NOW);
  });
  it('za duży ładunek to 413, zły JSON to 400', async () => {
    const integ = make();
    const big = await post(integ.hookId!, { msg: 'x'.repeat(300 * 1024) });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ accepted: false, reason: 'too_large' });
    const res = await app.inject({ method: 'POST', url: `/hooks/${integ.hookId}`, payload: '{zly', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ accepted: false, reason: 'invalid_body' });
  });
  it('klucz odwołany to 503', async () => {
    const integ = make();
    apiKeys.revoke(apiKeyId);
    const res = await post(integ.hookId!, { msg: 'x' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ accepted: false, reason: 'unavailable' });
  });
  it('zalew z jednego adresu to 429', async () => {
    const integ = make({ throttle: { limit: 1000, windowMinutes: 10 } });
    for (let i = 0; i < HOOK_RATE_PER_MIN; i += 1) expect((await post(integ.hookId!, { msg: 'x' }, {}, '203.0.113.5')).statusCode).toBe(202);
    expect((await post(integ.hookId!, { msg: 'x' }, {}, '203.0.113.5')).statusCode).toBe(429);
    expect((await post(integ.hookId!, { msg: 'x' }, {}, '203.0.113.6')).statusCode).toBe(202);
  });
});
