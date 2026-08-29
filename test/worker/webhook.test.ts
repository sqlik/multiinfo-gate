import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WEBHOOK_BACKOFF_MS, emitWebhook, handleWebhook, signWebhook } from '../../src/worker/webhook.ts';
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
const TIMESTAMP = Math.floor(NOW.getTime() / 1000);

let deps: Parameters<typeof handleWebhook>[1];
let post: ReturnType<typeof vi.fn>;
let apiKeyId: number;
let mutedKeyId: number;
let db: ReturnType<typeof openDatabase>;
let accountId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'C', keyPem: 'K', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'CA', certFingerprintSha1: 'AA',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: null, storeContent: 1, serviceIds: ['24138'],
  });
  const apiKeys = new ApiKeysRepo(db, masterKey);
  const baseKey = {
    accountId, name: 'crm', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, serviceIds: ['24138'],
  };
  apiKeyId = apiKeys.insert({ ...baseKey, webhookUrl: 'https://crm.example/hook', webhookSecret: 'sekret' });
  mutedKeyId = apiKeys.insert({ ...baseKey, name: 'bez webhooka', keyHash: 'h2', keyPrefix: 'p2', webhookUrl: null, webhookSecret: null });
  post = vi.fn();
  deps = {
    accounts, apiKeys, messages: new MessagesRepo(db), jobs: new JobsRepo(db), events: new MessageEventsRepo(db),
    deliveries: new WebhookDeliveriesRepo(db), packages: new PackagesRepo(db), inbound: new InboundMessagesRepo(db), reportsDir: '', clients: {} as never, post,
    resolve: async () => ['93.184.216.34'],
  };
});

describe('handleWebhook - cel w sieci wewnętrznej', () => {
  const deliveryTo = (url: string) => {
    const id = deps.deliveries.insert({ apiKeyId, event: 'message.sent', payload: '{}', url, createdAt: NOW });
    return { id, job: { id: deps.jobs.enqueue('webhook', { deliveryId: id }, NOW), type: 'webhook' as const, payload: { deliveryId: id }, attempts: 0, lastError: null } };
  };

  it('domyślnie odmawia dostawy pod adres wewnętrzny bez ponowień i bez wywołania', async () => {
    const { id, job } = deliveryTo('http://172.18.0.1:9000/webhook.php');
    await handleWebhook(job, deps, NOW);
    expect(post).not.toHaveBeenCalled();
    const delivery = deps.deliveries.get(id)!;
    expect(delivery.status).toBe('failed');
    expect(delivery.lastResponse).toContain('MIG_WEBHOOK_ALLOW_PRIVATE');
    expect(deps.jobs.depth()).toBe(0);
  });

  it('nazwę rozwiązującą się na adres wewnętrzny traktuje tak samo', async () => {
    deps.resolve = async () => ['10.0.0.5'];
    const { id, job } = deliveryTo('https://crm.example/hook');
    await handleWebhook(job, deps, NOW);
    expect(post).not.toHaveBeenCalled();
    expect(deps.deliveries.get(id)!.status).toBe('failed');
  });

  it('z MIG_WEBHOOK_ALLOW_PRIVATE dostarcza pod adres wewnętrzny', async () => {
    deps.allowPrivateWebhooks = true;
    post.mockResolvedValue({ status: 204, body: '' });
    const { id, job } = deliveryTo('http://172.18.0.1:9000/webhook.php');
    await handleWebhook(job, deps, NOW);
    expect(post).toHaveBeenCalledTimes(1);
    expect(deps.deliveries.get(id)!.status).toBe('delivered');
  });

  it('nazwę bez adresu ponawia jak awarię sieci', async () => {
    deps.resolve = async () => { throw new Error('ENOTFOUND'); };
    const { id, job } = deliveryTo('https://crm.example/hook');
    await handleWebhook(job, deps, NOW);
    expect(post).not.toHaveBeenCalled();
    const delivery = deps.deliveries.get(id)!;
    expect(delivery.status).toBe('pending');
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastResponse).toContain('ENOTFOUND');
  });
});

describe('signWebhook', () => {
  it('liczy HMAC-SHA256 po znaczniku czasu i ciele', () => {
    const expected = createHmac('sha256', 'sekret').update('1756116000.{"a":1}').digest('hex');
    expect(signWebhook('sekret', 1756116000, '{"a":1}')).toBe(`sha256=${expected}`);
  });
});

describe('emitWebhook', () => {
  it('tworzy dostawę i zadanie dla klucza z adresem', () => {
    const id = emitWebhook(deps, apiKeyId, 'message.sent', { id: 'msg_1' }, NOW);
    expect(id).not.toBeNull();
    const delivery = deps.deliveries.get(id!)!;
    expect(delivery.url).toBe('https://crm.example/hook');
    expect(delivery.event).toBe('message.sent');
    expect(JSON.parse(delivery.payload)).toEqual({ event: 'message.sent', at: NOW.toISOString(), id: 'msg_1' });
    const jobs = deps.jobs.claim(NOW, 10);
    expect(jobs.map((j) => j.type)).toEqual(['webhook']);
    expect(jobs[0]!.payload).toEqual({ deliveryId: id });
  });

  it('nic nie robi dla klucza bez adresu', () => {
    expect(emitWebhook(deps, mutedKeyId, 'message.sent', { id: 'msg_1' }, NOW)).toBeNull();
    expect(deps.jobs.depth()).toBe(0);
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 0 });
  });
});

describe('handleWebhook', () => {
  function job() {
    emitWebhook(deps, apiKeyId, 'message.delivered', { id: 'msg_1', status: 'delivered' }, NOW);
    return deps.jobs.claim(NOW, 1)[0]!;
  }

  it('wysyła POST z nagłówkami zdarzenia, czasu i podpisu', async () => {
    post.mockResolvedValue({ status: 200, body: 'ok' });
    await handleWebhook(job(), deps, NOW);
    const [url, headers, body] = post.mock.calls[0]!;
    expect(url).toBe('https://crm.example/hook');
    expect(headers['X-MIG-Event']).toBe('message.delivered');
    expect(headers['X-MIG-Timestamp']).toBe(String(TIMESTAMP));
    expect(headers['X-MIG-Signature']).toBe(signWebhook('sekret', TIMESTAMP, body));
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(body)).toMatchObject({ event: 'message.delivered', id: 'msg_1' });
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 0 });
    expect(deps.deliveries.listRecent(1)[0]!.deliveredAt).toBe(NOW.toISOString());
    expect(deps.deliveries.listRecent(1)[0]!.lastResponse).toBe('200 ok');
    expect(deps.jobs.depth()).toBe(0);
  });

  it('ponawia według harmonogramu po odpowiedzi 5xx i wyjątku sieci', async () => {
    post.mockResolvedValueOnce({ status: 503, body: 'later' }).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const j = job();
    await handleWebhook(j, deps, NOW);
    const deliveryId = Number(j.payload.deliveryId);
    expect(deps.deliveries.get(deliveryId)!.lastResponse).toBe('503 later');
    expect(deps.jobs.claim(new Date(NOW.getTime() + WEBHOOK_BACKOFF_MS[0]! - 1), 10)).toHaveLength(0);
    const [again] = deps.jobs.claim(new Date(NOW.getTime() + WEBHOOK_BACKOFF_MS[0]! + 1), 10);
    await handleWebhook(again!, deps, NOW);
    expect(deps.deliveries.get(deliveryId)!.attempts).toBe(2);
    expect(deps.deliveries.get(deliveryId)!.status).toBe('pending');
    expect(deps.deliveries.get(deliveryId)!.lastResponse).toContain('ECONNREFUSED');
    expect(deps.jobs.claim(new Date(NOW.getTime() + WEBHOOK_BACKOFF_MS[1]! + 1), 10)).toHaveLength(1);
  });

  it('po wyczerpaniu ponowień oznacza dostawę jako nieudaną', async () => {
    post.mockResolvedValue({ status: 500, body: 'x' });
    const j = job();
    await handleWebhook({ ...j, attempts: WEBHOOK_BACKOFF_MS.length }, deps, NOW);
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 1 });
    expect(deps.jobs.depth()).toBe(0);
  });

  it('nie ponawia po odpowiedzi 4xx - to błąd odbiorcy, nie sieci', async () => {
    post.mockResolvedValue({ status: 410, body: 'gone' });
    await handleWebhook(job(), deps, NOW);
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 1 });
    expect(deps.jobs.depth()).toBe(0);
  });

  it('kończy zadanie bez wywołania, gdy dostawa nie jest już oczekująca', async () => {
    const j = job();
    deps.deliveries.markFailed(Number(j.payload.deliveryId), 'ręcznie');
    await handleWebhook(j, deps, NOW);
    expect(post).not.toHaveBeenCalled();
    expect(deps.jobs.depth()).toBe(0);
  });

  it('oznacza dostawę jako nieudaną, gdy klucz stracił sekret', async () => {
    const j = job();
    deps.apiKeys.setWebhook(apiKeyId, null, null);
    await handleWebhook(j, deps, NOW);
    expect(post).not.toHaveBeenCalled();
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 1 });
  });
});

describe('handleWebhook - message.received', () => {
  const received = (scrubAfter: boolean) => {
    // Dostawa wskazuje wiadomość przychodzącą kluczem obcym - musi być w bazie.
    db.prepare(`INSERT INTO inbound_messages (id, account_id, service_id, mi_id, sender, dest, kind, body_hash, protocol_id, coding_scheme, received_at, created_at)
      VALUES ('in_1', ?, '24138', '22', '48601000001', '7968', 'text', 'h', 0, 0, ?, ?)`).run(accountId, NOW.toISOString(), NOW.toISOString());
    const id = emitWebhook(deps, apiKeyId, 'message.received',
      { id: 'in_1', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text: 'Ala', receivedAt: NOW.toISOString(), relatedMessageId: null },
      NOW, { inboundId: 'in_1', scrubAfter })!;
    const job = deps.jobs.claim(NOW, 10).find((j) => j.payload.deliveryId === id)!;
    return { id, job };
  };

  it('dostawa pamięta wiadomość przychodzącą i idzie z nagłówkiem zdarzenia', async () => {
    const { id, job } = received(false);
    post.mockResolvedValue({ status: 204, body: '' });
    await handleWebhook(job, deps, NOW);
    expect(post.mock.calls[0][1]['X-MIG-Event']).toBe('message.received');
    expect(JSON.parse(post.mock.calls[0][2]).text).toBe('Ala');
    expect(deps.deliveries.get(id)!.inboundId).toBe('in_1');
    expect(JSON.parse(deps.deliveries.get(id)!.payload).text).toBe('Ala');
  });

  it('po doręczeniu z konta bez przechowywania treści zostaje skrót', async () => {
    const { id, job } = received(true);
    post.mockResolvedValue({ status: 204, body: '' });
    await handleWebhook(job, deps, NOW);
    expect(JSON.parse(post.mock.calls[0][2]).text).toBe('Ala');
    const stored = JSON.parse(deps.deliveries.get(id)!.payload);
    expect(stored.text).toBeUndefined();
    expect(stored.bodyHash).toHaveLength(64);
  });

  it('treść zostaje na czas ponowień i znika po ostatecznym niepowodzeniu', async () => {
    const { id, job } = received(true);
    post.mockResolvedValue({ status: 500, body: 'awaria' });
    await handleWebhook(job, deps, NOW);
    expect(JSON.parse(deps.deliveries.get(id)!.payload).text).toBe('Ala');
    post.mockResolvedValue({ status: 400, body: 'nie' });
    await handleWebhook({ ...job, attempts: 1 }, deps, NOW);
    expect(deps.deliveries.get(id)!.status).toBe('failed');
    expect(JSON.parse(deps.deliveries.get(id)!.payload).text).toBeUndefined();
  });

  it('odmowa sieci wewnętrznej też czyści treść', async () => {
    const { id, job } = received(true);
    deps.resolve = async () => ['10.0.0.5'];
    await handleWebhook(job, deps, NOW);
    expect(deps.deliveries.get(id)!.status).toBe('failed');
    expect(JSON.parse(deps.deliveries.get(id)!.payload).text).toBeUndefined();
  });
});
