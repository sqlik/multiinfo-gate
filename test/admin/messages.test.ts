import { beforeEach, describe, expect, it } from 'vitest';
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
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
});

function seed(id: string, patch: Partial<{
  dest: string; body: string | null; parts: number; account: number;
  status: string; miStatus: number; miSubstatus: number; miIds: string[];
}> = {}) {
  h.messages.insert({
    id, apiKeyId, accountId: patch.account ?? accountId, serviceId: '24138',
    dest: patch.dest ?? '48601135134',
    body: patch.body === undefined ? 'Przypominamy o wizycie' : patch.body,
    bodyHash: 'h', encoding: 'gsm', parts: patch.parts ?? 1, slots: 22,
    orig: 'Firma Info', costCenter: null, validTo: null, idempotencyKey: null,
    createdAt: NOW.toISOString(),
  });
  if (patch.miIds) h.messages.setSent(id, patch.miIds, NOW);
  if (patch.status) {
    h.messages.setStatus(id, {
      status: patch.status as never,
      ...(patch.miStatus === undefined ? {} : { miStatus: patch.miStatus }),
      ...(patch.miSubstatus === undefined ? {} : { miSubstatus: patch.miSubstatus }),
    });
  }
  return id;
}

const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

describe('GET /przeglad', () => {
  it('pokazuje bilans, który sumuje się do przyjętych', async () => {
    seed('m1', { status: 'delivered' });
    seed('m2', { status: 'delivered' });
    seed('m3', { status: 'failed' });
    seed('m4', { status: 'cancelled' });
    seed('m5');
    const res = await page('/przeglad');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Wychodzące');
    expect(res.body).not.toContain('>Wysłane<');
    expect(res.body).not.toContain('>Przyjęte<');
    expect(res.body).toMatch(/Wychodzące<\/div>\s*<div class="n">5</);
    expect(res.body).toContain('% wychodzących');
    expect(res.body).toMatch(/Anulowane<\/div>\s*<div class="n">1</);
    expect(res.body).toMatch(/W drodze<\/div>\s*<div class="n">1</);
    expect(res.body).toContain('href="/wiadomosci?status=cancelled"');
    expect(res.body).toContain('href="/wiadomosci?status=transit"');
  });

  it('ostrzega o certyfikacie wygasającym w ciągu 30 dni', async () => {
    seedAccount(h, { name: 'Windykacja', login: 'firma_wind', notAfter: '2026-09-08' });
    const res = await page('/przeglad');
    expect(res.body).toContain('Windykacja');
    expect(res.body).toContain('14 dni');
    expect(res.body).toContain('-82');
  });

  it('pokazuje wstrzymane konto wraz z przyczyną', async () => {
    h.accounts.pause(accountId, 'Certyfikat odrzucony przez Multiinfo, kod -85');
    const res = await page('/przeglad');
    expect(res.body).toContain('wstrzymane');
    expect(res.body).toContain('kod -85');
  });

  it('wypisuje ostatnie niepowodzenia z kodem i opisem od Multiinfo', async () => {
    seed('m4', { status: 'failed', miStatus: 11, miSubstatus: 4, dest: '48501052442' });
    const res = await page('/przeglad');
    expect(res.body).toContain('48501052442');
    expect(res.body).toContain('SMSC - brak odpowiedzi');
  });
});

describe('GET /przeglad - odebrane', () => {
  it('pokazuje kafelek odebranych z ostatniej doby', async () => {
    const base = { accountId, serviceId: '24138', sender: '48601000001', dest: '7968', kind: 'text' as const, body: 'x', bodyHash: 'h',
      protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null, receivedAt: NOW.toISOString() };
    h.inbound.insertIfNew({ ...base, id: 'in_1', miId: '1', createdAt: NOW.toISOString() });
    h.inbound.insertIfNew({ ...base, id: 'in_2', miId: '2', createdAt: new Date(NOW.getTime() - 25 * 3600_000).toISOString() });
    const res = await page('/przeglad');
    expect(res.body).toMatch(/Odebrane<\/div>\s*<div class="n">1<\/div>/);
    expect(res.body).toContain('href="/odebrane"');
    expect(res.body).toContain('tiles-6');
  });
});

describe('GET /przeglad - webhooki', () => {
  it('ostrzega o niedostarczonych webhookach', async () => {
    const id = h.deliveries.insert({
      apiKeyId, event: 'message.sent', payload: '{}', url: 'https://crm.example/hook', createdAt: NOW,
    });
    h.deliveries.markFailed(id, '503');
    const res = await page('/przeglad');
    expect(res.body).toContain('1 webhook nie dotarł');
    expect(res.body).toContain('/klucze');
  });

  it('odmienia liczbę niedostarczonych webhooków', async () => {
    for (let i = 0; i < 3; i += 1) {
      const id = h.deliveries.insert({ apiKeyId, event: 'message.sent', payload: '{}', url: 'u', createdAt: NOW });
      h.deliveries.markFailed(id, '503');
    }
    expect((await page('/przeglad')).body).toContain('3 webhooki nie dotarły');
  });

  it('nie ostrzega o niedostarczonym sprzed doby - alarm ma się sam wygaszać', async () => {
    const id = h.deliveries.insert({ apiKeyId, event: 'message.sent', payload: '{}', url: 'u', createdAt: new Date(NOW.getTime() - 2 * 86_400_000) });
    h.deliveries.markFailed(id, '503');
    expect((await page('/przeglad')).body).not.toContain('nie dotar');
  });

  it('nie ostrzega, gdy webhooki tylko czekają na ponowienie', async () => {
    h.deliveries.insert({ apiKeyId, event: 'message.sent', payload: '{}', url: 'u', createdAt: NOW });
    expect((await page('/przeglad')).body).not.toContain('nie dotar');
  });
});

describe('GET /wiadomosci', () => {
  beforeEach(() => {
    seed('m1', { status: 'delivered', dest: '48601135134' });
    seed('m2', { status: 'failed', dest: '48601135135' });
  });

  it('pokazuje czas przyjęcia w czasie polskim, nie UTC', async () => {
    const res = await page('/wiadomosci');
    expect(res.body).toContain('12:00:00');
    expect(res.body).not.toContain('10:00:00');
  });

  it('w szczególe wiadomości przebieg ma czas polski z milisekundami', async () => {
    const res = await page('/wiadomosci/m1');
    expect(res.body).toContain('12:00:00.000');
    expect(res.body).not.toContain('10:00:00.000');
  });

  it('filtruje po statusie', async () => {
    const res = await page('/wiadomosci?status=failed');
    expect(res.body).toContain('48601135135');
    expect(res.body).not.toContain('48601135134');
  });

  it('ma zakładki W drodze i Anulowane, a W drodze obejmuje kolejkę i dławione', async () => {
    seed('q');
    seed('t', { status: 'throttled' });
    seed('d', { status: 'delivered' });
    seed('c', { status: 'cancelled' });
    const res = await page('/wiadomosci?status=transit');
    expect(res.body).toContain('href="/wiadomosci?status=cancelled"');
    expect(res.body).toContain('>q<');
    expect(res.body).toContain('>t<');
    expect(res.body).not.toContain('>d<');
    const cancelled = await page('/wiadomosci?status=cancelled');
    expect(cancelled.body).toContain('>c<');
    expect(cancelled.body).not.toContain('>q<');
  });

  it('filtruje po numerze odbiorcy', async () => {
    const res = await page('/wiadomosci?to=48601135134');
    expect(res.body).toContain('48601135134');
    expect(res.body).not.toContain('48601135135');
  });

  it('ucieka znaki HTML w treści wiadomości', async () => {
    seed('m3', { body: '<script>alert(1)</script>' });
    const res = await page('/wiadomosci');
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('pokazuje status po polsku, nie surową nazwę wewnętrzną', async () => {
    const res = await page('/wiadomosci');
    expect(res.body).toContain('doręczona');
    expect(res.body).toContain('błąd');
  });
});

describe('GET /wiadomosci/:id', () => {
  it('pokazuje identyfikatory części zwrócone przez Multiinfo', async () => {
    seed('m1', { parts: 2, miIds: ['8841207', '8841208'], status: 'sent' });
    const res = await page('/wiadomosci/m1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('8841207');
    expect(res.body).toContain('8841208');
  });

  it('pokazuje opis substatusu po polsku dla wiadomości nieudanej', async () => {
    seed('m2', { status: 'failed', miStatus: 11, miSubstatus: 2 });
    const res = await page('/wiadomosci/m2');
    expect(res.body).toContain('Wiadomość nie została doręczona');
    expect(res.body).toContain('11 / 2');
  });

  it('pokazuje informację, że treść usunięto, gdy konto ma wyłączone przechowywanie', async () => {
    const quiet = seedAccount(h, { name: 'Windykacja', login: 'firma_wind', storeContent: 0 });
    seed('m3', { account: quiet, body: null });
    const res = await page('/wiadomosci/m3');
    expect(res.body).toContain('Treść usunięta po przetworzeniu');
  });

  it('pokazuje linijkę segmentów dla przechowywanej treści', async () => {
    seed('m1', { body: `${'a'.repeat(150)}{b}${'c'.repeat(20)}` });
    const res = await page('/wiadomosci/m1');
    expect(res.body).toContain('Podgląd segmentów');
    expect(res.body).toContain('<span class="cut"><i>2</i></span>');
    expect(res.body).toContain('<span class="x2">{</span>');
  });

  it('nie pokazuje linijki segmentów bez treści', async () => {
    seed('m1', { body: null });
    const res = await page('/wiadomosci/m1');
    expect(res.body).not.toContain('Podgląd segmentów');
    expect(res.body).toContain('Treść usunięta po przetworzeniu');
  });

  it('pokazuje ślad protokołu z zamaskowanym hasłem i liniami odpowiedzi', async () => {
    seed('m1', { miIds: ['8841207', '8841208'], status: 'sent' });
    h.messages.setTrace('m1', {
      at: '2026-08-25T10:00:01.000Z', durationMs: 412, script: 'sendsmslong.aspx',
      params: { login: 'firma_api', password: '••••••••', dest: '48601135134', text: 'Ala ma kota <b>' },
      httpStatus: 200, lines: ['8841207', '8841208'],
    });
    const res = await page('/wiadomosci/m1');
    expect(res.body).toContain('POST api2.multiinfo.plus.pl/Api61/sendsmslong.aspx');
    expect(res.body).toContain('password=••••••••');
    expect(res.body).toContain('text=Ala+ma+kota+%3Cb%3E');
    expect(res.body).toContain('412 ms');
    expect(res.body).toContain('   3</span>  8841208');
    expect(res.body).not.toContain('tajne-multiinfo');
  });

  it('bez śladu informuje, że pojawi się po przekazaniu', async () => {
    seed('m1');
    expect((await page('/wiadomosci/m1')).body).toContain('Ślad pojawi się po przekazaniu do Multiinfo.');
  });

  it('buduje przebieg ze zdarzeń, gdy są zapisane', async () => {
    seed('m1', { miIds: ['1'], status: 'delivered', miStatus: 21, miSubstatus: 1 });
    h.events.record('m1', new Date('2026-08-25T10:00:00Z'), 'queued', null);
    h.events.record('m1', new Date('2026-08-25T10:00:01Z'), 'sent', 'identyfikatory 1');
    h.events.record('m1', new Date('2026-08-25T10:00:12Z'), 'status', 'status 21 / 1 - Otrzymano raport doręczenia');
    h.events.record('m1', new Date('2026-08-25T10:00:12Z'), 'webhook', 'message.delivered');
    const res = await page('/wiadomosci/m1');
    expect(res.body).toContain('status 21 / 1');
    expect(res.body).toContain('Otrzymano raport doręczenia');
    expect(res.body).toContain('message.delivered');
    expect(res.body).toContain('dot-ok');
    expect(res.body).not.toContain('Stan ostateczny:');
  });

  it('bez zdarzeń pokazuje przebieg z dat wiadomości', async () => {
    seed('m1', { miIds: ['1'], status: 'delivered', miStatus: 21, miSubstatus: 1 });
    h.messages.setStatus('m1', { status: 'delivered', finalAt: NOW });
    const res = await page('/wiadomosci/m1');
    expect(res.body).toContain('Stan ostateczny: doręczona');
  });

  it('zwraca 404 dla nieznanego identyfikatora', async () => {
    expect((await page('/wiadomosci/m_nieistnieje')).statusCode).toBe(404);
  });
});

describe('GET /wiadomosci/:id - dostawy do aplikacji', () => {
  it('pokazuje dostawy o tej wiadomości z przyciskiem ponowienia przy nieudanej, a ponowienie wraca do wiadomości', async () => {
    // Klucz z adresem webhooka - ten z beforeEach go nie ma, a bez adresu nie ma dokąd ponawiać.
    const hookKeyId = h.apiKeys.insert({
      accountId, name: 'CRM z webhookiem', keyHash: 'argon2:bbb', keyPrefix: 'b1b2c3d4', defaultServiceId: '24138', defaultOrig: null,
      maxParts: 5, ratePerMin: 60, webhookUrl: 'https://crm.example/hook', webhookSecret: 's', serviceIds: ['24138'],
    });
    seed('msg_1');
    const id = h.deliveries.insert({ apiKeyId: hookKeyId, event: 'message.sent', payload: '{"event":"message.sent","id":"msg_1"}', url: 'https://crm.example/hook', createdAt: NOW });
    h.deliveries.markFailed(id, '503 Service Unavailable');
    h.deliveries.insert({ apiKeyId: hookKeyId, event: 'message.sent', payload: '{"event":"message.sent","id":"msg_2"}', url: 'https://crm.example/hook', createdAt: NOW });
    const body = (await page('/wiadomosci/msg_1')).body;
    expect(body).toContain('Dostawy do aplikacji');
    expect(body).toContain('message.sent');
    expect(body).toContain('503 Service Unavailable');
    expect(body).toContain(`action="/dostawy/${id}/ponow"`);
    const res = await h.app.inject({ method: 'POST', url: `/dostawy/${id}/ponow`, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
    expect(res.headers.location).toBe('/wiadomosci/msg_1');
    expect(h.deliveries.get(id)!.status).toBe('pending');
  });
});

describe('GET /wiadomosci/:id - odpowiedź w wątku', () => {
  it('pokazuje odnośnik do wiadomości przychodzącej', async () => {
    h.inbound.insertIfNew({ id: 'in_1', accountId, serviceId: '24138', miId: '22', sender: '48601135134', dest: '7968', kind: 'text', body: 'Pytanie', bodyHash: 'h',
      protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null, receivedAt: NOW.toISOString(), createdAt: NOW.toISOString() });
    h.messages.insert({ id: 'msg_r', apiKeyId, accountId, serviceId: '24138', dest: '48601135134', body: 'Odp', bodyHash: 'h', encoding: 'gsm', parts: 1, slots: 3,
      orig: null, costCenter: null, validTo: null, idempotencyKey: null, inReplyTo: 'in_1', createdAt: NOW.toISOString() });
    const res = await page('/wiadomosci/msg_r');
    expect(res.body).toContain('Odpowiedź na');
    expect(res.body).toContain('href="/odebrane/in_1"');
    expect((await page('/wiadomosci/' + seed('msg_z'))).body).not.toContain('Odpowiedź na');
  });
});
