import { beforeEach, describe, expect, it } from 'vitest';
import { defaultInboundConfig, defaultOutboundConfig, type InboundConfig, type OutboundConfig } from '../../src/integrations/config.ts';
import { presetById } from '../../src/integrations/presets/index.ts';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-08-25T10:00:00Z');

let h: AdminHarness;
let accountId: number;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Monitoring NOC', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4',
    defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
});

const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

/** Pola powtórzone (reguły, nagłówki) jako tablice - URLSearchParams powtarza klucz. */
const post = (url: string, fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
  return h.app.inject({
    method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: params.toString(),
  });
};

const KUMA_TEMPLATE = '{% if p.heartbeat.status == 0 %}AWARIA{% else %}OK{% endif %}: {{ p.monitor.name }} - {{ p.heartbeat.msg | sms_truncate: 100 }}';

const inboundFields = (over: Record<string, string | string[]> = {}): Record<string, string | string[]> => ({
  kind: 'webhook_in', preset: 'uptime-kuma', name: 'Kuma produkcja', apiKeyId: String(apiKeyId), serviceId: '', orig: '', enabled: '1',
  authHeaderName: 'Authorization', authHeaderValue: 'Bearer tajny-token', authBasicUser: '', authBasicPass: '', sources: '',
  conditionMode: 'builder', rulePath: ['heartbeat.status', ''], ruleOp: ['eq', 'eq'], ruleValue: ['0', ''], conditionExpr: '',
  toPath: '', toFallback: '601000001\n+48 602 000 002', ticketRefPath: '', eventIdPath: '',
  textMode: 'liquid', textTemplate: KUMA_TEMPLATE, textPath: '', maxParts: '1', overflow: 'truncate',
  throttleLimit: '10', throttleWindow: '10', eventLogLimit: '200',
  sample: JSON.stringify(presetById('uptime-kuma')!.sample), action: 'zapisz', ...over,
});

const outboundFields = (over: Record<string, string | string[]> = {}): Record<string, string | string[]> => ({
  kind: 'webhook_out', preset: 'custom', name: 'Helpdesk z SMS-a', apiKeyId: String(apiKeyId), serviceId: '', orig: '', enabled: '1',
  url: 'https://helpdesk.example/api/tickets', method: 'POST',
  headerName: ['X-Api-Key', 'X-Source', ''], headerValue: ['klucz-api', 'bramka', ''], headerSecret: ['1', '0', '0'],
  events: ['message.received'], conditionMode: 'builder', rulePath: [''], ruleOp: ['eq'], ruleValue: [''], conditionExpr: '',
  bodyMode: 'json', bodyTemplate: '{"from": {{ from | json }}, "text": {{ text | json }}}', formFieldName: [''], formFieldTemplate: [''],
  responseRefPath: 'id', throttleLimit: '10', throttleWindow: '10', eventLogLimit: '200',
  sample: '{"event": "message.received", "from": "48601000001", "text": "Pomocy"}', action: 'zapisz', ...over,
});

describe('POST /integracje', () => {
  it('tworzy przychodzącą z ustawienia i pokazuje adres wejściowy raz na liście', async () => {
    const res = await post('/integracje', inboundFields());
    expect(res.statusCode).toBe(200);
    const row = h.integrations.list()[0]!;
    expect(row.kind).toBe('webhook_in');
    expect(row.hookId).toHaveLength(32);
    expect(res.body).toContain(`/hooks/${row.hookId}`);
    expect(res.body).toContain('data-copy');
    const config = row.config as InboundConfig;
    expect(config.auth.header).toEqual({ name: 'Authorization', valueRef: 'token' });
    expect(config.condition).toEqual({ mode: 'builder', rules: [{ path: 'heartbeat.status', op: 'eq', value: '0' }] });
    expect(config.to.fallback).toEqual(['601000001', '+48 602 000 002']);
    expect(config.text).toEqual({ mode: 'liquid', template: KUMA_TEMPLATE });
    expect(h.integrations.secrets(row.id)).toEqual({ token: 'Bearer tajny-token' });
    expect(h.refreshed).toEqual([{ retryAccount: accountId }]);
    // Lista bez ramki przy kolejnym wejściu.
    const list = await page('/integracje');
    expect(list.body).not.toContain(`/hooks/${row.hookId}`);
  });

  it('tworzy wychodzącą z sekretnym nagłówkiem i wraca na listę', async () => {
    const res = await post('/integracje', outboundFields());
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/integracje');
    const row = h.integrations.list()[0]!;
    const config = row.config as OutboundConfig;
    expect(config.headers).toEqual([{ name: 'X-Api-Key', valueRef: 'h0' }, { name: 'X-Source', value: 'bramka' }]);
    expect(config.responseRefPath).toBe('id');
    expect(h.integrations.secrets(row.id)).toEqual({ h0: 'klucz-api' });
    expect(row.hookId).toBeNull();
  });

  it('błąd składni szablonu wraca do formularza z komunikatem i numerem linii, bez zapisu', async () => {
    const res = await post('/integracje', inboundFields({ textTemplate: 'Awaria\n{{ p.monitor.name' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Szablon treści');
    expect(res.body).toContain('linia 2');
    expect(res.body).toContain('name="textTemplate"');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('adres wychodzący w sieci wewnętrznej bez zgody to błąd formularza', async () => {
    h.resolve.value = async () => ['192.168.1.20'];
    const res = await post('/integracje', outboundFields({ url: 'https://helpdesk.local/api' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('sieć wewnętrzną');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('lista źródeł z niepoprawnym wpisem to błąd', async () => {
    const res = await post('/integracje', inboundFields({ sources: '203.0.113.7\nnie adres!' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('nie adres!');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('druga integracja o tej samej nazwie przy tym kluczu to błąd formularza', async () => {
    await post('/integracje', inboundFields());
    const res = await post('/integracje', inboundFields());
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('o tej nazwie już istnieje');
    expect(h.integrations.list()).toHaveLength(1);
  });

  it('usługa spoza klucza i pusty token to błędy', async () => {
    expect((await post('/integracje', inboundFields({ serviceId: '99999' }))).body).toContain('99999');
    const res = await post('/integracje', inboundFields({ authHeaderValue: '' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Podaj wartość nagłówka');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('action=sprawdz renderuje podgląd: numery, treść, części, warunek - bez zapisu', async () => {
    const res = await post('/integracje', inboundFields({ action: 'sprawdz' }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Podgląd z próbki');
    expect(res.body).toContain('48601000001, 48602000002');
    expect(res.body).toContain('AWARIA: Strona firmowa - timeout of 48000ms exceeded');
    expect(res.body).toContain('spełniony');
    expect(h.integrations.list()).toHaveLength(0);

    const skipped = await post('/integracje', inboundFields({ action: 'sprawdz', ruleValue: ['1', ''] }));
    expect(skipped.body).toContain('niespełniony');

    const bad = await post('/integracje', inboundFields({ action: 'sprawdz', sample: '{nie json' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('Próbka nie jest poprawnym JSON-em');
  });

  it('podgląd wychodzącej pokazuje nagłówki z zamaskowanym sekretem i body', async () => {
    const res = await post('/integracje', outboundFields({ action: 'sprawdz' }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('X-Api-Key: ••••');
    expect(res.body).not.toContain('klucz-api');
    expect(res.body).toContain('&quot;from&quot;: &quot;48601000001&quot;');
  });

  it('zapis idzie do audytu bez sekretów', async () => {
    await post('/integracje', inboundFields());
    const entry = h.audit.list(10, 0).find((e) => e.action === 'integracja.utworzenie');
    expect(entry).toBeTruthy();
    expect(entry!.actor).toBe('janek');
    expect(JSON.stringify(entry)).not.toContain('tajny-token');
    expect(JSON.stringify(entry!.meta)).toContain('Kuma produkcja');
  });
});

describe('edycja', () => {
  let id: number;
  beforeEach(() => {
    const preset = presetById('uptime-kuma')!;
    id = h.integrations.insert({
      name: 'Kuma', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: preset.id, enabled: 1,
      config: { ...defaultInboundConfig(), ...preset.inbound }, secrets: { token: 'Bearer stary' }, storePayloads: 0, createdAt: NOW,
    });
  });

  it('formularz edycji pokazuje adres wejściowy i nie pokazuje sekretu', async () => {
    const res = await page(`/integracje/${id}/edytuj`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`/hooks/${h.integrations.get(id)!.hookId}`);
    expect(res.body).not.toContain('Bearer stary');
    expect(res.body).toContain('Token jest zapisany');
  });

  it('puste pole sekretu zostawia dotychczasowy; pusta nazwa nagłówka kasuje', async () => {
    const keep = await post(`/integracje/${id}/edytuj`, inboundFields({ name: 'Kuma 2', authHeaderValue: '' }));
    expect(keep.statusCode).toBe(302);
    expect(keep.headers.location).toBe(`/integracje/${id}`);
    expect(h.integrations.get(id)!.name).toBe('Kuma 2');
    expect(h.integrations.secrets(id)).toEqual({ token: 'Bearer stary' });

    await post(`/integracje/${id}/edytuj`, inboundFields({ authHeaderName: '', authHeaderValue: '' }));
    expect(h.integrations.secrets(id)).toEqual({});
    expect((h.integrations.get(id)!.config as InboundConfig).auth.header).toBeUndefined();
    const entry = h.audit.list(10, 0).find((e) => e.action === 'integracja.edycja');
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry!.meta)).toContain('auth');
  });

  it('sekretny nagłówek wychodzącej przenosi się przy edycji bez wartości', async () => {
    const outId = h.integrations.insert({
      name: 'Helpdesk', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
      config: { ...defaultOutboundConfig(), url: 'https://helpdesk.example/api', headers: [{ name: 'X-Api-Key', valueRef: 'h0' }] },
      secrets: { h0: 'klucz-api' }, storePayloads: 0, createdAt: NOW,
    });
    const res = await post(`/integracje/${outId}/edytuj`, outboundFields({
      headerName: ['X-Source', 'X-Api-Key'], headerValue: ['bramka', ''], headerSecret: ['0', '1'],
    }));
    expect(res.statusCode).toBe(302);
    const config = h.integrations.get(outId)!.config as OutboundConfig;
    expect(config.headers).toEqual([{ name: 'X-Source', value: 'bramka' }, { name: 'X-Api-Key', valueRef: 'h1' }]);
    expect(h.integrations.secrets(outId)).toEqual({ h1: 'klucz-api' });
  });

  it('nowy-adres unieważnia stary i pokazuje nowy', async () => {
    const before = h.integrations.get(id)!.hookId!;
    const res = await post(`/integracje/${id}/nowy-adres`, {});
    expect(res.statusCode).toBe(200);
    const after = h.integrations.get(id)!.hookId!;
    expect(after).not.toBe(before);
    expect(res.body).toContain(`/hooks/${after}`);
    expect(res.body).not.toContain(before);
    expect(h.audit.list(10, 0).some((e) => e.action === 'integracja.nowy_adres')).toBe(true);
  });

  it('wlacz/wylacz i usun wołają receiver.refresh', async () => {
    const off = await post(`/integracje/${id}/wylacz`, {});
    expect(off.statusCode).toBe(302);
    expect(h.integrations.get(id)!.enabled).toBe(0);
    await post(`/integracje/${id}/wlacz`, {});
    expect(h.integrations.get(id)!.enabled).toBe(1);
    const gone = await post(`/integracje/${id}/usun`, {});
    expect(gone.headers.location).toBe('/integracje');
    expect(h.integrations.get(id)).toBeUndefined();
    expect(h.refreshed).toHaveLength(3);
    const actions = h.audit.list(10, 0).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['integracja.wylaczenie', 'integracja.wlaczenie', 'integracja.usuniecie']));
  });

  it('edycja nieistniejącej to 404', async () => {
    expect((await page('/integracje/999/edytuj')).statusCode).toBe(404);
    expect((await post('/integracje/999/wlacz', {})).statusCode).toBe(404);
  });
});
