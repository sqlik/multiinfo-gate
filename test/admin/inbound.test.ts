import { beforeEach, describe, expect, it } from 'vitest';
import type { InboundInput } from '../../src/store/inbound-messages.ts';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-08-25T10:00:00Z');

let h: AdminHarness;
let accountId: number;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Powiadomienia CRM', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4',
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: 'https://crm.example/hook', webhookSecret: 's', serviceIds: ['24138'],
  });
});

const seed = (id: string, over: Partial<InboundInput> = {}) => h.inbound.insertIfNew({
  id, accountId, serviceId: '24138', miId: id, sender: '48601000001', dest: '7968', kind: 'text', body: 'Dziekuje, jasne',
  bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: '60199', relatedMessageId: null,
  receivedAt: '2026-08-25T09:14:00.000Z', createdAt: '2026-08-25T09:14:02.000Z', ...over,
});
const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

describe('GET /odebrane', () => {
  it('lista od najnowszej z nadawcą, usługą, treścią i odnośnikiem do szczegółu', async () => {
    seed('in_1', { createdAt: '2026-08-25T09:00:00.000Z' });
    seed('in_2', { createdAt: '2026-08-25T10:00:00.000Z', sender: '48605000001' });
    const res = await page('/odebrane');
    expect(res.statusCode).toBe(200);
    expect(res.body.indexOf('in_2')).toBeLessThan(res.body.indexOf('in_1'));
    expect(res.body).toContain('href="/odebrane/in_1"');
    expect(res.body).toContain('48605000001');
    expect(res.body).toContain('Dziekuje, jasne');
    expect(res.body).toContain('24138');
    expect(res.body).toContain('2026-08-25 11:14:00');
  });

  it('filtruje po nadawcy, usłudze, koncie i dniach', async () => {
    seed('in_1', { receivedAt: '2026-08-24T09:00:00.000Z' });
    seed('in_2', { sender: '48605000001', serviceId: '24902' });
    expect((await page('/odebrane?od=48605000001')).body).not.toContain('href="/odebrane/in_1"');
    expect((await page('/odebrane?usluga=24902')).body).not.toContain('href="/odebrane/in_1"');
    expect((await page('/odebrane?dzienOd=2026-08-25')).body).not.toContain('href="/odebrane/in_1"');
    expect((await page('/odebrane?dzienDo=2026-08-24')).body).not.toContain('href="/odebrane/in_2"');
    expect((await page(`/odebrane?konto=${accountId}`)).body).toContain('href="/odebrane/in_1"');
    expect((await page('/odebrane?konto=999')).body).not.toContain('href="/odebrane/in_1"');
    expect((await page('/odebrane?dzienOd=2026-02-31')).statusCode).toBe(200);
  });

  it('treść nieprzechowywana ma podpis zamiast treści', async () => {
    seed('in_1', { body: null });
    expect((await page('/odebrane')).body).toContain('treść nieprzechowywana');
  });

  it('stronicuje po 25', async () => {
    for (let i = 0; i < 26; i += 1) seed(`in_${String(i).padStart(2, '0')}`, { createdAt: `2026-08-25T09:${String(i).padStart(2, '0')}:00.000Z` });
    const first = await page('/odebrane');
    expect(first.body).toContain('href="/odebrane?offset=25"');
    expect(first.body).not.toContain('href="/odebrane/in_00"');
    const second = await page('/odebrane?offset=25');
    expect(second.body).toContain('href="/odebrane/in_00"');
    expect(second.body).toContain('href="/odebrane"');
  });

  it('pozycja Odebrane jest zaznaczona w nawigacji', async () => {
    expect((await page('/odebrane')).body).toContain('href="/odebrane" class="on"');
  });
});

describe('GET /odebrane/:id', () => {
  it('pokazuje pola, ślad dostaw, powiązaną wysłaną i odpowiedzi', async () => {
    h.messages.insert({ id: 'msg_pod', apiKeyId, accountId, serviceId: '24138', dest: '48601000001', body: 'Podsumowanie', bodyHash: 'h',
      encoding: 'gsm', parts: 1, slots: 12, orig: null, costCenter: null, validTo: null, idempotencyKey: null, createdAt: '2026-08-25T09:00:00.000Z' });
    seed('in_1', { relatedMessageId: 'msg_pod' });
    h.messages.insert({ id: 'msg_odp', apiKeyId, accountId, serviceId: '24138', dest: '48601000001', body: 'Dziękujemy', bodyHash: 'h',
      encoding: 'ucs2', parts: 1, slots: 10, orig: null, costCenter: null, validTo: null, idempotencyKey: null, inReplyTo: 'in_1', createdAt: '2026-08-25T09:20:00.000Z' });
    const d = h.deliveries.insert({ apiKeyId, event: 'message.received', payload: '{}', url: 'https://crm.example/hook', createdAt: NOW, inboundId: 'in_1' });
    h.deliveries.markDelivered(d, NOW, '204 ');
    const res = await page('/odebrane/in_1');
    expect(res.statusCode).toBe(200);
    for (const s of ['48601000001', '7968', '24138', 'Dziekuje, jasne', 'href="/wiadomosci/msg_pod"', 'href="/wiadomosci/msg_odp"', 'Powiadomienia CRM', 'doręczony', '2026-08-25 11:14:00', '60199']) {
      expect(res.body).toContain(s);
    }
  });

  it('bez subskrybentów mówi to wprost', async () => {
    seed('in_1');
    const res = await page('/odebrane/in_1');
    expect(res.body).toContain('Żaden klucz nie subskrybował');
    expect(res.body).toContain('nie powiązano');
  });

  it('binarna pokazuje hex i typ', async () => {
    seed('in_1', { kind: 'binary', body: '0605040B8423F0 48656C6C6F' });
    const res = await page('/odebrane/in_1');
    expect(res.body).toContain('0605040B8423F0 48656C6C6F');
    expect(res.body).toContain('binarna');
  });

  it('treść nieprzechowywana - podpis z nazwą konta', async () => {
    seed('in_1', { body: null });
    expect((await page('/odebrane/in_1')).body).toContain('Treść nieprzechowywana - konto Firma Info');
  });

  it('404 dla nieznanego identyfikatora', async () => {
    expect((await page('/odebrane/in_x')).statusCode).toBe(404);
  });
});
