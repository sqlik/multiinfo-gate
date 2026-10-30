import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSmsGroupConfig, type SmsGroupConfig } from '../../src/integrations/config.ts';
import { previewSmsGroup, runSmsGroup, type ReceivedEvent, type SmsGroupIntegration, type SmsGroupOutcome } from '../../src/integrations/pipeline.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-10-30T10:00:00Z');
let deps: Parameters<typeof runSmsGroup>[0];
let integrations: IntegrationsRepo;
let apiKeyId: number;
let seq = 0;

beforeEach(() => {
  seq = 0;
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accounts = new AccountsRepo(db, key);
  const accountId = accounts.insert(accountInput({ storeContent: 1 }));
  const apiKeys = new ApiKeysRepo(db, key);
  apiKeyId = apiKeys.insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
  integrations = new IntegrationsRepo(db, key);
  const inbound = new InboundMessagesRepo(db);
  inbound.insertIfNew({ id: 'in_1', accountId, serviceId: '24138', miId: '1', sender: '48601000001', dest: '7968', kind: 'text', body: 'Dzieci: jutro zbiórka 8:00', bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null, receivedAt: NOW.toISOString(), createdAt: NOW.toISOString() });
  deps = {
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
    inbound, integrationEvents: new IntegrationEventsRepo(db, key), guards: new IntegrationGuardsRepo(db),
    engine: new TemplateEngine(), integrations,
  };
});

const event = (over: Partial<ReceivedEvent> = {}): ReceivedEvent => ({ id: 'in_1', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text: 'Dzieci: jutro zbiórka 8:00', receivedAt: NOW.toISOString(), relatedMessageId: null, ...over });
const make = (config: Partial<SmsGroupConfig> & { name?: string }, storePayloads: 0 | 1 = 0) => {
  seq += 1;
  const { name, ...rest } = config;
  const id = integrations.insert({
    name: name ?? (seq === 1 ? 'Grupa' : `Grupa ${seq}`), kind: 'sms_group', apiKeyId, serviceId: null, orig: null, preset: 'sms-grupa', enabled: 1,
    config: { ...defaultSmsGroupConfig(), ...rest }, secrets: {}, storePayloads, createdAt: NOW,
  });
  return integrations.get(id) as SmsGroupIntegration;
};
const lists = (over: Partial<SmsGroupConfig> & { name?: string } = {}) => make({ senders: [{ phone: '48601000001', name: 'Ania' }], recipients: ['48601000002', '48601000003'], prefix: 'dzieci', ...over });
const events = (id: number) => deps.integrationEvents.list(id, 10).map((e) => [e.result, e.reason]);
const allMessages = () => deps.messages.list({ limit: 50, offset: 0 });

describe('runSmsGroup', () => {
  it('rozsyła treść bez prefiksu do listy; wpis wysłano z liczbą odbiorców i identyfikatorem odebranej', () => {
    const g = lists();
    const out = runSmsGroup(deps, g, event(), NOW);
    expect(out).toMatchObject({ kind: 'sent', recipients: ['48601000002', '48601000003'], text: 'jutro zbiórka 8:00', parts: 1, confirmId: null });
    const ids = (out as { messageIds: string[] }).messageIds;
    expect(ids).toHaveLength(2);
    expect(deps.messages.get(ids[0]!)).toMatchObject({ body: 'jutro zbiórka 8:00', dest: '48601000002', integrationId: g.id });
    expect(deps.messages.get(ids[1]!)).toMatchObject({ body: 'jutro zbiórka 8:00', dest: '48601000003' });
    expect(events(g.id)).toEqual([['sent', '2 odbiorców']]);
    expect(deps.integrationEvents.list(g.id, 1)[0]).toMatchObject({ inboundId: 'in_1', sourceIp: '48601000001', messageId: ids[0] });
  });
  it('nadawca spoza listy, brak prefiksu, pusta treść i SMS binarny to pominięto bez wysyłki i bez potwierdzenia', () => {
    const g = lists({ confirm: { enabled: true } });
    expect(runSmsGroup(deps, g, event({ from: '48601000009' }), NOW)).toEqual({ kind: 'skipped', reason: 'sender_not_allowed' });
    expect(runSmsGroup(deps, g, event({ text: 'jutro zbiórka' }), NOW)).toEqual({ kind: 'skipped', reason: 'no_prefix' });
    expect(runSmsGroup(deps, g, event({ text: 'Dzieci:' }), NOW)).toEqual({ kind: 'skipped', reason: 'empty' });
    expect(runSmsGroup(deps, g, event({ kind: 'binary', text: undefined, hex: '00ff' }), NOW)).toEqual({ kind: 'skipped', reason: 'binary' });
    expect(allMessages()).toHaveLength(0);
    expect(events(g.id).map((e) => e[1])).toEqual(['brak treści tekstowej', 'pusta treść', 'bez prefiksu', 'nadawca spoza listy: 48601000009']);
    expect(events(g.id).every((e) => e[0] === 'skipped')).toBe(true);
  });
  it('potwierdzenie: SMS w wątku do nadawcy po rozesłaniu, z liczbą odbiorców', () => {
    const g = lists({ confirm: { enabled: true } });
    const out = runSmsGroup(deps, g, event(), NOW) as Extract<SmsGroupOutcome, { kind: 'sent' }>;
    expect(out.confirmId).not.toBeNull();
    const confirm = deps.messages.get(out.confirmId!)!;
    expect(confirm).toMatchObject({ dest: '48601000001', body: 'Wysłano do 2 odbiorców', inReplyTo: 'in_1', integrationId: g.id });
    expect(allMessages()).toHaveLength(3);
    expect(events(g.id)).toEqual([['sent', '2 odbiorców']]);
  });
  it('potwierdzenie do jednego odbiorcy odmienia liczebnik', () => {
    const out = runSmsGroup(deps, lists({ recipients: ['48601000002'], confirm: { enabled: true } }), event(), NOW) as Extract<SmsGroupOutcome, { kind: 'sent' }>;
    expect(deps.messages.get(out.confirmId!)!.body).toBe('Wysłano do 1 odbiorcy');
  });
  it('przepełnienie z odrzuceniem: wpis błąd i potwierdzenie o długości; z przycięciem: wysłano', () => {
    const long = 'x'.repeat(400);
    const r = lists({ overflow: 'reject', confirm: { enabled: true } });
    const reject = runSmsGroup(deps, r, event({ text: `dzieci ${long}` }), NOW);
    expect(reject).toMatchObject({ kind: 'error', code: 'too_many_parts' });
    expect(allMessages().map((m) => [m.dest, m.body])).toEqual([['48601000001', 'Nie wysłano: wiadomość wymaga więcej niż 1 części']]);
    expect(events(r.id)[0]).toEqual(['error', 'Treść wymaga więcej niż 1 części.']);
    const cut = runSmsGroup(deps, lists({ name: 'Druga' }), event({ text: `dzieci ${long}` }), NOW);
    expect(cut).toMatchObject({ kind: 'sent', parts: 1 });
    expect((cut as { text: string }).text.endsWith('…')).toBe(true);
  });
  it('grupa zamknięta: do pozostałych członków, nazwa nadawcy w treści w trybie sender_body; jedyny członek to brak odbiorców', () => {
    const closed = make({ mode: 'closed', members: [{ phone: '48601000001', name: 'Ania' }, { phone: '48601000002', name: '' }], prefix: '', text: { mode: 'sender_body' } });
    const out = runSmsGroup(deps, closed, event({ text: 'Jutro zbiórka' }), NOW);
    expect(out).toMatchObject({ kind: 'sent', recipients: ['48601000002'], text: 'Ania: Jutro zbiórka' });
    const alone = make({ name: 'Sama', mode: 'closed', members: [{ phone: '48601000001', name: '' }], prefix: '', confirm: { enabled: true } });
    expect(runSmsGroup(deps, alone, event({ text: 'Halo' }), NOW)).toEqual({ kind: 'skipped', reason: 'no_recipients' });
    expect(events(alone.id)).toEqual([['skipped', 'brak odbiorców']]);
    expect(allMessages()).toHaveLength(1);
  });
  it('sender_body bez nazwy na liście podstawia numer', () => {
    const out = runSmsGroup(deps, lists({ senders: [{ phone: '48601000001', name: '' }], text: { mode: 'sender_body' } }), event(), NOW);
    expect(out).toMatchObject({ kind: 'sent', text: '48601000001: jutro zbiórka 8:00' });
  });
  it('warunek widzi body i sender; burza daje throttled bez potwierdzenia', () => {
    const cond = lists({ condition: { mode: 'builder', rules: [{ path: 'body', op: 'contains', value: 'pilne' }] } });
    expect(runSmsGroup(deps, cond, event(), NOW)).toEqual({ kind: 'skipped', reason: 'condition' });
    expect(events(cond.id)).toEqual([['skipped', 'warunek niespełniony']]);
    const liquidCond = lists({ name: 'Liquid', condition: { mode: 'liquid', expr: '{{ sender == "Ania" }}' } });
    expect(runSmsGroup(deps, liquidCond, event(), NOW)).toMatchObject({ kind: 'sent' });
    const storm = lists({ name: 'Burza', throttle: { limit: 1, windowMinutes: 10 }, confirm: { enabled: true } });
    runSmsGroup(deps, storm, event(), NOW);
    expect(runSmsGroup(deps, storm, event(), NOW)).toMatchObject({ kind: 'throttled', notify: true });
    expect(events(storm.id)[0]).toEqual(['throttled', 'ponad 1 w 10 min']);
    expect(allMessages().filter((m) => m.dest === '48601000001')).toHaveLength(1);
  });
  it('szablon Liquid z sender_name i recipients.size; błąd szablonu to wpis błąd bez wysyłki', () => {
    const liquid = lists({ text: { mode: 'liquid', template: '{{ sender_name }} do {{ recipients.size }}: {{ body | upcase }}' } });
    expect(runSmsGroup(deps, liquid, event(), NOW)).toMatchObject({ kind: 'sent', text: 'Ania do 2: JUTRO ZBIÓRKA 8:00' });
    const broken = lists({ name: 'Zły', text: { mode: 'liquid', template: '{{ body | nieznany }}' }, confirm: { enabled: true } });
    expect(runSmsGroup(deps, broken, event(), NOW)).toMatchObject({ kind: 'error', code: 'template' });
    expect(events(broken.id)[0]![0]).toBe('error');
    // Błąd szablonu to błąd ustawień, nie usługi: nadawca dostaje potwierdzenie o błędzie bramki.
    expect(allMessages().filter((m) => m.dest === '48601000001').map((m) => m.body)).toEqual(['Nie wysłano: błąd bramki, administrator został powiadomiony']);
  });
  it('szablon Liquid dający pustą treść to wpis błąd', () => {
    const empty = lists({ text: { mode: 'liquid', template: '{{ nic }}' } });
    expect(runSmsGroup(deps, empty, event(), NOW)).toMatchObject({ kind: 'error', code: 'empty_text' });
  });
  it('klucz bez dostępu albo konto wstrzymane to unavailable z wpisem błąd', () => {
    const g = lists();
    deps.apiKeys.revoke(apiKeyId);
    expect(runSmsGroup(deps, g, event(), NOW)).toMatchObject({ kind: 'unavailable' });
    expect(events(g.id)[0]![0]).toBe('error');
  });
  it('ładunek zdarzenia zapisuje się w dzienniku tylko przy włączonym przechowywaniu', () => {
    const plain = lists();
    runSmsGroup(deps, plain, event(), NOW);
    expect(deps.integrationEvents.list(plain.id, 1)[0]!.payload).toBeNull();
    const stored = make({ name: 'Z ładunkiem', senders: [{ phone: '48601000001', name: '' }], recipients: ['48601000002'], prefix: 'dzieci' }, 1);
    runSmsGroup(deps, stored, event(), NOW);
    expect(JSON.parse(deps.integrationEvents.list(stored.id, 1)[0]!.payload!)).toMatchObject({ from: '48601000001', text: 'Dzieci: jutro zbiórka 8:00' });
  });
});

describe('previewSmsGroup', () => {
  it('pokazuje nadawcę, prefiks, odbiorców, treść, części i potwierdzenie bez zapisu', () => {
    const g = lists({ confirm: { enabled: true } });
    const p = previewSmsGroup(deps.engine, g.config, event(), NOW);
    expect(p).toEqual({ senderAllowed: true, prefixMatched: true, body: 'jutro zbiórka 8:00', recipients: ['48601000002', '48601000003'], text: 'jutro zbiórka 8:00', parts: 1, confirm: 'Wysłano do 2 odbiorców', error: null });
    expect(previewSmsGroup(deps.engine, lists().config, event({ from: '48601000009', text: 'halo' }), NOW)).toMatchObject({ senderAllowed: false, prefixMatched: false, recipients: [], text: '', confirm: null });
    expect(deps.integrationEvents.list(g.id, 5)).toHaveLength(0);
    expect(allMessages()).toHaveLength(0);
  });
  it('obcy nadawca z dobrym prefiksem: prefiks pasuje, ale bez odbiorców i treści', () => {
    const p = previewSmsGroup(deps.engine, lists().config, event({ from: '48601000009' }), NOW);
    expect(p).toMatchObject({ senderAllowed: false, prefixMatched: true, body: 'jutro zbiórka 8:00', recipients: [], text: '' });
  });
  it('błąd szablonu i przepełnienie w podglądzie', () => {
    const broken = previewSmsGroup(deps.engine, lists({ text: { mode: 'liquid', template: '{{ body | nieznany }}' } }).config, event(), NOW);
    expect(broken.error).toBeTruthy();
    const long = previewSmsGroup(deps.engine, lists({ name: 'D', overflow: 'reject' }).config, event({ text: `dzieci ${'x'.repeat(400)}` }), NOW);
    expect(long.parts).toBeGreaterThan(1);
  });
});
