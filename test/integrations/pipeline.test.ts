import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultInboundConfig, type InboundConfig } from '../../src/integrations/config.ts';
import { fitToParts, previewInbound, runInbound } from '../../src/integrations/pipeline.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { IntegrationsRepo, type IntegrationRow } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
let deps: Parameters<typeof runInbound>[0];
let integrations: IntegrationsRepo;
let accounts: AccountsRepo;
let apiKeyId: number;
let accountId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  accounts = new AccountsRepo(db, key);
  accountId = accounts.insert(accountInput({ storeContent: 1, origs: ['FIRMA'] }));
  const apiKeys = new ApiKeysRepo(db, key);
  apiKeyId = apiKeys.insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], origs: ['FIRMA'] });
  integrations = new IntegrationsRepo(db, key);
  deps = {
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
    inbound: new InboundMessagesRepo(db), integrationEvents: new IntegrationEventsRepo(db, key), guards: new IntegrationGuardsRepo(db),
    engine: new TemplateEngine(), integrations,
  };
});

const make = (config: Partial<InboundConfig>, over: Partial<Parameters<IntegrationsRepo['insert']>[0]> = {}) => {
  const id = integrations.insert({
    name: 'Kuma', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
    config: { ...defaultInboundConfig(), text: { mode: 'liquid', template: '{{ p.msg }}' }, to: { path: 'to', fallback: ['48601000009'] }, ...config },
    secrets: {}, storePayloads: 0, createdAt: NOW, ...over,
  });
  return integrations.get(id) as IntegrationRow & { config: InboundConfig };
};
const events = (id: number) => deps.integrationEvents.list(id, 10).map((e) => e.result);
const ip = { sourceIp: '203.0.113.1' };

const DOPYTANIE = {
  url: 'https://przyklad.test/clients/{{ p.deal.client.id }}.json',
  method: 'GET' as const, headers: [], query: [], timeoutMs: 2000, as: 'e', onError: 'error' as const,
};
const zKartoteki = { to: { path: 'e.mobile_phone', fallback: [] }, text: { mode: 'liquid' as const, template: 'Faktura {{ p.deal.invoice_no }} dla {{ e.name }}' } };

describe('runInbound: zapytanie uzupełniające', () => {
  it('dopytuje aplikację, a odpowiedź daje odbiorcę oraz pola do treści', async () => {
    const integ = make({ ...zKartoteki, enrich: DOPYTANIE });
    deps.resolve = async () => ['93.184.216.34'];
    deps.enrichGet = async () => ({ status: 200, body: '{"name":"Anna","mobile_phone":"+48 601 000 001"}' });
    const out = await runInbound(deps, integ, { deal: { invoice_no: '1/09/2026', client: { id: 5 } } }, ip, NOW);
    expect(out.kind).toBe('sent');
    if (out.kind !== 'sent') return;
    const m = deps.messages.get(out.messageIds[0]!)!;
    expect(m.dest).toBe('48601000001');
    expect(m.body).toBe('Faktura 1/09/2026 dla Anna');
  });

  it('przy błędzie dopytania i ustawieniu „pomiń” kończy pominięciem, przy „błąd” błędem enrich', async () => {
    deps.resolve = async () => ['93.184.216.34'];
    deps.enrichGet = async () => ({ status: 500, body: '{}' });
    const pomijaj = make({ ...zKartoteki, enrich: { ...DOPYTANIE, onError: 'skip' } });
    expect(await runInbound(deps, pomijaj, { deal: { client: { id: 5 } } }, ip, NOW)).toEqual({ kind: 'skipped', reason: 'enrich' });
    expect(events(pomijaj.id)).toEqual(['skipped']);
    // Adres w dzienniku czytelny dla administratora: klamry szablonu zostają klamrami, token odpada.
    expect(deps.integrationEvents.list(pomijaj.id, 1)[0]!.reason).toContain('https://przyklad.test/clients/{{ p.deal.client.id }}.json');

    const zglaszaj = make({ ...zKartoteki, enrich: DOPYTANIE }, { name: 'Faktury' });
    const out = await runInbound(deps, zglaszaj, { deal: { client: { id: 5 } } }, ip, NOW);
    expect(out).toMatchObject({ kind: 'error', code: 'enrich' });
    if (out.kind !== 'error') return;
    expect(out.detail).toContain('https://przyklad.test/clients/');
    expect(out.detail).toContain('500');
  });

  it('nie dopytuje, gdy warunek, duplikat albo burza odsiały zdarzenie', async () => {
    let wolano = 0;
    deps.resolve = async () => ['93.184.216.34'];
    deps.enrichGet = async () => { wolano += 1; return { status: 200, body: '{}' }; };
    const integ = make({
      ...zKartoteki, enrich: DOPYTANIE,
      condition: { mode: 'builder', rules: [{ path: 'status', op: 'eq', value: 'issued' }] },
      throttle: { limit: 1, windowMinutes: 10 },
    });
    expect((await runInbound(deps, integ, { status: 'draft' }, ip, NOW)).kind).toBe('skipped');
    expect(wolano).toBe(0);
    await runInbound(deps, integ, { status: 'issued', deal: { client: { id: 5 } } }, ip, NOW);
    expect(wolano).toBe(1);
    expect((await runInbound(deps, integ, { status: 'issued', deal: { client: { id: 5 } } }, ip, NOW)).kind).toBe('throttled');
    expect(wolano).toBe(1);
  });

  it('kartoteka z dopytania bez numeru: przy „pomiń” pominięcie, przy „błąd” no_recipient', async () => {
    deps.resolve = async () => ['93.184.216.34'];
    deps.enrichGet = async () => ({ status: 200, body: '{"name":"Anna","mobile_phone":""}' });
    const pomijaj = make({ ...zKartoteki, enrich: DOPYTANIE, invalidRecipient: 'skip' });
    expect(await runInbound(deps, pomijaj, { deal: { client: { id: 5 } } }, ip, NOW)).toEqual({ kind: 'skipped', reason: 'invalid_recipient' });
    expect(events(pomijaj.id)).toEqual(['skipped']);

    // Bez przełącznika „pomiń” brak numeru zostaje błędem, tak jak przy numerze z ładunku.
    const zglaszaj = make({ ...zKartoteki, enrich: DOPYTANIE }, { name: 'Faktury' });
    expect(await runInbound(deps, zglaszaj, { deal: { client: { id: 5 } } }, ip, NOW)).toMatchObject({ kind: 'error', code: 'no_recipient' });

    // Przełącznik nie rozciąga się na numer, który ma przyjść z ładunku - tam brak numeru to dalej błąd ustawienia.
    const zLadunku = make({ ...zKartoteki, to: { path: 'telefon', fallback: [] }, invalidRecipient: 'skip', enrich: DOPYTANIE }, { name: 'Z ladunku' });
    expect(await runInbound(deps, zLadunku, { deal: { client: { id: 5 } } }, ip, NOW)).toMatchObject({ kind: 'error', code: 'no_recipient' });
  });

  it('sekret dopytania nie trafia do dziennika ani do treści SMS-a', async () => {
    deps.resolve = async () => ['93.184.216.34'];
    deps.enrichGet = async () => ({ status: 500, body: '{}' });
    const integ = make(
      { ...zKartoteki, enrich: { ...DOPYTANIE, headers: [{ name: 'Authorization', valueRef: 'enrichToken' }], query: [{ name: 'api_token', valueRef: 'enrichToken' }] } },
      { secrets: { enrichToken: 'tajne123' } },
    );
    const out = await runInbound(deps, integ, { deal: { client: { id: 5 } } }, ip, NOW);
    expect(out.kind).toBe('error');
    expect(JSON.stringify(deps.integrationEvents.list(integ.id, 10))).not.toContain('tajne123');
    if (out.kind !== 'error') return;
    expect(out.detail).not.toContain('tajne123');
  });

  it('sekret dopytania dociera do zapytania z repozytorium integracji', async () => {
    let widziany = { naglowek: '', adres: '' };
    deps.resolve = async () => ['93.184.216.34'];
    deps.enrichGet = async (url, headers) => {
      widziany = { naglowek: headers.Authorization ?? '', adres: url };
      return { status: 200, body: '{"mobile_phone":"48601000001","name":"Anna"}' };
    };
    const integ = make(
      { ...zKartoteki, enrich: { ...DOPYTANIE, headers: [{ name: 'Authorization', valueRef: 'enrichToken' }], query: [{ name: 'api_token', valueRef: 'enrichToken' }] } },
      { secrets: { enrichToken: 'tajne123' } },
    );
    expect((await runInbound(deps, integ, { deal: { client: { id: 5 } } }, ip, NOW)).kind).toBe('sent');
    expect(widziany.naglowek).toBe('tajne123');
    expect(widziany.adres).toContain('api_token=tajne123');
  });

  it('adres dopytania w sieci wewnętrznej bez zgody to błąd, ze zgodą przechodzi', async () => {
    deps.resolve = async () => ['192.168.1.20'];
    deps.enrichGet = async () => ({ status: 200, body: '{"mobile_phone":"48601000001","name":"Anna"}' });
    const integ = make({ ...zKartoteki, enrich: DOPYTANIE });
    const out = await runInbound(deps, integ, { deal: { client: { id: 5 } } }, ip, NOW);
    expect(out).toMatchObject({ kind: 'error', code: 'enrich' });
    if (out.kind !== 'error') return;
    expect(out.detail).toContain('sieć wewnętrzną');

    deps.allowPrivateWebhooks = true;
    expect((await runInbound(deps, integ, { deal: { client: { id: 5 } } }, ip, NOW)).kind).toBe('sent');
  });

  it('odpowiedź dopytania widzą też ścieżki, a ładunek w dzienniku zostaje bez niej', async () => {
    deps.resolve = async () => ['93.184.216.34'];
    deps.enrichGet = async () => ({ status: 200, body: '{"mobile_phone":"48601000001","tresc":"Anna Kowalska"}' });
    const integ = make(
      { enrich: DOPYTANIE, to: { path: 'e.mobile_phone', fallback: [] }, text: { mode: 'path', path: 'e.tresc' } },
      { storePayloads: 1 },
    );
    const out = await runInbound(deps, integ, { deal: { client: { id: 5 } } }, ip, NOW);
    expect(out.kind).toBe('sent');
    if (out.kind !== 'sent') return;
    expect(deps.messages.get(out.messageIds[0]!)!.body).toBe('Anna Kowalska');
    const wpis = deps.integrationEvents.list(integ.id, 1)[0]!;
    expect(wpis.payload).toBe('{"deal":{"client":{"id":5}}}');
  });
});

describe('runInbound', () => {
  it('wysyła na numer z ładunku i zapisuje wpis sent z adresem źródłowym', async () => {
    const integ = make({});
    const out = await runInbound(deps, integ, { to: '+48 601 000 001', msg: 'Serwer padł' }, ip, NOW);
    expect(out.kind).toBe('sent');
    const id = (out as { messageIds: string[] }).messageIds[0]!;
    const m = deps.messages.get(id)!;
    expect(m.dest).toBe('48601000001');
    expect(m.body).toBe('Serwer padł');
    expect(m.integrationId).toBe(integ.id);
    const [event] = deps.integrationEvents.list(integ.id, 10);
    expect(event).toMatchObject({ result: 'sent', messageId: id, sourceIp: '203.0.113.1' });
  });
  it('brak pola numeru daje listę zapasową; wielu odbiorców to wiele wiadomości', async () => {
    const integ = make({});
    const out = await runInbound(deps, integ, { msg: 'x' }, ip, NOW);
    expect(out.kind).toBe('sent');
    expect(deps.messages.get((out as { messageIds: string[] }).messageIds[0]!)!.dest).toBe('48601000009');
    const many = await runInbound(deps, integ, { to: '48601000001, 48601000002', msg: 'x' }, ip, NOW) as { messageIds: string[] };
    expect(many.messageIds).toHaveLength(2);
    expect(deps.integrationEvents.list(integ.id, 1)[0]!.reason).toBe('2 odbiorców');
  });
  it('pusta treść to error empty_text bez wysyłki', async () => {
    const integ = make({});
    expect(await runInbound(deps, integ, { to: '48601000001' }, ip, NOW)).toMatchObject({ kind: 'error', code: 'empty_text' });
    expect(deps.jobs.depth()).toBe(0);
    expect(events(integ.id)).toEqual(['error']);
  });
  it('tryb ścieżki bierze pole wprost', async () => {
    const integ = make({ text: { mode: 'path', path: 'alert.title' } });
    const out = await runInbound(deps, integ, { alert: { title: '  Dysk pełny ' } }, ip, NOW) as { messageIds: string[] };
    expect(deps.messages.get(out.messageIds[0]!)!.body).toBe('Dysk pełny');
  });
  it('brak numeru i pusta lista zapasowa to no_recipient; zły numer to invalid_phone', async () => {
    const integ = make({ to: { path: 'to', fallback: [] } });
    expect(await runInbound(deps, integ, { msg: 'x' }, ip, NOW)).toMatchObject({ kind: 'error', code: 'no_recipient' });
    expect(await runInbound(deps, integ, { to: 'jan@firma.pl', msg: 'x' }, ip, NOW)).toMatchObject({ kind: 'error', code: 'invalid_phone' });
  });
  it('numer kupującego z wiodącym zerem idzie na SMS, nie na błąd', async () => {
    // Formularz zamówienia w sklepie przyjmuje numer w zapisie krajowym z zerem międzymiastowym.
    const integ = make({ to: { path: 'billing.phone', fallback: [] } });
    const out = await runInbound(deps, integ, { billing: { phone: '0601 000 001' }, msg: 'x' }, ip, NOW) as { messageIds: string[] };
    expect(deps.messages.get(out.messageIds[0]!)!.dest).toBe('48601000001');
  });
  it('przełącznik „pomiń” zamienia zły numer z ładunku na pominięcie, ale tylko numer z ładunku', async () => {
    // Sklepy liczą odpowiedź inną niż 2xx jako nieudane dostarczenie i po kilku z rzędu wyłączają webhook.
    const pomijaj = make({ to: { path: 'to', fallback: [] }, invalidRecipient: 'skip' });
    expect(await runInbound(deps, pomijaj, { to: 'jan@firma.pl', msg: 'x' }, ip, NOW))
      .toEqual({ kind: 'skipped', reason: 'invalid_recipient' });
    expect(events(pomijaj.id)).toEqual(['skipped']);

    // Brak numeru w ogóle to dalej błąd: nie ma czego pomijać, jest co naprawić w ustawieniu.
    expect(await runInbound(deps, pomijaj, { msg: 'x' }, ip, NOW)).toMatchObject({ kind: 'error', code: 'no_recipient' });

    // Numer z listy zapasowej wpisuje administrator, więc jego błąd zostaje błędem także przy „pomiń”.
    const zapasowa = make({ to: { fallback: ['jan@firma.pl'] }, invalidRecipient: 'skip' }, { name: 'Sklep' });
    expect(await runInbound(deps, zapasowa, { msg: 'x' }, ip, NOW)).toMatchObject({ kind: 'error', code: 'invalid_phone' });
  });
  it('domyślnie zły numer z ładunku zostaje błędem', async () => {
    const integ = make({ to: { path: 'to', fallback: [] } });
    expect(integ.config.invalidRecipient).toBe('error');
    expect(await runInbound(deps, integ, { to: 'jan@firma.pl', msg: 'x' }, ip, NOW)).toMatchObject({ kind: 'error', code: 'invalid_phone' });
  });
  it('ponad 50 odbiorców to too_many_recipients', async () => {
    const integ = make({});
    const to = Array.from({ length: 51 }, (_, i) => `4860100${String(i).padStart(4, '0')}`);
    expect(await runInbound(deps, integ, { to, msg: 'x' }, ip, NOW)).toMatchObject({ kind: 'error', code: 'too_many_recipients' });
  });
  it('warunek niespełniony to skipped', async () => {
    const integ = make({ condition: { mode: 'builder', rules: [{ path: 'status', op: 'eq', value: 'down' }] } });
    expect(await runInbound(deps, integ, { status: 'up', msg: 'x' }, ip, NOW)).toEqual({ kind: 'skipped' });
    expect(events(integ.id)).toEqual(['skipped']);
  });
  it('identyfikator zdarzenia daje duplikat za drugim razem', async () => {
    const integ = make({ eventIdPath: 'id' });
    await runInbound(deps, integ, { id: 'e1', msg: 'x' }, ip, NOW);
    expect(await runInbound(deps, integ, { id: 'e1', msg: 'x' }, ip, NOW)).toEqual({ kind: 'duplicate' });
    expect((await runInbound(deps, integ, { msg: 'bez identyfikatora' }, ip, NOW)).kind).toBe('sent');
  });
  it('limit burzy odrzuca nadmiar i sygnalizuje powiadomienie raz', async () => {
    const integ = make({ throttle: { limit: 1, windowMinutes: 10 } });
    await runInbound(deps, integ, { msg: 'x' }, ip, NOW);
    expect(await runInbound(deps, integ, { msg: 'x' }, ip, NOW)).toEqual({ kind: 'throttled', notify: true });
    expect(await runInbound(deps, integ, { msg: 'x' }, ip, NOW)).toEqual({ kind: 'throttled', notify: false });
  });
  it('błąd szablonu w czasie wykonania to error template', async () => {
    const integ = make({ text: { mode: 'liquid', template: '{{ p.msg | nieznany }}' } });
    expect(await runInbound(deps, integ, { msg: 'x' }, ip, NOW)).toMatchObject({ kind: 'error', code: 'template' });
  });
  it('nadmiar części: utnij albo odrzuć', async () => {
    const long = 'a'.repeat(400);
    const cut = make({ maxParts: 1, overflow: 'truncate' });
    const out = await runInbound(deps, cut, { msg: long }, ip, NOW) as { messageIds: string[] };
    const m = deps.messages.get(out.messageIds[0]!)!;
    expect(m.parts).toBe(1);
    expect(m.body!.endsWith('…')).toBe(true);
    const reject = make({ maxParts: 1, overflow: 'reject' }, { name: 'Kuma 2' });
    expect(await runInbound(deps, reject, { msg: long }, ip, NOW)).toMatchObject({ kind: 'error', code: 'too_many_parts' });
  });
  it('odpowiedź w wątku po identyfikatorze zgłoszenia, tylko do nadawcy oryginału', async () => {
    deps.inbound.insertIfNew({ id: 'in_1', accountId, serviceId: '24138', miId: '1', sender: '48601000001', dest: '7968', kind: 'text', body: 'Pomocy', bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null, receivedAt: NOW.toISOString(), createdAt: NOW.toISOString() });
    const outbound = integrations.insert({ name: 'FS', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1, config: { condition: { mode: 'builder', rules: [] }, throttle: { limit: 10, windowMinutes: 10 }, eventLogLimit: 200, events: ['message.received'], url: 'https://fs.example/x', method: 'POST', headers: [], body: { mode: 'json', template: '{}' }, sign: false }, secrets: {}, storePayloads: 0, createdAt: NOW });
    deps.inbound.setExternalRef('in_1', outbound, '4821');
    const integ = make({ ticketRefPath: 'ticket.id' });
    const out = await runInbound(deps, integ, { ticket: { id: '4821' }, to: '48601000001', msg: 'Odpowiadamy' }, ip, NOW) as { messageIds: string[] };
    expect(deps.messages.get(out.messageIds[0]!)!.inReplyTo).toBe('in_1');
    expect(deps.integrationEvents.list(integ.id, 1)[0]!.inboundId).toBe('in_1');
    // Inny odbiorca niż nadawca oryginału: zwykły SMS, nie wątek.
    const other = await runInbound(deps, integ, { ticket: { id: '4821' }, to: '48601000002', msg: 'Inny' }, ip, NOW) as { messageIds: string[] };
    expect(deps.messages.get(other.messageIds[0]!)!.inReplyTo).toBeNull();
  });
  it('bez numeru w ładunku odbiorcą jest nadawca odebranej dopasowanej po zgłoszeniu; bez dopasowania - lista zapasowa', async () => {
    deps.inbound.insertIfNew({ id: 'in_1', accountId, serviceId: '24138', miId: '1', sender: '48601000001', dest: '7968', kind: 'text', body: 'Pomocy', bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null, receivedAt: NOW.toISOString(), createdAt: NOW.toISOString() });
    const outbound = integrations.insert({ name: 'FS', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1, config: { condition: { mode: 'builder', rules: [] }, throttle: { limit: 10, windowMinutes: 10 }, eventLogLimit: 200, events: ['message.received'], url: 'https://fs.example/x', method: 'POST', headers: [], body: { mode: 'json', template: '{}' }, sign: false }, secrets: {}, storePayloads: 0, createdAt: NOW });
    deps.inbound.setExternalRef('in_1', outbound, '45');
    const integ = make({ ticketRefPath: 'id', to: { fallback: ['48601000009'] } });
    const out = await runInbound(deps, integ, { id: 45, msg: 'Odpowiadamy' }, ip, NOW) as { messageIds: string[] };
    const m = deps.messages.get(out.messageIds[0]!)!;
    expect(m.dest).toBe('48601000001');
    expect(m.inReplyTo).toBe('in_1');
    // Zgłoszenie nieznane: lista zapasowa, bez wątku.
    const other = await runInbound(deps, integ, { id: 99, msg: 'Inne' }, ip, NOW) as { messageIds: string[] };
    expect(deps.messages.get(other.messageIds[0]!)!.dest).toBe('48601000009');
    expect(deps.messages.get(other.messageIds[0]!)!.inReplyTo).toBeNull();
    // Bez listy zapasowej: błąd z numerem zgłoszenia w powodzie.
    const bare = make({ ticketRefPath: 'id', to: { fallback: [] } }, { name: 'FS2' });
    const fail = await runInbound(deps, bare, { id: 99, msg: 'Inne' }, ip, NOW);
    expect(fail.kind).toBe('error');
    expect((fail as { detail: string }).detail).toContain('99');
  });

  it('klucz odwołany i konto wstrzymane to unavailable', async () => {
    const integ = make({});
    accounts.pause(accountId, 'brak środków');
    expect(await runInbound(deps, integ, { msg: 'x' }, ip, NOW)).toMatchObject({ kind: 'unavailable', detail: /wstrzymane/ });
    accounts.resume(accountId);
    deps.apiKeys.revoke(apiKeyId);
    expect(await runInbound(deps, integ, { msg: 'x' }, ip, NOW)).toMatchObject({ kind: 'unavailable', detail: /odwołany/ });
    expect(events(integ.id)).toEqual(['error', 'error']);
  });
  it('przechowuje ładunek tylko gdy włączone', async () => {
    const integ = make({}, { storePayloads: 1, name: 'Z ładunkiem' });
    await runInbound(deps, integ, { msg: 'x', secret: 'S' }, ip, NOW);
    expect(deps.integrationEvents.latestPayload(integ.id)).toContain('"secret":"S"');
    const quiet = make({});
    await runInbound(deps, quiet, { msg: 'x', secret: 'S' }, ip, NOW);
    expect(deps.integrationEvents.latestPayload(quiet.id)).toBeNull();
  });
  it('usługa i nadpis integracji trafiają do wiadomości', async () => {
    const integ = make({}, { orig: 'FIRMA' });
    const out = await runInbound(deps, integ, { msg: 'x' }, ip, NOW) as { messageIds: string[] };
    expect(deps.messages.get(out.messageIds[0]!)!.orig).toBe('FIRMA');
  });
});

describe('previewInbound', () => {
  it('bez numeru, ale z identyfikatorem zgłoszenia zaznacza odbiorcę z wątku', () => {
    const config: InboundConfig = { ...defaultInboundConfig(), ticketRefPath: 'id', text: { mode: 'liquid', template: '{{ p.msg }}' } };
    expect(previewInbound(new TemplateEngine(), config, { id: 45, msg: 'x' }, '48', NOW).threadRecipient).toBe(true);
    expect(previewInbound(new TemplateEngine(), config, { msg: 'x' }, '48', NOW).threadRecipient).toBe(false);
  });

  it('pokazuje numery, treść i części bez zapisu', () => {
    const integ = make({});
    const p = previewInbound(deps.engine, integ.config, { to: '+48 601 000 001', msg: 'Zażółć' }, '48', NOW);
    expect(p).toEqual({ matches: true, recipients: ['48601000001'], text: 'Zażółć', parts: 1, error: null, threadRecipient: false });
    expect(deps.jobs.depth()).toBe(0);
    expect(deps.integrationEvents.list(integ.id, 10)).toHaveLength(0);
  });
  it('zły numer jest oznaczony, pusta treść to błąd, błąd szablonu też', () => {
    const integ = make({});
    expect(previewInbound(deps.engine, integ.config, { to: 'abc' }, '48', NOW)).toMatchObject({ recipients: ['abc (nieprawidłowy)'], error: /pustą/ });
    const bad = make({ text: { mode: 'liquid', template: '{% if %}' } }, { name: 'Zła' });
    expect(previewInbound(deps.engine, bad.config, {}, '48', NOW).error).toBeTruthy();
  });
});

describe('fitToParts', () => {
  it('nie tnie, gdy się mieści; tnie z wielokropkiem, gdy nie', () => {
    expect(fitToParts('abc', 1)).toEqual({ text: 'abc', parts: 1, over: false });
    const cut = fitToParts('a'.repeat(200), 1);
    expect(cut.over).toBe(true);
    expect(cut.parts).toBe(1);
    expect(cut.text.length).toBeLessThanOrEqual(160);
  });
});
