import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';
import { packagesTileNote } from '../../src/admin/views/overview.ts';

const NOW = new Date('2026-08-25T10:00:00Z');

let h: AdminHarness;
let accountId: number;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Dyspozytornia', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4',
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
});

const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

function addPackage(id: string, createdAt: Date, dests: string[]): void {
  h.packages.insert({
    id, apiKeyId, accountId, serviceId: '24138', defaultText: 'Przegląd serwisowy jutro o 9:00', orig: null,
    costCenter: null, startAt: null, deliveryReport: 0, encoding: 'gsm', multipart: 0, createdAt: createdAt.toISOString(),
  }, dests.map((dest) => ({ dest, text: null, clientId: null })));
}

function addMessage(id: string): void {
  h.messages.insert({
    id, apiKeyId, accountId, serviceId: '24138', dest: '48601135134', body: 'Zlecenie serwisowe przyjęte',
    bodyHash: 'h', encoding: 'gsm', parts: 1, slots: 22, orig: null, costCenter: null, validTo: null,
    idempotencyKey: null, createdAt: NOW.toISOString(),
  });
}

describe('packagesTileNote', () => {
  it('odmienia podpis kafelka według liczby rozsyłek', () => {
    expect(packagesTileNote(0)).toBe('SMS-ów w rozsyłkach');
    expect(packagesTileNote(1)).toBe('SMS-ów w 1 rozsyłce');
    expect(packagesTileNote(2)).toBe('SMS-ów w 2 rozsyłkach');
    expect(packagesTileNote(5)).toBe('SMS-ów w 5 rozsyłkach');
  });
});

describe('GET /przeglad - rozsyłki', () => {
  it('kafelek Rozsyłki liczy SMS-y rozsyłek z ostatniej doby i prowadzi do listy rozsyłek', async () => {
    addPackage('pkg_1', NOW, ['48601000001', '48601000002', '48601000003']);
    addPackage('pkg_0', new Date(NOW.getTime() - 25 * 3600_000), ['48601000004']);
    const res = await page('/przeglad');
    expect(res.body).toMatch(/<a class="tile" href="\/rozsylki">\s*<div class="lab">Rozsyłki<\/div>\s*<div class="n">3<\/div>\s*<div class="d">SMS-ów w 1 rozsyłce<\/div>/);
  });

  it('bez rozsyłek pokazuje zero i podpis dla zera', async () => {
    const res = await page('/przeglad');
    expect(res.body).toMatch(/Rozsyłki<\/div>\s*<div class="n">0<\/div>\s*<div class="d">SMS-ów w rozsyłkach<\/div>/);
  });

  it('kafelek Wychodzące liczy tylko pojedyncze wiadomości, także po dodaniu rozsyłki', async () => {
    addMessage('m1');
    addPackage('pkg_1', NOW, ['48601000001', '48601000002', '48601000003']);
    const res = await page('/przeglad');
    expect(res.body).toMatch(/Wychodzące<\/div>\s*<div class="n">1<\/div>\s*<div class="d">pojedynczych wiadomości zleconych przez aplikacje<\/div>/);
  });

  it('kafelek Rozsyłki stoi za „W drodze”, a przed „Odebrane”', async () => {
    const body = (await page('/przeglad')).body;
    const transit = body.indexOf('<div class="lab">W drodze</div>');
    const packages = body.indexOf('<div class="lab">Rozsyłki</div>');
    const inbound = body.indexOf('<div class="lab">Odebrane</div>');
    expect(transit).toBeGreaterThan(-1);
    expect(packages).toBeGreaterThan(transit);
    expect(inbound).toBeGreaterThan(packages);
  });
});
