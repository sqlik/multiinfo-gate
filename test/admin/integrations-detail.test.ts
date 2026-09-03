import { beforeEach, describe, expect, it } from 'vitest';
import { defaultInboundConfig, defaultOutboundConfig } from '../../src/integrations/config.ts';
import { presetById } from '../../src/integrations/presets/index.ts';
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

function seedInbound(storePayloads: 0 | 1, name = 'Kuma produkcja'): number {
  const preset = presetById('uptime-kuma')!;
  return h.integrations.insert({
    name, kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: preset.id, enabled: 1,
    config: {
      ...defaultInboundConfig(), ...preset.inbound,
      auth: { header: { name: 'Authorization', valueRef: 'token' }, sources: ['203.0.113.0/24'] },
      to: { fallback: ['48601000001'] }, condition: { mode: 'builder', rules: [{ path: 'heartbeat.status', op: 'eq', value: '0' }] },
    },
    secrets: { token: 'Bearer x' }, storePayloads, createdAt: NOW,
  });
}

describe('GET /integracje/:id', () => {
  it('pokazuje konfigurację w słowach, adres wejściowy i dziennik z plakietkami', async () => {
    const id = seedInbound(1);
    const hookId = h.integrations.get(id)!.hookId!;
    h.integrationEvents.record({
      integrationId: id, at: new Date(NOW.getTime() - 60_000), result: 'sent', sourceIp: '203.0.113.7', messageId: 'msg_1',
      payload: '{"heartbeat":{"status":0},"monitor":{"name":"Strona"}}', logLimit: 200,
    });
    h.integrationEvents.record({
      integrationId: id, at: new Date(NOW.getTime() - 30_000), result: 'rejected', reason: 'nagłówek Authorization nie pasuje', sourceIp: '198.51.100.9', logLimit: 200,
    });
    const res = await page(`/integracje/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Kuma produkcja');
    expect(res.body).toContain(`/hooks/${hookId}`);
    expect(res.body).toContain('Authorization');
    expect(res.body).not.toContain('Bearer x');
    expect(res.body).toContain('203.0.113.0/24');
    expect(res.body).toContain('tylko gdy monitor przestanie działać');
    expect(res.body).toContain('10 zdarzeń na 10 minut');
    expect(res.body).toContain('wysłano');
    expect(res.body).toContain('odrzucono');
    expect(res.body).toContain('nagłówek Authorization nie pasuje');
    expect(res.body).toContain('href="/wiadomosci/msg_1"');
    expect(res.body).toContain('198.51.100.9');
    // Ładunek przechowany: rozwijany blok i „Użyj jako próbki”.
    expect(res.body).toContain('&quot;monitor&quot;');
    const eventId = h.integrationEvents.list(id, 10).find((e) => e.result === 'sent')!.id;
    expect(res.body).toContain(`href="/integracje/${id}/edytuj?probka=${eventId}"`);
    expect(res.body).toContain(`action="/integracje/${id}/wylacz"`);
    expect(res.body).toContain(`action="/integracje/${id}/usun"`);
  });

  it('ładunek pokazuje tylko, gdy przechowywany', async () => {
    const id = seedInbound(0);
    h.integrationEvents.record({ integrationId: id, at: NOW, result: 'error', reason: 'pusta treść', logLimit: 200 });
    const res = await page(`/integracje/${id}`);
    expect(res.body).toContain('pusta treść');
    expect(res.body).not.toContain('Użyj jako próbki');
    expect(res.body).toContain('Ładunki nieprzechowywane');
  });

  it('nazwy pól formularza wychodzącej są uciekane', async () => {
    const id = h.integrations.insert({
      name: 'Formularz', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
      config: { ...defaultOutboundConfig(), url: 'https://hook.example/x', body: { mode: 'form', fields: [{ name: '<img src=x onerror=alert(1)>', template: 'a' }] } },
      secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    const res = await page(`/integracje/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('formularz (&lt;img src=x onerror=alert(1)&gt;)');
  });

  it('„Użyj jako próbki” prowadzi do formularza z wypełnioną próbką', async () => {
    const id = seedInbound(1);
    h.integrationEvents.record({ integrationId: id, at: NOW, result: 'sent', payload: '{"monitor":{"name":"Z dziennika"}}', logLimit: 200 });
    const eventId = h.integrationEvents.list(id, 1)[0]!.id;
    const res = await page(`/integracje/${id}/edytuj?probka=${eventId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Z dziennika');
    // Cudzy wpis nie wchodzi do formularza.
    const other = seedInbound(1, 'Kuma druga');
    const foreign = await page(`/integracje/${other}/edytuj?probka=${eventId}`);
    expect(foreign.body).not.toContain('Z dziennika');
  });

  it('wychodząca: adres docelowy, zdarzenia, nagłówki bez sekretów i „Ponów” przy niedostarczonej', async () => {
    const id = h.integrations.insert({
      name: 'Helpdesk', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
      config: {
        ...defaultOutboundConfig(), url: 'https://helpdesk.example/api/tickets', method: 'PUT',
        headers: [{ name: 'X-Api-Key', valueRef: 'h0' }, { name: 'X-Source', value: 'bramka' }], responseRefPath: 'id',
      },
      secrets: { h0: 'klucz-api' }, storePayloads: 0, createdAt: NOW,
    });
    const deliveryId = h.deliveries.insert({
      apiKeyId, event: 'message.received', payload: '{"from":"48601000001"}', url: 'https://helpdesk.example/api/tickets',
      createdAt: NOW, inboundId: null, scrubAfter: false, integrationId: id, method: 'PUT', headers: {},
    });
    h.deliveries.markFailed(deliveryId, 'HTTP 500');
    h.integrationEvents.record({ integrationId: id, at: NOW, result: 'undelivered', reason: 'HTTP 500', deliveryId, inboundId: 'in_1', logLimit: 200 });
    const res = await page(`/integracje/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('PUT https://helpdesk.example/api/tickets');
    expect(res.body).toContain('message.received');
    expect(res.body).toContain('X-Api-Key');
    expect(res.body).toContain('X-Source: bramka');
    expect(res.body).not.toContain('klucz-api');
    expect(res.body).toContain('niedostarczone');
    expect(res.body).toContain('href="/odebrane/in_1"');
    expect(res.body).toContain(`action="/dostawy/${deliveryId}/ponow"`);
  });

  it('nieistniejąca integracja to 404', async () => {
    expect((await page('/integracje/999')).statusCode).toBe(404);
  });
});
