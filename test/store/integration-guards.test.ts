import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { defaultInboundConfig } from '../../src/integrations/config.ts';
import { accountInput } from './helpers.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
let guards: IntegrationGuardsRepo;
let integrationId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const apiKeyId = new ApiKeysRepo(db, key).insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
  integrationId = new IntegrationsRepo(db, key).insert({ name: 'x', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1, config: defaultInboundConfig(), secrets: {}, storePayloads: 0, createdAt: NOW });
  guards = new IntegrationGuardsRepo(db);
});

describe('dedup', () => {
  it('drugi raz ten sam klucz to duplikat; po czyszczeniu znów nowy', () => {
    expect(guards.dedup(integrationId, 'evt-1', NOW)).toBe(true);
    expect(guards.dedup(integrationId, 'evt-1', NOW)).toBe(false);
    expect(guards.dedup(integrationId, 'evt-2', NOW)).toBe(true);
    expect(guards.pruneDedupBefore(later(1))).toBe(2);
    expect(guards.dedup(integrationId, 'evt-1', later(2))).toBe(true);
  });
});

describe('throttle', () => {
  it('przepuszcza limit, potem odrzuca; powiadomienie raz na okno; nowe okno zeruje', () => {
    for (let i = 0; i < 3; i += 1) expect(guards.throttle(integrationId, 3, 10, NOW)).toEqual({ allowed: true, notify: false });
    expect(guards.throttle(integrationId, 3, 10, later(1))).toEqual({ allowed: false, notify: true });
    expect(guards.throttle(integrationId, 3, 10, later(2))).toEqual({ allowed: false, notify: false });
    expect(guards.throttle(integrationId, 3, 10, later(11))).toEqual({ allowed: true, notify: false });
    // Nowe okno startuje od pierwszego zdarzenia po wygaśnięciu, a powiadomienie znów jest możliwe.
    for (let i = 0; i < 2; i += 1) guards.throttle(integrationId, 3, 10, later(11));
    expect(guards.throttle(integrationId, 3, 10, later(12))).toEqual({ allowed: false, notify: true });
  });
});
