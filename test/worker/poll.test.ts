import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL_GIVE_UP_MS, POLL_SCHEDULE_MS, handlePoll } from '../../src/worker/poll.ts';
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
const NOW = new Date('2026-08-25T10:00:00Z');

let deps: Parameters<typeof handlePoll>[1];
let info: ReturnType<typeof vi.fn>;
let accountId: number;
let apiKeyId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'C', keyPem: 'K', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'CA', certFingerprintSha1: 'AA',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: null, storeContent: 1, serviceIds: ['24138'],
  });
  const apiKeys = new ApiKeysRepo(db, masterKey);
  apiKeyId = apiKeys.insert({
    accountId, name: 'rejestracja', keyHash: 'argon2:aaa', keyPrefix: 'mig_live_a1b2c3',
    defaultServiceId: '24138', defaultOrig: null, maxParts: 9, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  info = vi.fn();
  deps = {
    accounts, apiKeys, messages: new MessagesRepo(db), jobs: new JobsRepo(db), events: new MessageEventsRepo(db),
    deliveries: new WebhookDeliveriesRepo(db, masterKey), packages: new PackagesRepo(db), inbound: new InboundMessagesRepo(db), reportsDir: '',
    clients: { for: () => ({ info }), invalidate: vi.fn(), closeAll: vi.fn() } as never,
  };
});

function seed(miIds: string[], parts = miIds.length, validTo: string | null = null) {
  const id = 'msg_1';
  deps.messages.insert({
    id, apiKeyId, accountId, serviceId: '24138', dest: '48601135134',
    body: 'x', bodyHash: 'h', encoding: 'gsm', parts, slots: 1,
    orig: null, costCenter: null, validTo, idempotencyKey: null,
  });
  deps.messages.setSent(id, miIds, NOW);
  const jobId = deps.jobs.enqueue('poll', { messageId: id }, NOW);
  return { id, job: { id: jobId, type: 'poll' as const, payload: { messageId: id }, attempts: 0, lastError: null } };
}

const reply = (status: number, substatus: number) =>
  ({ miId: '1', status, substatus, dest: '48601135134', orig: '', changedAt: '2026-08-25 10:00:05' });

describe('handlePoll', () => {
  it('zapisuje doręczenie po otrzymaniu raportu', async () => {
    const { id, job } = seed(['8841207']);
    info.mockResolvedValue(reply(21, 1));
    await handlePoll(job, deps, NOW);
    const stored = deps.messages.get(id)!;
    expect(stored.status).toBe('delivered');
    expect(stored.miStatus).toBe(21);
    expect(stored.miSubstatus).toBe(1);
    expect(stored.finalAt).not.toBeNull();
  });

  it('nie uznaje wysyłki bez potwierdzenia za doręczenie', async () => {
    const { id, job } = seed(['8841207']);
    info.mockResolvedValue(reply(21, 0));
    await handlePoll(job, deps, NOW);
    expect(deps.messages.get(id)!.status).toBe('sent');
  });

  it('składa status wieloczęściowy z części', async () => {
    const { id, job } = seed(['8841207', '8841208']);
    info.mockResolvedValueOnce(reply(21, 1)).mockResolvedValueOnce(reply(3, 0));
    await handlePoll(job, deps, NOW);
    expect(deps.messages.get(id)!.status).toBe('sent');
  });

  it('jedna nieudana część przesądza o całości', async () => {
    const { id, job } = seed(['8841207', '8841208']);
    info.mockResolvedValueOnce(reply(21, 1)).mockResolvedValueOnce(reply(11, 4));
    await handlePoll(job, deps, NOW);
    const stored = deps.messages.get(id)!;
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('SMSC - brak odpowiedzi');
  });

  it('przestaje odpytywać po osiągnięciu statusu ostatecznego', async () => {
    const { job } = seed(['8841207']);
    info.mockResolvedValue(reply(21, 1));
    await handlePoll(job, deps, NOW);
    expect(deps.jobs.claim(new Date(NOW.getTime() + 86_400_000), 10)).toHaveLength(0);
  });

  it('planuje kolejne pytanie według harmonogramu', async () => {
    const { job } = seed(['8841207']);
    info.mockResolvedValue(reply(3, 0));
    await handlePoll(job, deps, NOW);
    const before = new Date(NOW.getTime() + POLL_SCHEDULE_MS[1]! - 1);
    const after = new Date(NOW.getTime() + POLL_SCHEDULE_MS[1]! + 1);
    expect(deps.jobs.claim(before, 10)).toHaveLength(0);
    expect(deps.jobs.claim(after, 10)).toHaveLength(1);
  });

  it('oznacza wiadomość jako przedawnioną dwie godziny po terminie ważności', async () => {
    const validTo = new Date(NOW.getTime() - 3 * 3600_000).toISOString();
    const { id, job } = seed(['8841207'], 1, validTo);
    info.mockResolvedValue(reply(3, 0));
    await handlePoll(job, deps, NOW);
    const stored = deps.messages.get(id)!;
    expect(stored.status).toBe('expired');
    expect(deps.jobs.claim(new Date(NOW.getTime() + 86_400_000), 10)).toHaveLength(0);
  });

  it('po siedmiu dniach od przekazania bez statusu ostatecznego kończy wiadomość jako przedawnioną', async () => {
    const { id, job } = seed(['1']);
    info.mockResolvedValue(reply(3, 0));
    const late = new Date(NOW.getTime() + POLL_GIVE_UP_MS + 1);
    await handlePoll(job, deps, late);
    expect(info).toHaveBeenCalledTimes(1);
    const stored = deps.messages.get(id)!;
    expect(stored.status).toBe('expired');
    expect(stored.finalAt).toBe(late.toISOString());
    expect(stored.error).toContain('siedmiu dni');
    expect(deps.jobs.depth()).toBe(0);
    expect(deps.events.list(id).some((e) => e.kind === 'expired')).toBe(true);
  });

  it('status ostateczny odczytany w ostatnim pytaniu ma pierwszeństwo przed przedawnieniem', async () => {
    const { id, job } = seed(['1']);
    info.mockResolvedValue(reply(21, 1));
    await handlePoll(job, deps, new Date(NOW.getTime() + POLL_GIVE_UP_MS + 1));
    expect(deps.messages.get(id)!.status).toBe('delivered');
  });

  it('nieznany status zapisuje jako unknown i pyta dalej', async () => {
    const { id, job } = seed(['8841207']);
    info.mockResolvedValue(reply(99, 0));
    await handlePoll(job, deps, NOW);
    expect(deps.messages.get(id)!.status).toBe('unknown');
    expect(deps.jobs.claim(new Date(NOW.getTime() + 86_400_000), 10)).toHaveLength(1);
  });

  it('nie cofa anulowanej wiadomości do stanu sent, gdy Multiinfo nie ma jeszcze statusu ostatecznego', async () => {
    const { id, job } = seed(['1']);
    deps.messages.setStatus(id, { status: 'cancelled', finalAt: NOW });
    info.mockResolvedValue(reply(3, 0));
    await handlePoll(job, deps, NOW);
    expect(deps.messages.get(id)!.status).toBe('cancelled');
    expect(deps.jobs.depth()).toBe(1);
  });

  it('zapisuje stan ostateczny Multiinfo dla wiadomości anulowanej przez API', async () => {
    const { id, job } = seed(['1']);
    deps.messages.setStatus(id, { status: 'cancelled', finalAt: NOW });
    info.mockResolvedValue(reply(13, 0));
    await handlePoll(job, deps, NOW);
    const stored = deps.messages.get(id)!;
    expect(stored.status).toBe('cancelled');
    expect(stored.miStatus).toBe(13);
    expect(deps.jobs.depth()).toBe(0);
  });

  it('zapisuje zmianę statusu Multiinfo jako zdarzenie, ale nie powtarza tej samej', async () => {
    const { id, job } = seed(['1']);
    info.mockResolvedValue(reply(3, 0));
    await handlePoll(job, deps, NOW);
    await handlePoll({ ...job, attempts: 1 }, deps, NOW);
    info.mockResolvedValue(reply(21, 1));
    await handlePoll({ ...job, attempts: 2 }, deps, NOW);
    expect(deps.events.list(id).map((e) => e.detail)).toEqual([
      'status 3 / 0 - Oczekuje w SMSC', 'status 21 / 1 - Otrzymano raport doręczenia',
    ]);
    expect(deps.events.list(id).every((e) => e.kind === 'status')).toBe(true);
  });

  it('po stanie ostatecznym kolejkuje webhook message.delivered albo message.failed', async () => {
    deps.apiKeys.setWebhook(apiKeyId, 'https://crm.example/hook', 'sekret');
    const { id, job } = seed(['1']);
    info.mockResolvedValue(reply(21, 1));
    await handlePoll(job, deps, NOW);
    let delivery = deps.deliveries.listRecent(1)[0]!;
    expect(delivery.event).toBe('message.delivered');
    expect(JSON.parse(delivery.payload)).toMatchObject({ id, status: 'delivered', miStatus: 21, miSubstatus: 1, error: null });
    expect(deps.events.list(id).map((e) => e.kind)).toEqual(['status', 'webhook']);

    deps.messages.setStatus(id, { status: 'sent' });
    info.mockResolvedValue(reply(11, 2));
    await handlePoll(job, deps, NOW);
    delivery = deps.deliveries.listRecent(1)[0]!;
    expect(delivery.event).toBe('message.failed');
    expect(JSON.parse(delivery.payload)).toMatchObject({ status: 'failed', error: 'Wiadomość nie została doręczona' });
  });

  it('nie kolejkuje webhooka przy stanie pośrednim ani przy wysyłce bez raportu', async () => {
    deps.apiKeys.setWebhook(apiKeyId, 'https://crm.example/hook', 'sekret');
    const { job } = seed(['1']);
    info.mockResolvedValue(reply(3, 0));
    await handlePoll(job, deps, NOW);
    info.mockResolvedValue(reply(21, 0));
    await handlePoll(job, deps, NOW);
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 0 });
  });

  it('przedawnienie kolejkuje webhook message.failed ze statusem expired', async () => {
    deps.apiKeys.setWebhook(apiKeyId, 'https://crm.example/hook', 'sekret');
    const validTo = new Date(NOW.getTime() - 3 * 3600_000).toISOString();
    const { job } = seed(['8841207'], 1, validTo);
    await handlePoll(job, deps, NOW);
    const delivery = deps.deliveries.listRecent(1)[0]!;
    expect(delivery.event).toBe('message.failed');
    expect(JSON.parse(delivery.payload)).toMatchObject({ status: 'expired' });
  });

  it('zapisuje przedawnienie jako zdarzenie', async () => {
    const validTo = new Date(NOW.getTime() - 3 * 3600_000).toISOString();
    const { id, job } = seed(['8841207'], 1, validTo);
    await handlePoll(job, deps, NOW);
    expect(deps.events.list(id).map((e) => e.kind)).toEqual(['expired']);
  });
});
