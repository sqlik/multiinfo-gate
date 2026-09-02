import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/multiinfo/response.ts';
import { SEND_BACKOFF_MS, handleSend } from '../../src/worker/send.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { WebhookDeliveriesRepo } from '../../src/store/webhook-deliveries.ts';
import { defaultOutboundConfig } from '../../src/integrations/config.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';

const masterKey = randomBytes(32);
const NOW = new Date('2026-08-25T10:00:00Z');
const TRACE = {
  at: '2026-08-25T10:00:00.000Z', durationMs: 5, script: 'sendsmslong.aspx',
  params: { login: 'firma_api', password: '••••••••', text: 'Ala ma kota' }, httpStatus: 200, lines: ['8841207'],
};

let db: ReturnType<typeof openDatabase>;
let deps: Parameters<typeof handleSend>[1];
let accountId: number;
let apiKeyId: number;
let sendLong: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const messages = new MessagesRepo(db);
  const jobs = new JobsRepo(db);

  accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent: 1, serviceIds: ['24138'],
  });
  const apiKeys = new ApiKeysRepo(db, masterKey);
  apiKeyId = apiKeys.insert({
    accountId, name: 'rejestracja', keyHash: 'argon2:aaa', keyPrefix: 'mig_live_a1b2c3',
    defaultServiceId: '24138', defaultOrig: null, maxParts: 9, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });

  sendLong = vi.fn();
  cancel = vi.fn();
  deps = {
    accounts, apiKeys, messages, jobs, events: new MessageEventsRepo(db), deliveries: new WebhookDeliveriesRepo(db, masterKey), packages: new PackagesRepo(db), inbound: new InboundMessagesRepo(db), reportsDir: '',
    clients: { for: () => ({ sendLong, cancel }), invalidate: vi.fn(), closeAll: vi.fn() } as never,
  };
});

function seedMessage(id = 'msg_1') {
  deps.messages.insert({
    id, apiKeyId, accountId, serviceId: '24138', dest: '48601135134',
    body: 'Ala ma kota', bodyHash: 'h', encoding: 'gsm', parts: 1, slots: 11,
    orig: 'Firma Info', costCenter: null, validTo: null, idempotencyKey: null,
  });
  const jobId = deps.jobs.enqueue('send', { messageId: id, text: 'Ala ma kota', deliveryReport: true }, NOW);
  return { id, job: { id: jobId, type: 'send' as const, payload: { messageId: id, text: 'Ala ma kota', deliveryReport: true }, attempts: 0, lastError: null } };
}

describe('handleSend', () => {
  it('zapisuje identyfikatory części po udanej wysyłce', async () => {
    const { id, job } = seedMessage();
    sendLong.mockResolvedValue({ miIds: ['8841207', '8841208'], trace: TRACE });
    await handleSend(job, deps, NOW);
    const stored = deps.messages.get(id)!;
    expect(stored.miIds).toEqual(['8841207', '8841208']);
    expect(stored.status).toBe('sent');
    expect(stored.sentAt).not.toBeNull();
  });

  it('planuje odpytywanie o status', async () => {
    const { job } = seedMessage();
    sendLong.mockResolvedValue({ miIds: ['8841207'], trace: TRACE });
    await handleSend(job, deps, NOW);
    const later = new Date(NOW.getTime() + 11_000);
    const claimed = deps.jobs.claim(later, 10);
    expect(claimed.some((j) => j.type === 'poll')).toBe(true);
  });

  it('usuwa treść z ładunku zadania po wysyłce', async () => {
    const { job } = seedMessage();
    sendLong.mockResolvedValue({ miIds: ['8841207'], trace: TRACE });
    await handleSend(job, deps, NOW);
    const remaining = deps.jobs.claim(new Date(NOW.getTime() + 11_000), 10);
    expect(remaining.every((j) => !('text' in j.payload))).toBe(true);
  });

  it('zapisuje ślad protokołu przy wiadomości', async () => {
    const { id, job } = seedMessage();
    sendLong.mockResolvedValue({ miIds: ['8841207'], trace: TRACE });
    await handleSend(job, deps, NOW);
    expect(deps.messages.get(id)!.trace?.params.text).toBe('Ala ma kota');
    expect(deps.messages.get(id)!.trace?.lines).toEqual(['8841207']);
  });

  it('usuwa treść ze śladu, gdy konto jej nie przechowuje', async () => {
    db.prepare('UPDATE accounts SET store_content = 0').run();
    const { id, job } = seedMessage();
    sendLong.mockResolvedValue({ miIds: ['8841207'], trace: TRACE });
    await handleSend(job, deps, NOW);
    expect(deps.messages.get(id)!.trace?.params.text).toBe('<treść, 11 znaków>');
    expect(deps.messages.get(id)!.trace?.params.password).toBe('••••••••');
  });

  it('ponawia błąd przejściowy według harmonogramu', async () => {
    const { id, job } = seedMessage();
    sendLong.mockRejectedValue(new ProviderError(-15, 'Brak połączenia z bazą danych', 'transient'));
    await handleSend(job, deps, NOW);
    expect(deps.messages.get(id)!.status).toBe('queued');
    expect(deps.jobs.claim(new Date(NOW.getTime() + SEND_BACKOFF_MS[0]! - 1), 10)).toHaveLength(0);
    expect(deps.jobs.claim(new Date(NOW.getTime() + SEND_BACKOFF_MS[0]! + 1), 10)).toHaveLength(1);
  });

  it('poddaje się po wyczerpaniu harmonogramu ponowień', async () => {
    const { id, job } = seedMessage();
    job.attempts = SEND_BACKOFF_MS.length;
    sendLong.mockRejectedValue(new ProviderError(-15, 'Brak połączenia z bazą danych', 'transient'));
    await handleSend(job, deps, NOW);
    const stored = deps.messages.get(id)!;
    expect(stored.status).toBe('failed');
    expect(stored.providerCode).toBe(-15);
  });

  it('przy kodzie -14 wskazuje nadpis jako prawdopodobną przyczynę', async () => {
    const { id, job } = seedMessage();
    sendLong.mockRejectedValue(new ProviderError(-14, 'Błędna wartość parametru', 'permanent'));
    await handleSend(job, deps, NOW);
    const stored = deps.messages.get(id)!;
    expect(stored.status).toBe('failed');
    expect(stored.error).toContain('nadpis nadawcy');
    expect(stored.error).toContain('Firma Info');
    expect(stored.error).toContain('Multiinfo przyjmuje tylko wartości uzgodnione z Polkomtel.');
  });

  it('nie ponawia błędu trwałego', async () => {
    const { id, job } = seedMessage();
    sendLong.mockRejectedValue(new ProviderError(-24, 'Usługa nie jest aktywna', 'permanent'));
    await handleSend(job, deps, NOW);
    expect(deps.messages.get(id)!.status).toBe('failed');
    expect(deps.messages.get(id)!.providerCode).toBe(-24);
    expect(deps.jobs.claim(new Date(NOW.getTime() + 86_400_000), 10)).toHaveLength(0);
  });

  it('wstrzymanie konta za certyfikat powiadamia administratora raz na powód', async () => {
    const notify = vi.fn();
    deps.notifier = { notify };
    const { job } = seedMessage();
    sendLong.mockRejectedValue(new ProviderError(-80, 'Brak certyfikatu', 'certificate'));
    await handleSend(job, deps, NOW);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe('account_rejecting');
    expect(notify.mock.calls[0]![2]).toContain('Konto Firma Info wstrzymane');
    expect(notify.mock.calls[0]![4]).toMatch(new RegExp(`^account:${accountId}:paused:[0-9a-f]{16}$`));
  });

  it('wstrzymuje konto po błędzie certyfikatu i nie oznacza wiadomości jako nieudanej', async () => {
    const { id, job } = seedMessage();
    sendLong.mockRejectedValue(new ProviderError(-85, 'Pole CN nie zgadza się z loginem', 'certificate'));
    await handleSend(job, deps, NOW);
    expect(deps.accounts.get(accountId)!.pausedReason).toMatch(/-85/);
    expect(deps.messages.get(id)!.status).toBe('queued');
  });

  it('odkłada zadanie, gdy konto jest wstrzymane, i nie wywołuje Multiinfo', async () => {
    const { job } = seedMessage();
    deps.accounts.pause(accountId, 'Certyfikat odrzucony, kod -85');
    await handleSend(job, deps, NOW);
    expect(sendLong).not.toHaveBeenCalled();
    expect(deps.jobs.claim(new Date(NOW.getTime() + 61_000), 10)).toHaveLength(1);
  });

  it('oczekiwanie na odblokowanie konta nie zużywa ponowień', async () => {
    const { job } = seedMessage();
    deps.accounts.pause(accountId, 'Certyfikat odrzucony, kod -85');
    await handleSend(job, deps, NOW);
    const [deferred] = deps.jobs.claim(new Date(NOW.getTime() + 61_000), 10);
    expect(deferred!.attempts).toBe(0);
  });

  it('błąd certyfikatu nie zużywa ponowień wiadomości', async () => {
    const { job } = seedMessage();
    sendLong.mockRejectedValue(new ProviderError(-85, 'Pole CN nie zgadza się z loginem', 'certificate'));
    await handleSend(job, deps, NOW);
    const [deferred] = deps.jobs.claim(new Date(NOW.getTime() + 61_000), 10);
    expect(deferred!.attempts).toBe(0);
  });

  it('po odblokowaniu konta wysyłka rusza z pełnym harmonogramem ponowień', async () => {
    const { id, job } = seedMessage();
    deps.accounts.pause(accountId, 'Certyfikat odrzucony, kod -85');
    // Kilka tur oczekiwania na naprawę…
    for (let i = 0; i < 10; i += 1) {
      const [again] = deps.jobs.claim(new Date(NOW.getTime() + (i + 1) * 61_000), 10);
      await handleSend(again!, deps, NOW);
    }
    deps.accounts.resume(accountId);
    // …a po naprawie pierwszy błąd przejściowy ma prawo do ponowienia.
    sendLong.mockRejectedValue(new ProviderError(-15, 'Brak połączenia z bazą danych', 'transient'));
    const [ready] = deps.jobs.claim(new Date(NOW.getTime() + 12 * 61_000), 10);
    await handleSend(ready!, deps, NOW);
    expect(deps.messages.get(id)!.status).toBe('queued');
  });

  it('zapisuje zdarzenia przekazania i ponowienia', async () => {
    const { id, job } = seedMessage();
    sendLong.mockRejectedValueOnce(new ProviderError(-15, 'Brak bazy', 'transient'))
      .mockResolvedValueOnce({ miIds: ['8841207'], trace: TRACE });
    await handleSend(job, deps, NOW);
    await handleSend({ ...job, attempts: 1 }, deps, NOW);
    expect(deps.events.list(id).map((e) => e.kind)).toEqual(['retry', 'sent']);
    expect(deps.events.list(id)[0]!.detail).toBe('kod -15: Brak bazy; ponowienie za 5 s');
    expect(deps.events.list(id)[1]!.detail).toBe('identyfikatory 8841207');
  });

  it('zapisuje zdarzenie odrzucenia i wyczerpania ponowień', async () => {
    const { id, job } = seedMessage();
    sendLong.mockRejectedValue(new ProviderError(-24, 'Usługa nie jest aktywna', 'permanent'));
    await handleSend(job, deps, NOW);
    expect(deps.events.list(id).map((e) => e.kind)).toEqual(['failed']);
    expect(deps.events.list(id)[0]!.detail).toContain('-24');

    const second = seedMessage('msg_2');
    sendLong.mockRejectedValue(new ProviderError(-15, 'Brak bazy', 'transient'));
    await handleSend({ ...second.job, attempts: SEND_BACKOFF_MS.length }, deps, NOW);
    expect(deps.events.list('msg_2').map((e) => e.kind)).toEqual(['failed']);
    expect(deps.events.list('msg_2')[0]!.detail).toContain('Wyczerpano ponowienia');
  });

  it('zapisuje wstrzymanie konta raz, a nie przy każdym odłożeniu', async () => {
    const { id, job } = seedMessage();
    sendLong.mockRejectedValue(new ProviderError(-85, 'Pole CN nie zgadza się z loginem', 'certificate'));
    await handleSend(job, deps, NOW);
    for (let i = 0; i < 3; i += 1) {
      const [again] = deps.jobs.claim(new Date(NOW.getTime() + (i + 1) * 61_000), 10);
      await handleSend(again!, deps, NOW);
    }
    expect(deps.events.list(id).map((e) => e.kind)).toEqual(['paused']);
    expect(deps.events.list(id)[0]!.detail).toContain('-85');
  });

  it('po przyjęciu przez Multiinfo kolejkuje webhook message.sent', async () => {
    deps.apiKeys.setWebhook(apiKeyId, 'https://crm.example/hook', 'sekret');
    const { id, job } = seedMessage();
    sendLong.mockResolvedValue({ miIds: ['8841207', '8841208'], trace: TRACE });
    await handleSend(job, deps, NOW);
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 1, failed: 0 });
    const delivery = deps.deliveries.listRecent(1)[0]!;
    expect(delivery.event).toBe('message.sent');
    expect(JSON.parse(delivery.payload)).toMatchObject({ id, status: 'sent', to: '48601135134', parts: 2 });
    expect(deps.events.list(id).map((e) => e.kind)).toEqual(['sent', 'webhook']);
  });

  it('po odrzuceniu kolejkuje webhook message.failed z kodem operatora', async () => {
    deps.apiKeys.setWebhook(apiKeyId, 'https://crm.example/hook', 'sekret');
    const { id, job } = seedMessage();
    sendLong.mockRejectedValue(new ProviderError(-24, 'Usługa nie jest aktywna', 'permanent'));
    await handleSend(job, deps, NOW);
    const delivery = deps.deliveries.listRecent(1)[0]!;
    expect(delivery.event).toBe('message.failed');
    expect(JSON.parse(delivery.payload)).toMatchObject({ id, status: 'failed', providerCode: -24 });
  });

  it('integracja wychodząca na message.sent dostaje dostawę, choć klucz nie ma adresu webhooka', async () => {
    const integrations = new IntegrationsRepo(db, masterKey);
    const integrationId = integrations.insert({
      name: 'Slack', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
      config: { ...defaultOutboundConfig(), url: 'https://hooks.slack.example/x', events: ['message.sent', 'message.failed'], body: { mode: 'json', template: '{"text": "{{ status }} do {{ to }} ({{ id }})"}' } },
      secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    deps.integrationEmit = { integrations, integrationEvents: new IntegrationEventsRepo(db, masterKey), guards: new IntegrationGuardsRepo(db), deliveries: deps.deliveries, jobs: deps.jobs, engine: new TemplateEngine() };
    const { id, job } = seedMessage();
    sendLong.mockResolvedValue({ miIds: ['8841207'], trace: TRACE });
    await handleSend(job, deps, NOW);
    const delivery = deps.deliveries.listRecent(1)[0]!;
    expect(delivery.integrationId).toBe(integrationId);
    expect(JSON.parse(delivery.payload)).toEqual({ text: `sent do 48601135134 (${id})` });
    // Przebieg wiadomości odnotowuje tylko webhook klucza; dziennik integracji ma własny wpis.
    expect(deps.events.list(id).map((e) => e.kind)).toEqual(['sent']);
    expect(deps.integrationEmit.integrationEvents.list(integrationId, 5)[0]).toMatchObject({ result: 'sent', messageId: id });
  });

  it('nie kolejkuje webhooka dla klucza bez adresu', async () => {
    const { id, job } = seedMessage();
    sendLong.mockResolvedValue({ miIds: ['8841207'], trace: TRACE });
    await handleSend(job, deps, NOW);
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 0 });
    expect(deps.events.list(id).map((e) => e.kind)).toEqual(['sent']);
  });

  it('nie wysyła wiadomości anulowanej przed wyjściem z kolejki', async () => {
    const { id, job } = seedMessage();
    deps.messages.setStatus(id, { status: 'cancelled', finalAt: NOW });
    await handleSend(job, deps, NOW);
    expect(sendLong).not.toHaveBeenCalled();
    expect(deps.jobs.depth()).toBe(0);
    expect(deps.messages.get(id)!.status).toBe('cancelled');
  });

  it('wycofuje w Multiinfo wiadomość anulowaną w trakcie przekazywania', async () => {
    const { id, job } = seedMessage();
    // Anulowanie przychodzi, gdy sendsmslong.aspx już trwa - jak z drugiego wątku.
    sendLong.mockImplementation(async () => {
      deps.messages.setStatus(id, { status: 'cancelled', finalAt: NOW });
      return { miIds: ['8841207', '8841208'], trace: TRACE };
    });
    cancel.mockResolvedValue(undefined);
    await handleSend(job, deps, NOW);

    expect(cancel.mock.calls.map((c) => c[0])).toEqual(['8841207', '8841208']);
    const stored = deps.messages.get(id)!;
    expect(stored.status).toBe('cancelled');
    expect(stored.miIds).toEqual(['8841207', '8841208']);
    const kinds = deps.events.list(id).map((e) => e.kind);
    expect(kinds).not.toContain('sent');
    expect(kinds).toContain('cancelled');
    expect(deps.events.list(id).find((e) => e.kind === 'cancelled')!.detail).toContain('cancelsms.aspx');
    // Odpytywanie zostaje: status ostateczny Multiinfo i webhook przychodzą tą drogą.
    const later = deps.jobs.claim(new Date(NOW.getTime() + 11_000), 10);
    expect(later.map((j) => j.type)).toEqual(['poll']);
  });

  it('gdy wycofania nie da się zrobić, wiadomość wraca do stanu sent i jest odpytywana', async () => {
    const { id, job } = seedMessage();
    sendLong.mockImplementation(async () => {
      deps.messages.setStatus(id, { status: 'cancelled', finalAt: NOW });
      return { miIds: ['8841207'], trace: TRACE };
    });
    cancel.mockRejectedValue(new ProviderError(-41, 'Wiadomość została już przekazana', 'permanent'));
    await handleSend(job, deps, NOW);

    const stored = deps.messages.get(id)!;
    expect(stored.status).toBe('sent');
    expect(stored.finalAt).toBeNull();
    const kinds = deps.events.list(id).map((e) => e.kind);
    expect(kinds).toContain('cancel_failed');
    expect(kinds).toContain('sent');
    const later = deps.jobs.claim(new Date(NOW.getTime() + 11_000), 10);
    expect(later.map((j) => j.type)).toEqual(['poll']);
  });

  it('kończy zadanie, gdy wiadomość zniknęła z bazy', async () => {
    const job = { id: 1, type: 'send' as const, payload: { messageId: 'msg_nieistnieje', text: 'x', deliveryReport: true }, attempts: 0, lastError: null };
    deps.jobs.enqueue('send', job.payload, NOW);
    await expect(handleSend(job, deps, NOW)).resolves.toBeUndefined();
  });
});

describe('handleSend - odpowiedź na wiadomość przychodzącą', () => {
  const seedInbound = () => db.prepare(`INSERT INTO inbound_messages (id, account_id, service_id, mi_id, sender, dest, kind, body_hash, protocol_id, coding_scheme, received_at, created_at)
    VALUES ('in_1', ?, '24138', '22', '48601135134', '7968', 'text', 'h', 0, 0, '2026-08-25T09:00:00.000Z', '2026-08-25T09:00:01.000Z')`).run(accountId);
  const reply = () => deps.messages.insert({ id: 'msg_r', apiKeyId, accountId, serviceId: '24138', dest: '48601135134', body: 'Odp', bodyHash: 'h',
    encoding: 'gsm', parts: 1, slots: 3, orig: null, costCenter: null, validTo: null, idempotencyKey: null, inReplyTo: 'in_1' });
  const job = () => {
    const id = deps.jobs.enqueue('send', { messageId: 'msg_r', text: 'Odp', deliveryReport: true }, NOW);
    return { id, type: 'send' as const, payload: { messageId: 'msg_r', text: 'Odp', deliveryReport: true }, attempts: 0, lastError: null };
  };

  it('przekazuje smsInId z wiadomości przychodzącej', async () => {
    seedInbound();
    deps.inbound = new InboundMessagesRepo(db);
    reply();
    sendLong.mockResolvedValue({ miIds: ['1'], trace: TRACE });
    await handleSend(job(), deps, NOW);
    expect(sendLong.mock.calls[0][0].smsInId).toBe('22');
  });

  it('webhook message.sent niesie inReplyTo', async () => {
    seedInbound();
    deps.inbound = new InboundMessagesRepo(db);
    deps.apiKeys.setWebhook(apiKeyId, 'https://crm.example/hook', 'sekret');
    reply();
    sendLong.mockResolvedValue({ miIds: ['1'], trace: TRACE });
    await handleSend(job(), deps, NOW);
    const delivery = deps.deliveries.listRecent(1)[0]!;
    expect(JSON.parse(delivery.payload)).toMatchObject({ event: 'message.sent', id: 'msg_r', inReplyTo: 'in_1' });
  });

  it('zwykła wiadomość nie dostaje pola inReplyTo w powiadomieniu', async () => {
    deps.apiKeys.setWebhook(apiKeyId, 'https://crm.example/hook', 'sekret');
    seedMessage();
    const id = deps.jobs.enqueue('send', { messageId: 'msg_1', text: 'Ala ma kota', deliveryReport: true }, NOW);
    sendLong.mockResolvedValue({ miIds: ['1'], trace: TRACE });
    await handleSend({ id, type: 'send', payload: { messageId: 'msg_1', text: 'Ala ma kota', deliveryReport: true }, attempts: 0, lastError: null }, deps, NOW);
    expect(JSON.parse(deps.deliveries.listRecent(1)[0]!.payload)).not.toHaveProperty('inReplyTo');
    expect(sendLong.mock.calls[0][0]).not.toHaveProperty('smsInId');
  });
});
