import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo, type ApiKeyInput } from '../../src/store/api-keys.ts';
import { InboundServicesRepo } from '../../src/store/inbound-services.ts';
import { accountInput, testKey } from './helpers.ts';

const NOW = new Date('2026-08-29T10:00:00Z');
let accounts: AccountsRepo;
let keys: ApiKeysRepo;
let repo: InboundServicesRepo;
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
