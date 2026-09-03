import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultOutboundConfig, type OutboundConfig } from '../../src/integrations/config.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { buildOutboundContext, emitIntegrations, previewOutbound, renderOutbound } from '../../src/worker/integrations.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { WebhookDeliveriesRepo } from '../../src/store/webhook-deliveries.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
let deps: Parameters<typeof emitIntegrations>[0];
let integrations: IntegrationsRepo;
let apiKeyId: number;
const notify = vi.fn();

beforeEach(() => {
  notify.mockReset();
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  apiKeyId = new ApiKeysRepo(db, key).insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
  integrations = new IntegrationsRepo(db, key);
  // Dostawa odebranej wskazuje wiadomość kluczem obcym - musi istnieć.
  new InboundMessagesRepo(db).insertIfNew({ id: 'in_1', accountId, serviceId: '24138', miId: '1', sender: '48601000001', dest: '7968', kind: 'text', body: 'Pomocy', bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null, receivedAt: NOW.toISOString(), createdAt: NOW.toISOString() });
  deps = {
    integrations, integrationEvents: new IntegrationEventsRepo(db, key), guards: new IntegrationGuardsRepo(db),
    deliveries: new WebhookDeliveriesRepo(db, key), jobs: new JobsRepo(db), engine: new TemplateEngine(), notifier: { notify },
  };
});

const make = (config: Partial<OutboundConfig>, secrets: Record<string, string> = {}, name = 'HA') => integrations.insert({
  name, kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
  config: { ...defaultOutboundConfig(), url: 'https://ha.example/api/webhook/x', body: { mode: 'json', template: '{"from": {{ from | json }}, "text": {{ text | json }}}' }, ...config },
  secrets, storePayloads: 0, createdAt: NOW,
});
const received = { id: 'in_1', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text: 'Pomocy', receivedAt: NOW.toISOString(), relatedMessageId: null };

describe('emitIntegrations', () => {
  it('tworzy dostawę z metodą, nagłówkami i body z szablonu; kolejkuje zadanie webhook', () => {
    const integ = make({ method: 'PUT', headers: [{ name: 'Authorization', valueRef: 'auth' }, { name: 'X-Source', value: 'gate {{ integration.name }}' }] }, { auth: 'Bearer t' });
    const ids = emitIntegrations(deps, apiKeyId, 'message.received', received, NOW, { inboundId: 'in_1' });
    expect(ids).toHaveLength(1);
    const d = deps.deliveries.get(ids[0]!)!;
    expect(d.method).toBe('PUT');
    expect(d.url).toBe('https://ha.example/api/webhook/x');
    expect(d.integrationId).toBe(integ);
    expect(JSON.parse(d.payload)).toEqual({ from: '48601000001', text: 'Pomocy' });
    expect(deps.deliveries.headers(d.id)).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer t', 'X-Source': 'gate HA' });
    expect(d.inboundId).toBe('in_1');
    expect(deps.jobs.depth()).toBe(1);
    expect(deps.integrationEvents.list(integ, 5)[0]).toMatchObject({ result: 'sent', deliveryId: d.id, inboundId: 'in_1' });
  });
  it('pomija integracje bez tego zdarzenia, wyłączone i z niespełnionym warunkiem', () => {
    make({ events: ['message.delivered'] });
    const off = make({}, {}, 'off');
    integrations.setEnabled(off, false, NOW);
    const cond = make({ condition: { mode: 'builder', rules: [{ path: 'text', op: 'starts', value: 'POMOC' }] } }, {}, 'warunek');
    expect(emitIntegrations(deps, apiKeyId, 'message.received', received, NOW)).toEqual([]);
    expect(deps.integrationEvents.list(cond, 5)[0]!.result).toBe('skipped');
    expect(deps.jobs.depth()).toBe(0);
  });
  it('warunek widzi pola zdarzenia pod p', () => {
    make({ condition: { mode: 'builder', rules: [{ path: 'text', op: 'starts', value: 'Pomoc' }, { path: 'event', op: 'eq', value: 'message.received' }] } });
    expect(emitIntegrations(deps, apiKeyId, 'message.received', received, NOW)).toHaveLength(1);
  });
  it('body, które nie jest JSON-em, to wpis error bez dostawy i powiadomienie', () => {
    const id = make({ body: { mode: 'json', template: '{"a": {{ text }}' } });
    expect(emitIntegrations(deps, apiKeyId, 'message.received', received, NOW)).toEqual([]);
    expect(deps.integrationEvents.list(id, 5)[0]!.result).toBe('error');
    expect(notify).toHaveBeenCalledWith('integration_error', `integration:${id}`, expect.stringContaining('JSON'), NOW);
  });
  it('limit burzy odrzuca nadmiar z jednym powiadomieniem', () => {
    make({ throttle: { limit: 1, windowMinutes: 10 } });
    expect(emitIntegrations(deps, apiKeyId, 'message.received', received, NOW)).toHaveLength(1);
    expect(emitIntegrations(deps, apiKeyId, 'message.received', received, NOW)).toEqual([]);
    expect(emitIntegrations(deps, apiKeyId, 'message.received', received, NOW)).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe('integration_throttled');
  });
  it('tryb formularza składa application/x-www-form-urlencoded', () => {
    make({ body: { mode: 'form', fields: [{ name: 'message', template: '{{ text }}' }, { name: 'title', template: 'SMS od {{ from }}' }] } });
    const [id] = emitIntegrations(deps, apiKeyId, 'message.received', received, NOW);
    expect(deps.deliveries.get(id!)!.payload).toBe('message=Pomocy&title=SMS+od+48601000001');
    expect(deps.deliveries.headers(id!)['Content-Type']).toBe('application/x-www-form-urlencoded');
  });
  it('wiele integracji na jedno zdarzenie daje osobne dostawy', () => {
    make({});
    make({}, {}, 'Slack');
    expect(emitIntegrations(deps, apiKeyId, 'message.received', received, NOW)).toHaveLength(2);
    expect(deps.jobs.depth()).toBe(2);
  });
  it('przechowuje ładunek zdarzenia tylko gdy włączone', () => {
    const id = integrations.insert({ name: 'Z', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1, config: { ...defaultOutboundConfig(), url: 'https://x.example', body: { mode: 'json', template: '{}' } }, secrets: {}, storePayloads: 1, createdAt: NOW });
    emitIntegrations(deps, apiKeyId, 'message.received', received, NOW);
    expect(deps.integrationEvents.latestPayload(id)).toContain('"text":"Pomocy"');
  });
});

describe('renderOutbound', () => {
  it('sekretne nagłówki są podstawiane poza silnikiem - szablon ich nie widzi', () => {
    const config: OutboundConfig = { ...defaultOutboundConfig(), url: 'https://x.example', headers: [{ name: 'X-Token', valueRef: 't' }], body: { mode: 'json', template: '{"t": "{{ secrets }}", "s": "{{ t }}", "h": "{{ headers }}"}' } };
    const out = renderOutbound(new TemplateEngine(), config, { t: 'sekret' }, buildOutboundContext('message.received', received, { name: 'x' }, NOW));
    expect(out.body).toBe('{"t": "", "s": "", "h": ""}');
    expect(out.headers['X-Token']).toBe('sekret');
  });
  it('p zawiera całe zdarzenie z event i at', () => {
    const config: OutboundConfig = { ...defaultOutboundConfig(), url: 'https://x.example', body: { mode: 'json', template: '{{ p | json }}' } };
    const out = renderOutbound(new TemplateEngine(), config, {}, buildOutboundContext('message.received', received, { name: 'x' }, NOW));
    expect(JSON.parse(out.body)).toEqual({ event: 'message.received', at: NOW.toISOString(), ...received });
  });
});

describe('previewOutbound', () => {
  it('maskuje sekrety i zgłasza błąd szablonu', () => {
    const config: OutboundConfig = { ...defaultOutboundConfig(), url: 'https://x.example', headers: [{ name: 'X-Token', valueRef: 't' }], body: { mode: 'json', template: '{"from": {{ from | json }}}' } };
    const ok = previewOutbound(new TemplateEngine(), config, ['t'], received, NOW);
    expect(ok).toEqual({ headers: { 'Content-Type': 'application/json', 'X-Token': '••••' }, body: '{"from": "48601000001"}', error: null });
    const bad = previewOutbound(new TemplateEngine(), { ...config, body: { mode: 'json', template: '{{ from | brak }}' } }, [], received, NOW);
    expect(bad.error).toMatch(/brak/);
  });
});
