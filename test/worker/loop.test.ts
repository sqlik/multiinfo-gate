import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UNEXPECTED_ATTEMPTS, UNEXPECTED_BACKOFF_CAP_MS, Worker } from '../../src/worker/loop.ts';
import type { WorkerDeps } from '../../src/worker/send.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { WebhookDeliveriesRepo } from '../../src/store/webhook-deliveries.ts';

const masterKey = randomBytes(32);
const TRACE = { at: '', durationMs: 1, script: 'sendsmslong.aspx', params: {}, httpStatus: 200, lines: ['1'] };

let deps: WorkerDeps;
let clock: Date;
let sendLong: ReturnType<typeof vi.fn>;
let clientsFor: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clock = new Date('2026-08-25T10:00:00Z');
  const db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const accountId = accounts.insert({
    name: 'Firma', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/', login: 'firma_api', password: 't',
    certPem: 'C', keyPem: 'K', caPem: null, certCn: 'firma_api', certIssuerCn: 'CA', certFingerprintSha1: 'AA',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14', defaultCountryCode: '48', defaultOrig: null,
    storeContent: 1, serviceIds: ['24138'],
  });
  const apiKeys = new ApiKeysRepo(db, masterKey);
  const apiKeyId = apiKeys.insert({
    accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  const messages = new MessagesRepo(db);
  for (const id of ['msg_1', 'msg_2']) {
    messages.insert({
      id, apiKeyId, accountId, serviceId: '24138', dest: '48601135134', body: 'x', bodyHash: 'h',
      encoding: 'gsm', parts: 1, slots: 1, orig: null, costCenter: null, validTo: null, idempotencyKey: null,
    });
  }
  sendLong = vi.fn();
  clientsFor = vi.fn(() => ({ sendLong }));
  deps = {
    accounts, apiKeys, messages, jobs: new JobsRepo(db), events: new MessageEventsRepo(db),
    deliveries: new WebhookDeliveriesRepo(db), packages: new PackagesRepo(db), inbound: new InboundMessagesRepo(db), reportsDir: '',
    clients: { for: clientsFor, invalidate: vi.fn(), closeAll: vi.fn() } as never,
  };
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('Worker.tick', () => {
  it('wykonuje zadania z jednej partii równolegle, nie po kolei', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    sendLong.mockImplementation(async () => { await gate; return { miIds: ['1'], trace: TRACE }; });
    deps.jobs.enqueue('send', { messageId: 'msg_1', text: 'x', deliveryReport: true }, clock);
    deps.jobs.enqueue('send', { messageId: 'msg_2', text: 'x', deliveryReport: true }, clock);

    const worker = new Worker(deps, { now: () => clock });
    const tick = worker.tick();
    await flush();
    // Oba wywołania Multiinfo trwają jednocześnie - drugie nie czeka na pierwsze.
    expect(sendLong).toHaveBeenCalledTimes(2);
    release();
    await tick;
    expect(deps.messages.get('msg_1')!.status).toBe('sent');
    expect(deps.messages.get('msg_2')!.status).toBe('sent');
  });

  it('wyjątek spoza obsługi zadania ponawia je z rosnącym odstępem, a po limicie porzuca', async () => {
    deps.messages.setSent('msg_1', ['1'], clock);
    deps.jobs.enqueue('poll', { messageId: 'msg_1' }, clock);
    clientsFor.mockImplementation(() => { throw new Error('zły klucz główny albo naruszona wartość'); });
    const worker = new Worker(deps, { now: () => clock });

    for (let attempt = 1; attempt <= MAX_UNEXPECTED_ATTEMPTS; attempt += 1) {
      await worker.tick();
      expect(deps.jobs.depth()).toBe(attempt < MAX_UNEXPECTED_ATTEMPTS ? 1 : 0);
      clock = new Date(clock.getTime() + UNEXPECTED_BACKOFF_CAP_MS + 1);
    }
    expect(clientsFor).toHaveBeenCalledTimes(MAX_UNEXPECTED_ATTEMPTS);
    const abandoned = deps.events.list('msg_1').find((e) => e.kind === 'abandoned');
    expect(abandoned?.detail).toContain('poll');
    expect(abandoned?.detail).toContain('zły klucz główny');
    // Odpytywanie porzucone, ale stan wiadomości nie jest zgadywany.
    expect(deps.messages.get('msg_1')!.status).toBe('sent');
  });

  it('odstęp między ponowieniami rośnie: minuta, potem dwie', async () => {
    deps.messages.setSent('msg_1', ['1'], clock);
    deps.jobs.enqueue('poll', { messageId: 'msg_1' }, clock);
    clientsFor.mockImplementation(() => { throw new Error('awaria'); });
    const worker = new Worker(deps, { now: () => clock });

    await worker.tick();
    clock = new Date(clock.getTime() + 30_000);
    await worker.tick();
    expect(clientsFor).toHaveBeenCalledTimes(1);
    clock = new Date(clock.getTime() + 30_001);
    await worker.tick();
    expect(clientsFor).toHaveBeenCalledTimes(2);
    clock = new Date(clock.getTime() + 60_001);
    await worker.tick();
    expect(clientsFor).toHaveBeenCalledTimes(2);
    clock = new Date(clock.getTime() + 60_000);
    await worker.tick();
    expect(clientsFor).toHaveBeenCalledTimes(3);
  });

  it('porzucone zadanie wysyłki kończy wiadomość niepowodzeniem', async () => {
    deps.jobs.enqueue('send', { messageId: 'msg_1', text: 'x', deliveryReport: true }, clock);
    const get = vi.spyOn(deps.messages, 'get').mockImplementation(() => { throw new Error('baza niedostępna'); });
    const worker = new Worker(deps, { now: () => clock });
    for (let attempt = 1; attempt <= MAX_UNEXPECTED_ATTEMPTS; attempt += 1) {
      await worker.tick();
      clock = new Date(clock.getTime() + UNEXPECTED_BACKOFF_CAP_MS + 1);
    }
    get.mockRestore();
    expect(deps.jobs.depth()).toBe(0);
    const stored = deps.messages.get('msg_1')!;
    expect(stored.status).toBe('failed');
    expect(stored.error).toContain('baza niedostępna');
    expect(deps.events.list('msg_1').some((e) => e.kind === 'failed')).toBe(true);
  });
});
