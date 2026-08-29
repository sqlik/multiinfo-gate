import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import type { ReceiverDeps } from '../../src/inbound/receiver.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo, type ApiKeyInput } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { InboundServicesRepo } from '../../src/store/inbound-services.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { WebhookDeliveriesRepo } from '../../src/store/webhook-deliveries.ts';

const masterKey = randomBytes(32);

export const NOW = new Date('2026-08-29T07:14:02Z');

/** Wiadomość, jaką wydaje getsms.aspx po sparsowaniu; data w czasie polskim. */
export const SMS = {
  miId: '22', sender: '48601000001', dest: '7968', kind: 'text' as const, content: 'Dziekuje, jasne',
  protocolId: 0, codingScheme: 0, serviceId: '24138', connectorId: '60199', receivedAt: '20260829091400',
};

export const keyInput = (accountId: number, over: Partial<ApiKeyInput> = {}): ApiKeyInput => ({
  // Skrót klucza jest unikalny w bazie - pochodzi od prefiksu.
  accountId, name: 'crm', keyHash: `argon2:${over.keyPrefix ?? 'p'}`, keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
  maxParts: 9, ratePerMin: 60, webhookUrl: 'https://crm.example/hook', webhookSecret: 's',
  serviceIds: ['24138'], inboundSubscribed: 1, ...over,
});

export function buildReceiverDeps() {
  const db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const accountId = accounts.insert({
    name: 'Firma', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/', login: 'firma_api', password: 't',
    certPem: 'C', keyPem: 'K', caPem: null, certCn: 'firma_api', certIssuerCn: 'CA', certFingerprintSha1: 'AA',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14', defaultCountryCode: '48', defaultOrig: null,
    storeContent: 1, serviceIds: ['24138'],
  });
  const getSms = vi.fn();
  const confirmSms = vi.fn().mockResolvedValue(undefined);
  const deps: ReceiverDeps = {
    accounts, apiKeys: new ApiKeysRepo(db, masterKey), inbound: new InboundMessagesRepo(db),
    services: new InboundServicesRepo(db), messages: new MessagesRepo(db),
    deliveries: new WebhookDeliveriesRepo(db), jobs: new JobsRepo(db),
    clients: { for: () => ({ getSms, confirmSms }), invalidate: vi.fn(), closeAll: vi.fn() } as never,
    timeoutMs: 60_000, idleMs: 0, now: () => NOW, sleep: async () => {},
  };
  return { db, deps, accountId, getSms, confirmSms };
}
