import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSmsGroupConfig } from '../../src/integrations/config.ts';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-10-30T10:00:00Z');
let h: AdminHarness;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  const accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Szkoła', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
});

const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string, fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
  return h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: params.toString() });
};
const formBody = (over: Record<string, string | string[]> = {}): Record<string, string | string[]> => ({
  name: 'Dzieci', apiKeyId: String(apiKeyId), serviceId: '', orig: '', enabled: '1', mode: 'lists', senders: '601 000 001 Ania', recipients: '601000002\n601000003', members: '',
  prefix: 'dzieci', textMode: 'body', textTemplate: '', maxParts: '1', overflow: 'truncate', throttleLimit: '10', throttleWindow: '10', eventLogLimit: '200',
  conditionMode: 'builder', tryb: 'prosty', sampleFrom: '', sampleText: '', ...over,
});
const create = (over: Record<string, string | string[]> = {}) => post('/integracje', { kind: 'sms_group', preset: 'sms-grupa', ...formBody(over) });
const groupRow = () => h.integrations.list().find((r) => r.kind === 'sms_group')!;

describe('formularz SMS do grupy', () => {
  it('kafelek „Do grupy” prowadzi od razu do formularza w trybie prostym; zaawansowany pokazuje Liquid i warunek', async () => {
    const kind = (await get('/integracje/nowa')).body;
    expect(kind).toContain('href="/integracje/nowa?rodzaj=sms_group"');
    expect(kind).toContain('SMS do grupy');
    const redirect = await get('/integracje/nowa?rodzaj=sms_group');
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/integracje/nowa?rodzaj=sms_group&ustawienie=sms-grupa');
    const res = await get(redirect.headers.location as string);
    expect(res.statusCode).toBe(200);
    const form = res.body;
    for (const t of ['Numery uprawnione do pisania', 'Numery odbiorców', 'Numery członków', 'Prefiks', 'Sama treść', 'Nadawca i treść', 'Odsyłaj nadawcy potwierdzenie', 'data-show="mode=lists"', 'data-show="mode=closed"', 'Osobne listy', 'Grupa zamknięta', '20 numerów to 20 wiadomości', 'Utwórz grupę', 'name="kind" value="sms_group"']) expect(form).toContain(t);
    expect(form).not.toContain('Szablon Liquid');
    expect(form).not.toContain('Limit burzy');
    const adv = (await get('/integracje/nowa?rodzaj=sms_group&ustawienie=sms-grupa&tryb=zaawansowany')).body;
    for (const t of ['Szablon Liquid', 'Limit burzy', 'Limit części', 'Kiedy wysyłać', 'Próbka']) expect(adv).toContain(t);
  });
  it('zapis tworzy integrację sms_group ze znormalizowanymi listami, audytem i odświeżeniem odbiornika', async () => {
    const res = await create();
    expect(res.statusCode).toBe(302);
    const row = groupRow();
    expect(res.headers.location).toBe(`/integracje/${row.id}`);
    expect(row).toMatchObject({ name: 'Dzieci', preset: 'sms-grupa', enabled: 1, apiKeyId });
    expect(row.config).toMatchObject({ mode: 'lists', senders: [{ phone: '48601000001', name: 'Ania' }], recipients: ['48601000002', '48601000003'], members: [], prefix: 'dzieci', text: { mode: 'body' }, confirm: { enabled: false } });
    expect(h.refreshed.at(-1)).toEqual({ retryAccount: h.apiKeys.get(apiKeyId)!.accountId });
    expect(h.audit.list(5, 0)[0]).toMatchObject({ action: 'integracja.utworzenie', target: `integracja:${row.id}` });
    const detail = (await get(`/integracje/${row.id}`)).body;
    expect(detail).toContain('Grupa Dzieci utworzona.');
  });
  it('błąd walidacji wraca formularzem z komunikatem i kodem 400, bez zapisu', async () => {
    const res = await create({ recipients: '' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Podaj co najmniej jeden numer odbiorcy.');
    expect(res.body).toContain('>601 000 001 Ania</textarea>');
    expect(h.integrations.list()).toHaveLength(0);
    const bad = await create({ senders: '12 Jan' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('„12 Jan”');
    const dup = await create();
    expect(dup.statusCode).toBe(302);
    const again = await create();
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain('Integracja o tej nazwie już istnieje');
  });
  it('„Sprawdź” pokazuje podgląd bez zapisu: nadawca, prefiks, odbiorcy, SMS, potwierdzenie', async () => {
    const res = await create({ action: 'sprawdz', confirmEnabled: 'on', sampleText: 'Dzieci: jutro zbiórka' });
    expect(res.statusCode).toBe(200);
    for (const t of ['Nadawca na liście', 'Prefiks pasuje', 'jutro zbiórka', '48601000002, 48601000003', 'Wysłano do 2 odbiorców', 'bez zapisu i bez wysyłki']) expect(res.body).toContain(t);
    expect(h.integrations.list()).toHaveLength(0);
    const foreign = await create({ action: 'sprawdz', sampleFrom: '+48 601 000 009', sampleText: 'halo' });
    expect(foreign.body).toContain('Nadawca spoza listy: wiadomość zostałaby pominięta');
    expect(foreign.body).toContain('Prefiks nie pasuje: wiadomość zostałaby pominięta');
    const blank = await create({ action: 'sprawdz' });
    expect(blank.body).toContain('Jutro zbiórka o 8:00');
  });
  it('szczegół pokazuje tryb, prefiks, listy i potwierdzenie; edycja odtwarza linie; próbka z dziennika wchodzi w pola', async () => {
    await create({ confirmEnabled: 'on' });
    const row = groupRow();
    const detail = (await get(`/integracje/${row.id}`)).body;
    for (const t of ['do grupy', 'osobne listy: 1 nadawca, 2 odbiorców', 'Ania (48601000001)', '48601000002, 48601000003', 'dzieci', 'Potwierdzenie do nadawcy', 'sama treść', '<th style="width: 130px;">Nadawca</th>']) expect(detail).toContain(t);
    const edit = (await get(`/integracje/${row.id}/edytuj`)).body;
    expect(edit).toContain('48601000001 Ania');
    expect(edit).toContain('48601000002\n48601000003');
    expect(edit).toContain('Zapisz grupę');
    expect(edit).toContain('name="confirmEnabled" value="1" checked');
    const eventId = h.integrationEvents.record({ integrationId: row.id, at: NOW, result: 'skipped', reason: 'bez prefiksu', logLimit: 200, payload: JSON.stringify({ id: 'in_9', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text: 'jutro zbiórka', receivedAt: NOW.toISOString(), relatedMessageId: null }) });
    const withSample = (await get(`/integracje/${row.id}/edytuj?probka=${eventId}`)).body;
    expect(withSample).toContain('value="48601000001"');
    expect(withSample).toContain('>jutro zbiórka</textarea>');
    expect(withSample).toContain('Szablon Liquid');
    const saved = await post(`/integracje/${row.id}/edytuj`, formBody({ mode: 'closed', members: '601000001 Ania\n601000002 Basia', name: 'Zespół', tryb: 'zaawansowany' }));
    expect(saved.statusCode).toBe(302);
    const after = h.integrations.get(row.id)!;
    expect(after.name).toBe('Zespół');
    expect(after.config).toMatchObject({ mode: 'closed', members: [{ phone: '48601000001', name: 'Ania' }, { phone: '48601000002', name: 'Basia' }], senders: [], recipients: [] });
    expect(h.audit.list(5, 0)[0]).toMatchObject({ action: 'integracja.edycja', meta: expect.objectContaining({ pola: expect.arrayContaining(['name', 'mode', 'members']) }) });
    const closedDetail = (await get(`/integracje/${row.id}`)).body;
    expect(closedDetail).toContain('grupa zamknięta: 2 członków');
    expect(closedDetail).toContain('Grupa Zespół zapisana.');
  });
  it('edycja grupy z Liquidem albo odrzucaniem nadmiaru otwiera się zaawansowana z wyjaśnieniem', async () => {
    const id = h.integrations.insert({
      name: 'Rodzice', kind: 'sms_group', apiKeyId, serviceId: null, orig: null, preset: 'sms-grupa', enabled: 1,
      config: { ...defaultSmsGroupConfig(), senders: [{ phone: '48601000001', name: '' }], recipients: ['48601000002'], overflow: 'reject' }, secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    const edit = (await get(`/integracje/${id}/edytuj`)).body;
    expect(edit).toContain('otwiera się w trybie zaawansowanym');
    expect(edit).toContain('Szablon Liquid');
    const detail = (await get(`/integracje/${id}`)).body;
    expect(detail).toContain('bez prefiksu: każdy SMS od uprawnionego numeru');
    expect(detail).toContain('nadmiar: odrzucenie');
  });
  it('lista: zakładka „Do grupy” i filtr rodzaj=grupa', async () => {
    await create();
    h.integrations.insert({ name: 'HA', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1, config: { condition: { mode: 'builder', rules: [] }, throttle: { limit: 10, windowMinutes: 10 }, eventLogLimit: 200, events: ['message.received'], url: 'https://ha.example/x', method: 'POST', headers: [], body: { mode: 'json', template: '{}' }, sign: false }, secrets: {}, storePayloads: 0, createdAt: NOW });
    const all = (await get('/integracje')).body;
    expect(all).toContain('>Do grupy</a>');
    expect(all).toContain('Dzieci');
    expect(all).toContain('HA');
    const filtered = (await get('/integracje?rodzaj=grupa')).body;
    expect(filtered).toContain('Dzieci');
    expect(filtered).not.toContain('>HA<');
    expect(filtered).toContain('<span class="tag">do grupy</span>');
  });
});
