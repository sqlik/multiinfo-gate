import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo, type ApiKeyInput } from '../../src/store/api-keys.ts';
import { InboundServicesRepo } from '../../src/store/inbound-services.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { defaultOutboundConfig } from '../../src/integrations/config.ts';
import { accountInput, testKey } from './helpers.ts';

const NOW = new Date('2026-08-29T10:00:00Z');
let accounts: AccountsRepo;
let keys: ApiKeysRepo;
let repo: InboundServicesRepo;
let integrations: IntegrationsRepo;
let accountId: number;

const key = (over: Partial<ApiKeyInput> = {}): ApiKeyInput => ({
  accountId, name: 'crm', keyHash: `argon2:${over.keyPrefix ?? 'p'}`, keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
  maxParts: 9, ratePerMin: 60, webhookUrl: 'https://crm.example/hook', webhookSecret: 's',
  serviceIds: ['24138'], inboundSubscribed: 1, ...over,
});

beforeEach(() => {
  const db = openDatabase(':memory:');
  const mk = testKey();
  accounts = new AccountsRepo(db, mk);
  keys = new ApiKeysRepo(db, mk);
  repo = new InboundServicesRepo(db);
  integrations = new IntegrationsRepo(db, mk);
  accountId = accounts.insert(accountInput({ serviceIds: ['24138', '24902'] }));
});

describe('InboundServicesRepo.activeTargets', () => {
  it('bez subskrybujących kluczy nie ma celów', () => {
    expect(repo.activeTargets(NOW)).toEqual([]);
  });
  it('jeden cel na usługę, niezależnie od liczby kluczy', () => {
    keys.insert(key());
    keys.insert(key({ keyPrefix: 'p2', name: 'drugi' }));
    keys.insert(key({ keyPrefix: 'p3', serviceIds: ['24138', '24902'] }));
    expect(repo.activeTargets(NOW)).toEqual([{ accountId, serviceId: '24138' }, { accountId, serviceId: '24902' }]);
  });
  it('konto wstrzymane albo wyłączone wypada', () => {
    keys.insert(key());
    accounts.pause(accountId, 'certyfikat');
    expect(repo.activeTargets(NOW)).toEqual([]);
    accounts.resume(accountId);
    expect(repo.activeTargets(NOW)).toHaveLength(1);
  });
  it('klucz odwołany, wygasły albo bez webhooka nie zapala odbioru', () => {
    const id = keys.insert(key());
    keys.revoke(id);
    keys.insert(key({ keyPrefix: 'p2', expiresAt: '2026-08-29T09:00:00.000Z' }));
    keys.insert(key({ keyPrefix: 'p3', webhookUrl: null, webhookSecret: null }));
    expect(repo.activeTargets(NOW)).toEqual([]);
  });
  it('cel odbioru powstaje też z włączonej integracji wychodzącej na message.received', () => {
    // Klucz bez adresu webhooka i bez subskrypcji, ale z integracją wychodzącą.
    const apiKeyId = keys.insert(key({ webhookUrl: null, webhookSecret: null, inboundSubscribed: 0 }));
    expect(repo.activeTargets(NOW)).toEqual([]);
    const id = integrations.insert({
      name: 'HA', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
      config: { ...defaultOutboundConfig(), url: 'https://ha.example/x' }, secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    expect(repo.activeTargets(NOW)).toEqual([{ accountId, serviceId: '24138' }]);
    integrations.setEnabled(id, false, NOW);
    expect(repo.activeTargets(NOW)).toEqual([]);
    // Integracja tylko na statusy wysyłki nie zapala odbioru; subskrybent i integracja razem dają jeden cel.
    integrations.setEnabled(id, true, NOW);
    integrations.update(id, { name: 'HA', serviceId: null, orig: null, preset: 'custom', enabled: 1, storePayloads: 0, config: { ...defaultOutboundConfig(), url: 'https://ha.example/x', events: ['message.delivered'] } }, NOW);
    expect(repo.activeTargets(NOW)).toEqual([]);
    integrations.update(id, { name: 'HA', serviceId: null, orig: null, preset: 'custom', enabled: 1, storePayloads: 0, config: { ...defaultOutboundConfig(), url: 'https://ha.example/x' } }, NOW);
    keys.insert(key({ keyPrefix: 'p2' }));
    expect(repo.activeTargets(NOW)).toEqual([{ accountId, serviceId: '24138' }]);
  });
});

describe('InboundServicesRepo - stan usługi', () => {
  it('zapisuje ostatnie pytanie, ostatnią odebraną i błąd', () => {
    const t = { accountId, serviceId: '24138' };
    repo.markPolled(t, NOW);
    repo.markReceived(t, new Date(NOW.getTime() + 1000));
    repo.setError(t, '-24 usługa nieaktywna');
    expect(repo.states(accountId)).toEqual([
      { serviceId: '24138', lastPollAt: NOW.toISOString(), lastReceivedAt: new Date(NOW.getTime() + 1000).toISOString(), error: '-24 usługa nieaktywna' },
      { serviceId: '24902', lastPollAt: null, lastReceivedAt: null, error: null },
    ]);
    expect(repo.errors()).toEqual([{ accountId, accountName: 'Firma', serviceId: '24138', error: '-24 usługa nieaktywna' }]);
    repo.setError(t, null);
    expect(repo.errors()).toEqual([]);
  });
});
