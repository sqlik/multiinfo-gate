import { beforeEach, describe, expect, it } from 'vitest';
import { defaultInboundConfig, defaultMailInConfig } from '../../src/integrations/config.ts';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-08-25T10:00:00Z');

let h: AdminHarness;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  const accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Monitoring NOC', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4',
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
});

const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

describe('GET /przeglad - integracje', () => {
  it('kafelek liczy integracje z błędami w dobie i pokazuje ostrzeżenie', async () => {
    const id = h.integrations.insert({
      name: 'Kuma', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'uptime-kuma', enabled: 1,
      config: defaultInboundConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    h.integrationEvents.record({ integrationId: id, at: new Date(NOW.getTime() - 3_600_000), result: 'error', reason: 'pusta treść', logLimit: 200 });
    h.integrationEvents.record({ integrationId: id, at: new Date(NOW.getTime() - 60_000), result: 'throttled', logLimit: 200 });
    const res = await page('/przeglad');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/Integracje z błędami<\/div>\s*<div class="n fail">1</);
    expect(res.body).toContain('class="alert');
    expect(res.body).toContain('1 integracja zgłosiła błąd');
    expect(res.body).toContain('href="/integracje"');
  });

  it('kafelek integracji liczy skrzynkę w błędzie razem z innymi błędami', async () => {
    const id = h.integrations.insert({
      name: 'Poczta', kind: 'mail_in', apiKeyId, serviceId: null, orig: null, preset: 'poczta-wlasny', enabled: 1,
      config: defaultMailInConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    h.mailIn.ensureState(id, NOW);
    h.mailIn.recordPoll(id, { ok: false, error: 'LOGIN failed', errorKind: 'auth', at: NOW, nextPollAt: NOW });
    const res = await page('/przeglad');
    expect(res.body).toMatch(/Integracje z błędami<\/div>\s*<div class="n fail">1</);
    expect(res.body).toContain('1 integracja zgłosiła błąd');
    expect(res.body).toMatch(/Integracje<span class="ct">1<\/span><\/a>/);
  });

  it('bez błędów kafelek pokazuje zero bez ostrzeżenia', async () => {
    const res = await page('/przeglad');
    expect(res.body).toMatch(/Integracje z błędami<\/div>\s*<div class="n">0</);
    expect(res.body).not.toContain('zgłosiła błąd');
    expect(res.body).not.toContain('zgłosiły błąd');
  });
});
