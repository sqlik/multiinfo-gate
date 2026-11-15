import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { defaultAgentConfig } from '../../src/integrations/config.ts';
import { AccountsRepo, type AccountInput } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import type { MessageInput } from '../../src/store/messages.ts';

export const testKey = () => randomBytes(32);

export function accountInput(overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    name: 'Firma',
    baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api',
    password: 'hasło-operatora',
    certPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
    keyPem: '-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\n',
    caPem: null,
    certCn: 'firma_test',
    certIssuerCn: 'firma_test',
    certFingerprintSha1: 'AA:BB:CC',
    certNotBefore: '2026-01-01T00:00:00.000Z',
    certNotAfter: '2027-01-01T00:00:00.000Z',
    defaultCountryCode: '48',
    defaultOrig: null,
    storeContent: 0,
    serviceIds: ['24138'],
    ...overrides,
  };
}

export function messageInput(overrides: Partial<MessageInput> = {}): MessageInput {
  return {
    id: 'msg_1',
    apiKeyId: 1,
    accountId: 1,
    serviceId: '24138',
    dest: '48601135134',
    body: null,
    bodyHash: 'sha256:aaa',
    encoding: 'gsm',
    parts: 1,
    slots: 11,
    orig: null,
    costCenter: null,
    validTo: null,
    idempotencyKey: null,
    ...overrides,
  };
}

/** Konto, klucz API i integracja „Agent AI” do testów repozytoriów połączeń agentów. */
export function seedAgentIntegration(db: Database, key: Buffer, name = 'Agent AI - dyspozytornia'): { accountId: number; apiKeyId: number; integrationId: number } {
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const apiKeyId = new ApiKeysRepo(db, key).insert({
    accountId, name: 'dyspozytornia', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  const integrationId = new IntegrationsRepo(db, key).insert({
    name, kind: 'agent', apiKeyId, serviceId: null, orig: null, preset: 'agent', enabled: 1,
    config: defaultAgentConfig(), secrets: {}, storePayloads: 0, createdAt: new Date('2026-11-15T08:00:00Z'),
  });
  return { accountId, apiKeyId, integrationId };
}
