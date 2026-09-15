import { beforeEach, describe, expect, it } from 'vitest';
import { defaultInboundConfig, defaultOutboundConfig, type InboundConfig, type OutboundConfig } from '../../src/integrations/config.ts';
import { presetById } from '../../src/integrations/presets/index.ts';
import { detectSimple, simpleDefaults, simpleToValues, transformSecret, type SimpleValues } from '../../src/admin/simple-form.ts';
import { simpleFormPage } from '../../src/admin/views/integration-simple.ts';
import type { Preset } from '../../src/integrations/presets/types.ts';
import { valuesFromPreset, type FormContext } from '../../src/admin/views/integrations.ts';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
let h: AdminHarness;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW, { allowPrivateWebhooks: true });
  const accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Monitoring', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 5, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
});

const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string, fields: Record<string, string>) => h.app.inject({
  method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString(),
});

const kuma = (over: Record<string, string> = {}) => ({
  kind: 'webhook_in', preset: 'uptime-kuma', tryb: 'prosty', name: 'Kuma - strony', apiKeyId: String(apiKeyId), enabled: '1',
  numbers: '601 000 001\n+48 602 000 002', whenId: 'awaria', textId: 'z-komunikatem', secret: 'tajne-haslo', action: 'zapisz', ...over,
});

describe('tryb prosty: przychodząca', () => {
  it('formularz Uptime Kumy pokazuje listy w języku użytkownika, podgląd każdej treści i ani jednej ścieżki', async () => {
    const res = await page('/integracje/nowa?rodzaj=webhook_in&ustawienie=uptime-kuma');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Kto ma dostać SMS');
    expect(res.body).toContain('tylko gdy monitor przestanie działać');
    expect(res.body).toContain('AWARIA: Strona firmowa - Request failed with status code 403');
    expect(res.body).toContain('AWARIA: Strona firmowa<');
    expect(res.body).toContain('data-generate="#secret"');
    expect(res.body).toContain('tryb=zaawansowany');
    expect(res.body).not.toContain('Ścieżka');
    expect(res.body).not.toContain('Liquid');
  });

  it('zapis z list daje tę samą konfigurację, co formularz zaawansowany, z tokenem Bearer i numerami', async () => {
    h.settings.setApiUrl('https://sms.firma.pl', NOW);
    const res = await post('/integracje', kuma());
    expect(res.statusCode).toBe(200);
    const row = h.integrations.list()[0]!;
    const config = row.config as InboundConfig;
    expect(config.condition).toEqual({ mode: 'builder', rules: [{ path: 'heartbeat.status', op: 'eq', value: '0' }] });
    expect(config.text).toEqual(presetById('uptime-kuma')!.inbound!.text);
    expect(config.to.fallback).toEqual(['601 000 001', '+48 602 000 002']);
    expect(config.auth.header).toEqual({ name: 'Authorization', valueRef: 'token' });
    expect(h.integrations.secrets(row.id)).toEqual({ token: 'Bearer tajne-haslo' });
    // Ramka po zapisie: pełny adres, gdzie go wkleić i instrukcja krok po kroku.
    expect(res.body).toContain(`https://sms.firma.pl/hooks/${row.hookId}`);
    expect(res.body).toContain('w Uptime Kumie w polu Post URL');
    expect(res.body).toContain('Krok po kroku: Uptime Kuma');
    expect(res.body).not.toContain('```');
  });

  it('brak numerów przy ustawieniu bez numerów w ładunku to błąd w prostym formularzu, bez zapisu', async () => {
    const res = await post('/integracje', kuma({ numbers: '' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Podaj przynajmniej jeden numer telefonu');
    expect(res.body).toContain('Kiedy wysyłać SMS');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('Grafana: basic auth z loginem grafana; Zabbix: numery zapasowe, bo numer idzie z ładunku', async () => {
    await post('/integracje', { kind: 'webhook_in', preset: 'grafana', tryb: 'prosty', name: 'Grafana', apiKeyId: String(apiKeyId), enabled: '1', numbers: '601000001', whenId: 'alarm-i-powrot', textId: 'z-opisem', secret: 'haslo-grafany', action: 'zapisz' });
    const grafana = h.integrations.list().find((r) => r.name === 'Grafana')!;
    expect((grafana.config as InboundConfig).auth.basic).toEqual({ user: 'grafana', passRef: 'basicPass' });
    expect((grafana.config as InboundConfig).condition).toEqual({ mode: 'builder', rules: [] });
    expect(h.integrations.secrets(grafana.id)).toEqual({ basicPass: 'haslo-grafany' });
    const res = await post('/integracje', { kind: 'webhook_in', preset: 'zabbix', tryb: 'prosty', name: 'Zabbix', apiKeyId: String(apiKeyId), enabled: '1', numbers: '', whenId: 'problem', textId: 'temat', secret: 'haslo-zabbiksa', action: 'zapisz' });
    expect(res.statusCode).toBe(200);
    const zabbix = h.integrations.list().find((r) => r.name === 'Zabbix')!;
    expect((zabbix.config as InboundConfig).to).toEqual({ path: 'to', fallback: [] });
    expect((zabbix.config as InboundConfig).eventIdPath).toBe('eventId');
  });

  it('edycja: prosty otwiera się z zaznaczonymi wyborami; puste hasło zostawia zapisane; szczegół mówi słowami', async () => {
    await post('/integracje', kuma({ whenId: 'awaria-i-powrot', textId: 'krotko' }));
    const row = h.integrations.list()[0]!;
    const edit = await page(`/integracje/${row.id}/edytuj`);
    expect(edit.body).toContain('value="awaria-i-powrot" checked');
    expect(edit.body).toContain('value="krotko" checked');
    expect(edit.body).toContain('zapisane - puste pole zostawia dotychczasowe');
    const saved = await post(`/integracje/${row.id}/edytuj`, kuma({ whenId: 'zawsze', textId: 'krotko', secret: '', numbers: '603000003' }));
    expect(saved.statusCode).toBe(302);
    const after = h.integrations.get(row.id)!;
    expect((after.config as InboundConfig).condition).toEqual({ mode: 'builder', rules: [] });
    expect((after.config as InboundConfig).to.fallback).toEqual(['603000003']);
    expect(h.integrations.secrets(row.id)).toEqual({ token: 'Bearer tajne-haslo' });
    const detail = await page(`/integracje/${row.id}`);
    expect(detail.body).toContain('Kiedy SMS');
    expect(detail.body).toContain('zawsze, także przy przycisku „Test” w Uptime Kumie');
    expect(detail.body).toContain('tylko stan i nazwa monitora');
  });

  it('konfiguracja spoza list (własny szablon) otwiera zaawansowany z wyjaśnieniem, także na prośbę o prosty', async () => {
    await post('/integracje', kuma());
    const row = h.integrations.list()[0]!;
    h.integrations.update(row.id, {
      name: row.name, serviceId: null, orig: null, preset: row.preset, enabled: 1, storePayloads: 0,
      config: { ...(row.config as InboundConfig), text: { mode: 'liquid', template: 'Własny: {{ p.msg }}' } },
    }, NOW);
    const res = await page(`/integracje/${row.id}/edytuj?tryb=prosty`);
    expect(res.body).toContain('spoza list trybu prostego');
    expect(res.body).toContain('name="textTemplate"');
    const detail = await page(`/integracje/${row.id}`);
    expect(detail.body).toContain('Warunek');
    expect(detail.body).not.toContain('Kiedy SMS');
  });

  it('Własne nie ma trybu prostego - od razu zaawansowany, bez przełącznika', async () => {
    const res = await page('/integracje/nowa?rodzaj=webhook_in&ustawienie=custom');
    expect(res.body).toContain('name="textTemplate"');
    expect(res.body).not.toContain('tryb=prosty');
  });
});

describe('tryb prosty: wychodząca', () => {
  it('FreeScout: adres, klucz API i numer skrzynki wchodzą w szablon; Freshdesk: klucz zamienia się na nagłówek Basic', async () => {
    const fs = await post('/integracje', {
      kind: 'webhook_out', preset: 'freescout', tryb: 'prosty', name: 'FreeScout', apiKeyId: String(apiKeyId), enabled: '1',
      url: 'https://pomoc.firma.pl/api/conversations', secret_apiKey: 'klucz-fs', param_mailboxId: '7', action: 'zapisz',
    });
    expect(fs.statusCode).toBe(302);
    const row = h.integrations.list().find((r) => r.name === 'FreeScout')!;
    const config = row.config as OutboundConfig;
    expect(config.url).toBe('https://pomoc.firma.pl/api/conversations');
    expect((config.body as { template: string }).template).toContain('"mailboxId": 7');
    expect(config.headers).toEqual([{ name: 'X-FreeScout-API-Key', valueRef: 'h0' }]);
    expect(h.integrations.secrets(row.id)).toEqual({ h0: 'klucz-fs' });
    expect(detectSimple(presetById('freescout')!, 'webhook_out', valuesFromPreset('webhook_out', presetById('freescout')!))).toEqual({ params: { mailboxId: '1' } });
    const edit = await page(`/integracje/${row.id}/edytuj`);
    expect(edit.body).toContain('name="param_mailboxId" value="7"');

    const fd = await post('/integracje', {
      kind: 'webhook_out', preset: 'freshdesk', tryb: 'prosty', name: 'Freshdesk', apiKeyId: String(apiKeyId), enabled: '1',
      url: 'https://firma.freshdesk.com/api/v2/tickets', secret_authorization: 'abc123', action: 'zapisz',
    });
    expect(fd.statusCode).toBe(302);
    const fdRow = h.integrations.list().find((r) => r.name === 'Freshdesk')!;
    expect(h.integrations.secrets(fdRow.id)).toEqual({ h0: transformSecret('basic-x', 'abc123') });
    expect(transformSecret('basic-x', 'abc123')).toBe(`Basic ${Buffer.from('abc123:X').toString('base64')}`);
  });

  it('brak numeru skrzynki i zły numer to błędy w prostym formularzu', async () => {
    const empty = await post('/integracje', { kind: 'webhook_out', preset: 'freescout', tryb: 'prosty', name: 'FS', apiKeyId: String(apiKeyId), enabled: '1', url: 'https://pomoc.firma.pl/api/conversations', secret_apiKey: 'k', param_mailboxId: '', action: 'zapisz' });
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toContain('numer skrzynki');
    const bad = await post('/integracje', { kind: 'webhook_out', preset: 'freescout', tryb: 'prosty', name: 'FS', apiKeyId: String(apiKeyId), enabled: '1', url: 'https://pomoc.firma.pl/api/conversations', secret_apiKey: 'k', param_mailboxId: 'abc', action: 'zapisz' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('podaj liczbę');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('Fakturownia dla klienta: prosty formularz pyta o konto i kod API, zapis składa adres zapytania', async () => {
    const formularz = await page('/integracje/nowa?rodzaj=webhook_in&ustawienie=fakturownia-klient');
    expect(formularz.statusCode).toBe(200);
    expect(formularz.body).toContain('Nazwa Twojego konta w Fakturowni');
    expect(formularz.body).toContain('Kod autoryzacyjny API');
    expect(formularz.body).toContain('Token, który Fakturownia wyśle w treści');
    // Znacznik nazwy konta pojawia się wyłącznie w instrukcji, przy zdaniu o trybie zaawansowanym.
    expect(formularz.body).not.toContain('value="NAZWA-KONTA"');
    expect(formularz.body).not.toContain('Ścieżka numeru');

    const res = await post('/integracje', {
      kind: 'webhook_in', preset: 'fakturownia-klient', tryb: 'prosty', name: 'Faktury do klientów',
      apiKeyId: String(apiKeyId), enabled: '1', numbers: '', whenId: 'wystawienie', textId: 'nabywca-numer-odnosnik',
      secret: 'tajne123', account: 'firma', enrichSecret: 'api456', action: 'zapisz',
    });
    expect(res.statusCode).toBe(200);
    const row = h.integrations.list()[0]!;
    const config = row.config as InboundConfig;
    expect(config.enrich?.url).toBe('https://firma.fakturownia.pl/clients/{{ p.deal.client.external_ids.fakturownia }}.json');
    expect(config.enrich?.query).toEqual([{ name: 'api_token', valueRef: 'enrichToken' }]);
    expect(config.auth.payload).toEqual({ path: 'api_token', valueRef: 'payloadToken' });
    expect(config.to.path).toBe('e.mobile_phone');
    expect(h.integrations.secrets(row.id)).toEqual({ payloadToken: 'tajne123', enrichToken: 'api456' });

    // Edycja wraca do trybu prostego z nazwą konta wyjętą z zapisanego adresu.
    const edycja = await page(`/integracje/${row.id}/edytuj`);
    expect(edycja.body).toContain('value="firma"');
    expect(edycja.body).toContain('Nazwa Twojego konta w Fakturowni');
    expect(edycja.body).toContain('zapisany - puste pole zostawia dotychczasowy');
  });

  it('Fakturownia dla klienta: brak nazwy konta oraz nazwa z ukośnikiem to błędy prostego formularza', async () => {
    const pola = {
      kind: 'webhook_in', preset: 'fakturownia-klient', tryb: 'prosty', name: 'Faktury', apiKeyId: String(apiKeyId), enabled: '1',
      numbers: '', whenId: 'wystawienie', textId: 'nabywca-numer-odnosnik', secret: 'tajne123', enrichSecret: 'api456', action: 'zapisz',
    };
    const bez = await post('/integracje', { ...pola, account: '' });
    expect(bez.statusCode).toBe(400);
    expect(bez.body).toContain('nazwa twojego konta w fakturowni');
    const zla = await post('/integracje', { ...pola, account: 'firma.fakturownia.pl/klienci' });
    expect(zla.statusCode).toBe(400);
    expect(zla.body).toContain('małe litery');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('tryb prosty składa token w polu ładunku i rozpoznaje go przy edycji', () => {
    // Ustawienie próbne, bo katalog dostaje pierwszą taką aplikację dopiero z Fakturownią.
    const base = presetById('uptime-kuma')!;
    const preset: Preset = {
      ...base, id: 'proba-token-w-ladunku',
      inbound: { ...base.inbound, auth: { sources: [], payload: { path: 'api_token', valueRef: 'payloadToken' } } },
      simple: { inbound: { ...base.simple!.inbound!, auth: { kind: 'payload', path: 'api_token', label: 'Token, który aplikacja wyśle w treści', where: 'w aplikacji w polu Api token' } } },
    };
    const values = valuesFromPreset('webhook_in', preset);
    const sv: SimpleValues = {
      name: 'Proba', apiKeyId: String(apiKeyId), enabled: true, numbers: '601 000 001',
      whenId: 'awaria', textId: 'z-komunikatem', secret: 'tajne123', url: '', secrets: {}, params: {},
    };
    const out = simpleToValues('webhook_in', preset, sv, values);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.values.authPayloadPath).toBe('api_token');
    expect(out.values.authPayloadValue).toBe('tajne123');
    expect(out.values.authHeaderName).toBe('');
    expect(out.values.authBasicUser).toBe('');
    expect(detectSimple(preset, 'webhook_in', out.values)).toEqual({ whenId: 'awaria', textId: 'z-komunikatem' });
    // Zmiana ścieżki w trybie zaawansowanym wypycha formularz z trybu prostego.
    expect(detectSimple(preset, 'webhook_in', { ...out.values, authPayloadPath: 'token' })).toBeNull();
  });

  it('tryb prosty składa zapytanie uzupełniające z nazwy konta oraz kodu autoryzacyjnego', () => {
    // Ustawienie próbne, bo pierwszą aplikacją z dopytaniem jest Fakturownia dla klienta.
    const base = presetById('uptime-kuma')!;
    const preset: Preset = {
      ...base, id: 'proba-dopytanie',
      inbound: {
        ...base.inbound, to: { path: 'e.mobile_phone', fallback: [] },
        enrich: {
          url: 'https://NAZWA-KONTA.aplikacja.pl/clients/{{ p.client_id }}.json', method: 'GET', headers: [],
          query: [{ name: 'api_token', valueRef: 'enrichToken' }], timeoutMs: 2000, as: 'e', onError: 'skip',
        },
      },
      simple: {
        inbound: {
          ...base.simple!.inbound!,
          recipients: { source: 'payload', note: 'SMS idzie na numer z kartoteki klienta' },
          enrich: {
            secretLabel: 'Kod autoryzacyjny API',
            where: 'w aplikacji w Ustawieniach konta',
            account: { label: 'Nazwa Twojego konta', hint: 'Pierwszy człon adresu panelu', placeholder: 'firma', marker: 'NAZWA-KONTA' },
          },
        },
      },
    };
    const values = valuesFromPreset('webhook_in', preset);
    const sv: SimpleValues = {
      name: 'Proba', apiKeyId: String(apiKeyId), enabled: true, numbers: '', whenId: 'awaria', textId: 'z-komunikatem',
      secret: 'tajne123', account: 'firma', enrichSecret: 'api456', url: '', secrets: {}, params: {},
    };
    const out = simpleToValues('webhook_in', preset, sv, values);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.values.enrichUrl).toBe('https://firma.aplikacja.pl/clients/{{ p.client_id }}.json');
    expect(out.values.enrichToken).toBe('api456');
    expect(out.values.enrichOnError).toBe('skip');
    expect(detectSimple(preset, 'webhook_in', out.values)).toEqual({ whenId: 'awaria', textId: 'z-komunikatem', account: 'firma' });
    // Własny adres wpisany w trybie zaawansowanym wypycha formularz z trybu prostego.
    expect(detectSimple(preset, 'webhook_in', { ...out.values, enrichUrl: 'https://inna.aplikacja.pl/x.json' })).toBeNull();

    // Formularz prosty pyta o nazwę konta oraz o kod API słowami ustawienia, bez znacznika i bez szablonu.
    const ctx: FormContext = {
      kind: 'webhook_in', preset, keys: [{ id: apiKeyId, name: 'Klucz', accountName: 'Konto', serviceIds: ['24138'], origs: [] }],
      secretNames: [], apiUrl: null,
    };
    const html = simpleFormPage(ctx, simpleDefaults(preset, values, true), { textPreviews: {} });
    expect(html).toContain('Nazwa Twojego konta');
    expect(html).toContain('Pierwszy człon adresu panelu');
    expect(html).toContain('placeholder="firma"');
    expect(html).toContain('Kod autoryzacyjny API');
    expect(html).toContain('w aplikacji w Ustawieniach konta');
    expect(html).not.toContain('NAZWA-KONTA');
    expect(html).not.toContain('{{');

    const bez = simpleToValues('webhook_in', preset, { ...sv, account: '' }, values);
    expect(bez.ok).toBe(false);
    if (bez.ok) return;
    expect(bez.error).toContain('nazwa twojego konta');
    const zla = simpleToValues('webhook_in', preset, { ...sv, account: 'firma.pl/klienci' }, values);
    expect(zla.ok).toBe(false);
  });

  it('detectSimple: domyślne wartości każdego ustawienia z trybem prostym rozpoznają się jako proste', () => {
    for (const id of ['uptime-kuma', 'grafana', 'zabbix', 'fakturownia', 'freescout-zgloszenie', 'freshdesk-zgloszenie', 'prosty-json']) {
      const preset = presetById(id)!;
      const v = valuesFromPreset('webhook_in', preset);
      // Warunek ustawienia to „wszystko”; w listach musi być wariant z takim samym warunkiem albo pierwszy wariant po zapisie.
      const first = preset.simple!.inbound!.when[0]!;
      v.conditionMode = first.condition.mode;
      v.rules = first.condition.mode === 'builder' ? first.condition.rules : [];
      const auth = preset.simple!.inbound!.auth;
      if (auth.kind === 'header') v.authHeaderName = auth.name;
      if (auth.kind === 'basic') v.authBasicUser = auth.user;
      expect(detectSimple(preset, 'webhook_in', v), id).toEqual({ whenId: first.id, textId: preset.simple!.inbound!.text[0]!.id });
    }
    for (const id of ['freescout', 'freshdesk', 'ntfy', 'prosty-json']) {
      const preset = presetById(id)!;
      expect(detectSimple(preset, 'webhook_out', valuesFromPreset('webhook_out', preset)), id).not.toBeNull();
    }
    expect(detectSimple(presetById('custom')!, 'webhook_in', valuesFromPreset('webhook_in', presetById('custom')!))).toBeNull();
    void defaultInboundConfig;
    void defaultOutboundConfig;
  });
});
