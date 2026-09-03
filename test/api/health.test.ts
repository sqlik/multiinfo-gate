import { beforeEach, describe, expect, it } from 'vitest';
import { defaultInboundConfig } from '../../src/integrations/config.ts';
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

const seed = (name: string, enabled: 0 | 1) => h.integrations.insert({
  name, kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'uptime-kuma', enabled,
  config: defaultInboundConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
});

describe('GET /healthz - integracje', () => {
  it('wariant panelu podaje liczbę włączonych i z błędami w dobie', async () => {
    const troubled = seed('Kuma', 1);
    seed('Zabbix', 1);
    seed('Wyłączona', 0);
    h.integrationEvents.record({ integrationId: troubled, at: new Date(NOW.getTime() - 3_600_000), result: 'error', logLimit: 200 });
    const body = (await h.app.inject({ method: 'GET', url: '/healthz' })).json();
    expect(body.integrations).toEqual({ enabled: 2, troubled24h: 1 });
    // Błędy integracji nie pogarszają statusu - to sprawa aplikacji, nie bramki.
    expect(body.status).toBe('ok');
  });

  it('wariant bez szczegółów nie zdradza integracji', async () => {
    seed('Kuma', 1);
    const res = await h.app.inject({ method: 'GET', url: '/healthz', headers: { host: '10.10.10.159:8081' } });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('wariant panelu podaje nowsze wydanie, dopóki jest do pokazania', async () => {
    let body = (await h.app.inject({ method: 'GET', url: '/healthz' })).json();
    expect(body.release).toBeUndefined();
    h.settings.setLatestRelease({ version: '9.9.9', url: 'https://github.com/sqlik/multiinfo-gate/releases/tag/v9.9.9', publishedAt: null }, NOW);
    body = (await h.app.inject({ method: 'GET', url: '/healthz' })).json();
    expect(body.release).toEqual({ version: '9.9.9', url: 'https://github.com/sqlik/multiinfo-gate/releases/tag/v9.9.9' });
    expect(body.status).toBe('ok');
    const res = await h.app.inject({ method: 'GET', url: '/healthz', headers: { host: '10.10.10.159:8081' } });
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
