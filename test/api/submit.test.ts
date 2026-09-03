import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors.ts';
import { authFromKey, keyUsable, submitMessages } from '../../src/api/submit.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { defaultInboundConfig } from '../../src/integrations/config.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
let deps: Parameters<typeof submitMessages>[0];
let apiKeys: ApiKeysRepo;
let apiKeyId: number;
let integrationId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accounts = new AccountsRepo(db, key);
  const accountId = accounts.insert(accountInput({ storeContent: 1 }));
  apiKeys = new ApiKeysRepo(db, key);
  apiKeyId = apiKeys.insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
  integrationId = new IntegrationsRepo(db, key).insert({ name: 'Kuma', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1, config: defaultInboundConfig(), secrets: {}, storePayloads: 0, createdAt: NOW });
  deps = { accounts, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db), inbound: new InboundMessagesRepo(db) };
});

describe('submitMessages', () => {
  it('tworzy wiadomości dla każdego odbiorcy i kolejkuje wysyłkę ze śladem integracji', () => {
    const auth = authFromKey(apiKeys.get(apiKeyId)!);
    const out = submitMessages(deps, auth, { to: ['48601000001', '+48 601 000 002'], text: 'Cześć', integrationId }, NOW);
    expect(out).toHaveLength(2);
    expect(out[0]!.status).toBe('queued');
    expect(deps.messages.get(out[1]!.id)!.dest).toBe('48601000002');
    expect(deps.messages.get(out[0]!.id)!.integrationId).toBe(integrationId);
    expect(deps.messages.get(out[0]!.id)!.createdAt).toBe(NOW.toISOString());
    expect(deps.jobs.depth()).toBe(2);
  });
  it('bez integracji ślad jest pusty', () => {
    const auth = authFromKey(apiKeys.get(apiKeyId)!);
    const [m] = submitMessages(deps, auth, { to: ['48601000001'], text: 'x' }, NOW);
    expect(deps.messages.get(m!.id)!.integrationId).toBeNull();
  });
  it('zły numer to ApiError invalid_phone bez zapisu', () => {
    const auth = authFromKey(apiKeys.get(apiKeyId)!);
    expect(() => submitMessages(deps, auth, { to: ['48601000001', 'abc'], text: 'x' }, NOW)).toThrow(ApiError);
    expect(deps.jobs.depth()).toBe(0);
  });
  it('za długa treść to too_many_parts', () => {
    const auth = authFromKey(apiKeys.get(apiKeyId)!);
    expect(() => submitMessages(deps, auth, { to: ['48601000001'], text: 'x'.repeat(700) }, NOW)).toThrow(/too_many_parts|części/);
  });
});

describe('keyUsable', () => {
  it('czynny klucz się nadaje', () => {
    expect(keyUsable(apiKeys.get(apiKeyId)!, NOW)).toEqual({ ok: true });
  });
  it('odwołany i wygasły klucz nie nadają się', () => {
    apiKeys.revoke(apiKeyId);
    expect(keyUsable(apiKeys.get(apiKeyId)!, NOW)).toMatchObject({ ok: false, reason: /odwołany/ });
    const expired = apiKeys.insert({ accountId: apiKeys.get(apiKeyId)!.accountId, name: 'e', keyHash: 'h2', keyPrefix: 'p2', defaultServiceId: '24138', defaultOrig: null, maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], expiresAt: '2026-09-01T21:59:59.999Z' });
    expect(keyUsable(apiKeys.get(expired)!, NOW)).toMatchObject({ ok: false, reason: /wygasł 2026-09-01/ });
  });
});
