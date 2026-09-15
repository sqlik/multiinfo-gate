import { beforeEach, describe, expect, it } from 'vitest';
import { defaultInboundConfig, defaultOutboundConfig, type InboundConfig, type OutboundConfig } from '../../src/integrations/config.ts';
import { presetById, type Preset } from '../../src/integrations/presets/index.ts';
import { integrationFormPage, valuesFromPreset, type FormContext } from '../../src/admin/views/integrations.ts';
import { simpleFormPage } from '../../src/admin/views/integration-simple.ts';
import { simpleDefaults } from '../../src/admin/simple-form.ts';
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

const KUMA_TEMPLATE = presetById('uptime-kuma')!.inbound!.text!.mode === 'liquid' ? (presetById('uptime-kuma')!.inbound!.text as { template: string }).template : '';

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

  it('token w polu ładunku zapisuje się obok pozostałych warstw, a pusta wartość zostawia zapisany', async () => {
    const pola = { authHeaderName: '', authHeaderValue: '', authPayloadPath: 'api_token' };
    const res = await post('/integracje', inboundFields({ ...pola, authPayloadValue: 'tajne123' }));
    expect(res.statusCode).toBe(200);
    const row = h.integrations.list()[0]!;
    expect((row.config as InboundConfig).auth.payload).toEqual({ path: 'api_token', valueRef: 'payloadToken' });
    expect(h.integrations.secrets(row.id)).toEqual({ payloadToken: 'tajne123' });

    const form = await page(`/integracje/${row.id}/edytuj?tryb=zaawansowany`);
    expect(form.body).toContain('name="authPayloadPath"');
    expect(form.body).not.toContain('tajne123');

    const keep = await post(`/integracje/${row.id}/edytuj`, inboundFields({ ...pola, authPayloadValue: '' }));
    expect(keep.statusCode).toBe(302);
    expect(h.integrations.secrets(row.id)).toEqual({ payloadToken: 'tajne123' });

    // Pusta ścieżka zdejmuje warstwę i kasuje token, tak samo jak pusta nazwa nagłówka.
    await post(`/integracje/${row.id}/edytuj`, inboundFields({ ...pola, authPayloadPath: '', authPayloadValue: '' }));
    expect((h.integrations.get(row.id)!.config as InboundConfig).auth.payload).toBeUndefined();
    expect(h.integrations.secrets(row.id)).toEqual({});
  });

  it('token w polu ładunku: zła ścieżka oraz brak wartości to błędy formularza', async () => {
    const zla = await post('/integracje', inboundFields({ authPayloadPath: 'api..token', authPayloadValue: 'x' }));
    expect(zla.statusCode).toBe(400);
    expect(zla.body).toContain('Pole ładunku z tokenem');
    const bez = await post('/integracje', inboundFields({ authPayloadPath: 'api_token', authPayloadValue: '' }));
    expect(bez.statusCode).toBe(400);
    expect(bez.body).toContain('Podaj wartość tokenu');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('zapytanie uzupełniające zapisuje się z tokenem w parametrze adresu, a pusta wartość zostawia zapisany', async () => {
    const adres = 'https://firma.fakturownia.pl/clients/{{ p.deal.client.id }}.json';
    const res = await post('/integracje', inboundFields({ enrichUrl: adres, enrichToken: 'api456', enrichOnError: 'skip' }));
    expect(res.statusCode).toBe(200);
    const row = h.integrations.list()[0]!;
    const enrich = (row.config as InboundConfig).enrich;
    expect(enrich).toMatchObject({ url: adres, method: 'GET', query: [{ name: 'api_token', valueRef: 'enrichToken' }], as: 'e', onError: 'skip' });
    expect(h.integrations.secrets(row.id)).toMatchObject({ enrichToken: 'api456' });

    const keep = await post(`/integracje/${row.id}/edytuj`, inboundFields({ enrichUrl: adres, enrichToken: '', enrichOnError: 'skip' }));
    expect(keep.statusCode).toBe(302);
    expect(h.integrations.secrets(row.id)).toMatchObject({ enrichToken: 'api456' });

    // Pusty adres zdejmuje dopytanie i kasuje jego kod autoryzacyjny.
    await post(`/integracje/${row.id}/edytuj`, inboundFields({ enrichUrl: '', enrichToken: '' }));
    expect((h.integrations.get(row.id)!.config as InboundConfig).enrich).toBeUndefined();
    expect(h.integrations.secrets(row.id).enrichToken).toBeUndefined();
  });

  it('zapytanie uzupełniające: błąd składni w adresie oraz brak kodu autoryzacyjnego to błędy formularza', async () => {
    const zly = await post('/integracje', inboundFields({ enrichUrl: 'https://firma.fakturownia.pl/clients/{{ p.deal', enrichToken: 'x' }));
    expect(zly.statusCode).toBe(400);
    expect(zly.body).toContain('Adres zapytania uzupełniającego');
    const bez = await post('/integracje', inboundFields({ enrichUrl: 'https://firma.fakturownia.pl/clients/5.json', enrichToken: '' }));
    expect(bez.statusCode).toBe(400);
    expect(bez.body).toContain('kod autoryzacyjny');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('zapytanie uzupełniające: adres bez schematu http odpada już przy zapisie', async () => {
    // Odmowa przy zapisie, nie przy pierwszym webhooku: przy „pomiń wiadomość” zła konfiguracja
    // znaczy, że aplikacja dostaje 200, a SMS-a nie ma.
    for (const zly of ['firma.fakturownia.pl/clients/5.json', 'ftp://firma.fakturownia.pl/x', '/clients/5.json']) {
      const res = await post('/integracje', inboundFields({ enrichUrl: zly, enrichToken: 'x' }));
      expect(res.statusCode, zly).toBe(400);
      expect(res.body, zly).toContain('Adres zapytania uzupełniającego');
    }
    // Klamry szablonu nie przeszkadzają w sprawdzeniu.
    const dobry = await post('/integracje', inboundFields({ enrichUrl: 'https://firma.fakturownia.pl/clients/{{ p.id | url_encode }}.json', enrichToken: 'x' }));
    expect(dobry.statusCode).toBe(200);
    expect(h.integrations.list()).toHaveLength(1);
  });

  it('zapytanie uzupełniające: wyrażenie w nazwie serwera odpada przy zapisie', async () => {
    // Wartość z ładunku decydowałaby, dokąd pojedzie kod autoryzacyjny API administratora.
    const res = await post('/integracje', inboundFields({ enrichUrl: 'https://{{ p.account }}.aplikacja.pl/clients/5.json', enrichToken: 'x' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('nazw');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('błąd składni szablonu wraca do formularza z komunikatem i numerem linii, bez zapisu', async () => {
    const res = await post('/integracje', inboundFields({ textTemplate: 'Awaria\n{{ p.monitor.name' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Szablon treści');
    expect(res.body).toContain('linia 2');
    expect(res.body).toContain('name="textTemplate"');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('nowa integracja nie ma wpisanego adresu z wielokropkiem', async () => {
    // Slack, Teamsy oraz Bitrix24 trzymają w adresie wielokropek zamiast klucza webhooka. Jako
    // wartość początkowa dałby administratorowi pole, którego nie da się zapisać bez poprawki.
    for (const id of ['slack', 'teams', 'bitrix24']) {
      const preset = presetById(id);
      if (!preset) continue;
      const values = valuesFromPreset('webhook_out', preset);
      expect(values.url, id).not.toContain('…');
    }
  });

  it('adres z wielokropkiem do uzupełnienia nie przechodzi przez zapis', async () => {
    // Gotowe ustawienia Slacka, Teamsów oraz Bitrixa24 wstawiają w adres wielokropek w miejsce
    // klucza webhooka. Bez tego sprawdzenia zapisywał się jako adres, bo nie ma w nim odstępu.
    const res = await post('/integracje', outboundFields({ url: 'https://firma.bitrix24.pl/rest/1/…/batch.json' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('wielokropek');
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
    expect(res.body).toContain('AWARIA: Strona firmowa - Request failed with status code 403');
    expect(res.body).toContain('spełniony');
    expect(h.integrations.list()).toHaveLength(0);

    const skipped = await post('/integracje', inboundFields({ action: 'sprawdz', ruleValue: ['1', ''] }));
    expect(skipped.body).toContain('niespełniony');

    const bad = await post('/integracje', inboundFields({ action: 'sprawdz', sample: '{nie json' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('Próbka nie jest poprawnym JSON-em');
  });

  it('formularz tłumaczy dopytanie przykładem pola, a pola z odpowiedzi pokazuje bez przedrostka ładunku', async () => {
    const res = await page('/integracje/nowa?rodzaj=webhook_in&ustawienie=fakturownia-klient&tryb=zaawansowany');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('{{ e.mobile_phone }}');
    expect(res.body).toContain('tylko zamiast <code>p</code> piszesz <code>e</code>');
    // Lista pól ustawienia: pole z kartoteki bez „p.”, pole z faktury z „p.”
    expect(res.body).toContain('{{ e.name }}');
    expect(res.body).toContain('{{ p.deal.invoice_no }}');
    expect(res.body).not.toContain('{{ p.e.mobile_phone }}');
  });

  it('podgląd ustawienia z dopytaniem liczy odbiorcę z przykładowej odpowiedzi aplikacji', async () => {
    const preset = presetById('fakturownia-klient')!;
    const res = await post('/integracje', inboundFields({
      preset: preset.id, name: 'Faktury do klientów', action: 'sprawdz',
      authHeaderName: '', authHeaderValue: '', authPayloadPath: 'api_token', authPayloadValue: 'tajne123',
      enrichUrl: preset.inbound!.enrich!.url, enrichToken: 'api456', enrichOnError: 'skip',
      toPath: 'e.mobile_phone', toFallback: '', maxParts: '2',
      rulePath: ['deal.invoice_no', ''], ruleOp: ['exists', 'eq'], ruleValue: ['', ''],
      textTemplate: (preset.inbound!.text as { template: string }).template,
      sample: JSON.stringify(preset.sample),
    }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Podgląd z próbki');
    expect(res.body).toContain('48601000001');
    expect(res.body).toContain('przykładowej odpowiedzi');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('podgląd dopytania bez przykładowej odpowiedzi mówi, dlaczego pola spod e są puste', async () => {
    // Ustawienie własne z ręcznie wpisanym dopytaniem nie ma `enrichSample`, więc podgląd
    // pokazywałby pustego odbiorcę bez słowa wyjaśnienia.
    const res = await post('/integracje', inboundFields({
      action: 'sprawdz', preset: 'custom',
      enrichUrl: 'https://firma.aplikacja.pl/clients/{{ p.client_id | url_encode }}.json', enrichToken: 'api456', enrichOnError: 'skip',
      toPath: 'e.mobile_phone', toFallback: '',
    }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('nie ma przykładowej odpowiedzi');
    expect(res.body).not.toContain('Pola spod <code>e</code> pochodzą z przykładowej');
    expect(h.integrations.list()).toHaveLength(0);
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
    const res = await page(`/integracje/${id}/edytuj?tryb=zaawansowany`);
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

  it('przełącznik „pomiń” przeżywa edycję w formularzu zaawansowanym', async () => {
    const preset = presetById('woocommerce-klient')!;
    const sklepId = h.integrations.insert({
      name: 'Sklep', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: preset.id, enabled: 1,
      config: { ...defaultInboundConfig(), ...preset.inbound }, secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    const form = await page(`/integracje/${sklepId}/edytuj?tryb=zaawansowany`);
    expect(form.body).toContain('<option value="skip" selected>');

    // Formularz przebudowuje konfigurację od zera, więc bez pola w formularzu ustawienie by przepadło.
    await post(`/integracje/${sklepId}/edytuj`, inboundFields({ name: 'Sklep', preset: preset.id, invalidRecipient: 'skip' }));
    expect((h.integrations.get(sklepId)!.config as InboundConfig).invalidRecipient).toBe('skip');

    // Żądanie bez pola wraca do wartości domyślnej, czyli do błędu.
    await post(`/integracje/${sklepId}/edytuj`, inboundFields({ name: 'Sklep', preset: preset.id }));
    expect((h.integrations.get(sklepId)!.config as InboundConfig).invalidRecipient).toBe('error');
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

describe('ostrzeżenie gotowego ustawienia', () => {
  const bazowy = presetById('prosty-json')!;
  const zOstrzezeniem = { ...bazowy, warning: 'Klient zobaczy numer nadawcy' };
  const ctx = (preset: Preset): FormContext => ({
    kind: 'webhook_in', preset, keys: [{ id: 1, name: 'Klucz', accountName: 'Konto', serviceIds: ['24138'], origs: [] }],
    secretNames: [], apiUrl: null,
  });

  it('formularz zaawansowany pokazuje ostrzeżenie nad przyciskami', () => {
    const html = integrationFormPage(ctx(zOstrzezeniem), valuesFromPreset('webhook_in', zOstrzezeniem));
    expect(html).toContain('class="notice"');
    expect(html).toContain('Klient zobaczy numer nadawcy');
    expect(html.indexOf('class="notice"')).toBeLessThan(html.indexOf('value="zapisz"'));
  });

  it('formularz prosty pokazuje to samo ostrzeżenie', () => {
    const wartosci = valuesFromPreset('webhook_in', zOstrzezeniem);
    const html = simpleFormPage(ctx(zOstrzezeniem), simpleDefaults(zOstrzezeniem, wartosci, true), { textPreviews: {} });
    expect(html).toContain('Klient zobaczy numer nadawcy');
  });

  it('ustawienie bez ostrzeżenia nie rysuje ramki', () => {
    const html = integrationFormPage(ctx(bazowy), valuesFromPreset('webhook_in', bazowy));
    expect(html).not.toContain('class="notice"');
  });
});
