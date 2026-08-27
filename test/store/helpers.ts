import { randomBytes } from 'node:crypto';
import type { AccountInput } from '../../src/store/accounts.ts';
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
