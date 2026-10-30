import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { defaultInboundConfig, defaultSmsGroupConfig } from '../../src/integrations/config.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { accountInput } from './helpers.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
let events: IntegrationEventsRepo;
let integrations: IntegrationsRepo;
let db: ReturnType<typeof openDatabase>;
let integrationId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const apiKeyId = new ApiKeysRepo(db, key).insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
  integrations = new IntegrationsRepo(db, key);
  integrationId = integrations.insert({ name: 'x', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1, config: defaultInboundConfig(), secrets: {}, storePayloads: 1, createdAt: NOW });
  events = new IntegrationEventsRepo(db, key);
  new InboundMessagesRepo(db).insertIfNew({ id: 'in_1', accountId, serviceId: '24138', miId: '1', sender: '48601000001', dest: '7968', kind: 'text', body: 'x', bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null, receivedAt: NOW.toISOString(), createdAt: NOW.toISOString() });
  groupId = integrations.insert({ name: 'Grupa', kind: 'sms_group', apiKeyId, serviceId: null, orig: null, preset: 'sms-grupa', enabled: 1, config: defaultSmsGroupConfig(), secrets: {}, storePayloads: 0, createdAt: NOW });
});
let groupId: number;

describe('IntegrationEventsRepo', () => {
  it('listGroupForInbound: wpisy grup SMS dla odebranej wiadomości z nazwą integracji, bez wpisów innych rodzajów', () => {
    events.record({ integrationId: groupId, at: NOW, result: 'sent', reason: '2 odbiorców', inboundId: 'in_1', messageId: 'msg_1', logLimit: 200 });
    events.record({ integrationId, at: NOW, result: 'sent', inboundId: 'in_1', logLimit: 200 });
    events.record({ integrationId: groupId, at: NOW, result: 'skipped', reason: 'bez prefiksu', inboundId: 'in_1', logLimit: 200 });
    expect(events.listGroupForInbound('in_1').map((e) => [e.integrationName, e.result, e.reason])).toEqual([['Grupa', 'skipped', 'bez prefiksu'], ['Grupa', 'sent', '2 odbiorców']]);
    expect(events.listGroupForInbound('in_9')).toEqual([]);
  });
  it('zapisuje wpis, szyfruje ładunek i odnotowuje ostatnie zdarzenie', () => {
    const id = events.record({ integrationId, at: NOW, result: 'sent', messageId: 'msg_1', payload: '{"secret":"x"}', logLimit: 200 });
    const raw = db.prepare('SELECT payload_enc FROM integration_events WHERE id = ?').get(id) as { payload_enc: string };
    expect(raw.payload_enc).not.toContain('secret');
    expect(events.get(id)!.payload).toBe('{"secret":"x"}');
    expect(events.latest(integrationId)!.id).toBe(id);
    expect(integrations.get(integrationId)!.lastEventAt).toBe(NOW.toISOString());
  });
  it('przycina dziennik do limitu', () => {
    for (let i = 0; i < 25; i += 1) events.record({ integrationId, at: NOW, result: 'skipped', logLimit: 20 });
    expect(events.list(integrationId, 100)).toHaveLength(20);
  });
  it('przycina powód i odpowiedź', () => {
    const id = events.record({ integrationId, at: NOW, result: 'delivered', reason: 'r'.repeat(600), response: 'o'.repeat(400), logLimit: 200 });
    expect(events.get(id)!.reason).toHaveLength(500);
    expect(events.get(id)!.response).toHaveLength(300);
  });
  it('latestPayload i countsSince', () => {
    events.record({ integrationId, at: NOW, result: 'error', reason: 'pusta treść', payload: '{"a":1}', logLimit: 200 });
    events.record({ integrationId, at: NOW, result: 'sent', payload: '{"a":2}', logLimit: 200 });
    expect(events.latestPayload(integrationId)).toBe('{"a":2}');
    expect(events.countsSince(integrationId, new Date(0))).toEqual({ sent: 1, errors: 1 });
  });
  it('scrubPayloadsBefore zeruje stare ładunki', () => {
    events.record({ integrationId, at: new Date('2026-08-01T00:00:00Z'), result: 'sent', payload: '{"a":1}', logLimit: 200 });
    expect(events.scrubPayloadsBefore(NOW)).toBe(1);
    expect(events.latestPayload(integrationId)).toBeNull();
  });
  it('usunięcie integracji kasuje jej dziennik', () => {
    events.record({ integrationId, at: NOW, result: 'sent', logLimit: 200 });
    integrations.remove(integrationId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM integration_events').get()).toEqual({ n: 0 });
  });
});
