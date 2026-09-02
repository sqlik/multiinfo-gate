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

function seedInbound(name = 'Kuma produkcja'): number {
  const preset = presetById('uptime-kuma')!;
  return h.integrations.insert({
    name, kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: preset.id, enabled: 1,
    config: { ...defaultInboundConfig(), ...preset.inbound }, secrets: { token: 'Bearer x' }, storePayloads: 0, createdAt: NOW,
  });
}

describe('GET /integracje', () => {
  it('pokazuje listę z rodzajem, ustawieniem, kluczem i stanem', async () => {
    const id = seedInbound();
    h.integrationEvents.record({ integrationId: id, at: new Date(NOW.getTime() - 3_600_000), result: 'error', reason: 'pusta treść', logLimit: 200 });
    h.integrationEvents.record({ integrationId: id, at: new Date(NOW.getTime() - 60_000), result: 'sent', logLimit: 200 });
    const res = await page('/integracje');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Kuma produkcja');
    expect(res.body).toContain('do SMS');
    expect(res.body).toContain('Uptime Kuma');
    expect(res.body).toContain('Monitoring NOC');
    expect(res.body).toContain('dot-fail');
    expect(res.body).toContain(`href="/integracje/${id}"`);
    // 24 h: jedna wysłana, jeden błąd; ostatnie zdarzenie to „wysłano”.
    expect(res.body).toMatch(/1 \/ <span class="fail">1<\/span>/);
    expect(res.body).toContain('wysłano');
  });

  it('bez błędów w dobie pokazuje stan włączona, a wyłączona jest przygaszona', async () => {
    const id = seedInbound('Kuma test');
    h.integrations.setEnabled(id, false, NOW);
    const res = await page('/integracje');
    expect(res.body).toContain('dot-dim');
    expect(res.body).toContain('wyłączona');
    expect(res.body).not.toContain('dot-fail');
  });

  it('filtruje po rodzaju i kluczu', async () => {
    seedInbound('Kuma');
    h.integrations.insert({
      name: 'FreeScout z SMS-a', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'freescout', enabled: 1,
      config: { ...defaultOutboundConfig(), url: 'https://freescout.example/api/conversations' }, secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    const out = await page('/integracje?rodzaj=out');
    expect(out.body).toContain('FreeScout z SMS-a');
    expect(out.body).not.toContain('>Kuma<');
    const byKey = await page('/integracje?klucz=999');
    expect(byKey.body).toContain('Brak integracji');
  });

  it('plakietka w nawigacji liczy integracje z błędami w dobie', async () => {
    const id = seedInbound();
    h.integrationEvents.record({ integrationId: id, at: new Date(NOW.getTime() - 3_600_000), result: 'rejected', reason: 'token', logLimit: 200 });
    // Stary błąd innej integracji nie liczy się.
    const old = seedInbound('Stara');
    h.integrationEvents.record({ integrationId: old, at: new Date(NOW.getTime() - 48 * 3_600_000), result: 'error', logLimit: 200 });
    const res = await page('/przeglad');
    expect(res.body).toContain('Integracje<span class="ct">1</span>');
    expect(res.body).toContain('href="/powiadomienia"');
  });
});

describe('GET /integracje/nowa', () => {
  it('wybór kierunku, potem kafelki ustawień, potem formularz', async () => {
    const kind = await page('/integracje/nowa');
    expect(kind.statusCode).toBe(200);
    expect(kind.body).toContain('href="/integracje/nowa?rodzaj=webhook_in"');
    expect(kind.body).toContain('href="/integracje/nowa?rodzaj=webhook_out"');

    const presets = await page('/integracje/nowa?rodzaj=webhook_in');
    expect(presets.body).toContain('Uptime Kuma');
    expect(presets.body).toContain('href="/integracje/nowa?rodzaj=webhook_in&amp;ustawienie=uptime-kuma"');
    // „Własne” zawsze na końcu kafelków; Slack jest tylko wychodzący.
    expect(presets.body.indexOf('>Własne<')).toBeGreaterThan(presets.body.indexOf('>Uptime Kuma<'));
    expect(presets.body).not.toContain('>Slack<');

    // Gotowe ustawienie otwiera się w trybie prostym; pola silnika dopiero po przełączeniu.
    const simple = await page('/integracje/nowa?rodzaj=webhook_in&ustawienie=uptime-kuma');
    expect(simple.statusCode).toBe(200);
    expect(simple.body).toContain('Kiedy wysyłać SMS');
    expect(simple.body).not.toContain('name="textTemplate"');
    const form = await page('/integracje/nowa?rodzaj=webhook_in&ustawienie=uptime-kuma&tryb=zaawansowany');
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('name="textTemplate"');
    expect(form.body).toContain('{{ p.monitor.name }}');
    expect(form.body).toContain('name="authHeaderValue"');
    expect(form.body).toContain('Monitoring NOC');
    expect(form.body).toContain('name="sample"');
    expect(form.body).toContain('Strona firmowa');
    expect(form.body).toContain('value="sprawdz"');
  });

  it('formularz wychodzącej ma adres, zdarzenia i body', async () => {
    const form = await page('/integracje/nowa?rodzaj=webhook_out&ustawienie=freescout&tryb=zaawansowany');
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('name="url"');
    expect(form.body).toContain('freescout.example');
    expect(form.body).toContain('name="events"');
    expect(form.body).toContain('name="bodyTemplate"');
    expect(form.body).toContain('X-FreeScout-API-Key');
  });

  it('nieznane ustawienie albo rodzaj to 404', async () => {
    expect((await page('/integracje/nowa?rodzaj=webhook_in&ustawienie=nieistnieje')).statusCode).toBe(404);
    expect((await page('/integracje/nowa?rodzaj=inny')).statusCode).toBe(404);
    // Slack nie ma wariantu przychodzącego.
    expect((await page('/integracje/nowa?rodzaj=webhook_in&ustawienie=slack')).statusCode).toBe(404);
  });
});
