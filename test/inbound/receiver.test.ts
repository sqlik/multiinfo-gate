import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/multiinfo/response.ts';
import { Receiver, RELATED_WINDOW_MS, type ReceiverDeps } from '../../src/inbound/receiver.ts';
import { NOW, SMS, buildReceiverDeps, keyInput } from './helpers.ts';

let db: ReturnType<typeof buildReceiverDeps>['db'];
let deps: ReceiverDeps;
let receiver: Receiver;
let accountId: number;
let getSms: ReturnType<typeof buildReceiverDeps>['getSms'];
let confirmSms: ReturnType<typeof buildReceiverDeps>['confirmSms'];
const target = () => ({ accountId, serviceId: '24138' });

beforeEach(() => {
  ({ db, deps, accountId, getSms, confirmSms } = buildReceiverDeps());
  receiver = new Receiver(deps);
});

describe('Receiver.pollOnce', () => {
  it('pusta odpowiedź: odnotowuje pytanie, nic nie zapisuje, nie potwierdza', async () => {
    getSms.mockResolvedValue(null);
    expect(await receiver.pollOnce(target())).toEqual({ kind: 'empty' });
    expect(deps.services.states(accountId)[0]!.lastPollAt).toBe(NOW.toISOString());
    expect(confirmSms).not.toHaveBeenCalled();
    expect(getSms).toHaveBeenCalledWith('24138', 60_000, undefined);
  });

  it('wiadomość: zapis, webhook dla każdego subskrybenta, potem potwierdzenie', async () => {
    deps.apiKeys.insert(keyInput(accountId));
    deps.apiKeys.insert(keyInput(accountId, { keyPrefix: 'p2', name: 'drugi' }));
    deps.apiKeys.insert(keyInput(accountId, { keyPrefix: 'p3', name: 'nie subskrybuje', inboundSubscribed: 0 }));
    getSms.mockResolvedValue(SMS);
    const out = await receiver.pollOnce(target());
    expect(out).toMatchObject({ kind: 'message', duplicate: false });
    const id = (out as { id: string }).id;
    const row = deps.inbound.get(id)!;
    expect(row).toMatchObject({ miId: '22', sender: '48601000001', dest: '7968', body: 'Dziekuje, jasne', receivedAt: '2026-08-29T07:14:00.000Z' });
    expect(id).toMatch(/^in_[0-9a-f]{20}$/);
    const deliveries = deps.deliveries.listForInbound(id);
    expect(deliveries).toHaveLength(2);
    expect(JSON.parse(deliveries[0]!.payload)).toMatchObject({ event: 'message.received', id, serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text: 'Dziekuje, jasne', relatedMessageId: null });
    expect(deps.jobs.depth()).toBe(2);
    expect(confirmSms).toHaveBeenCalledWith('22');
    expect(deps.services.states(accountId)[0]!.lastReceivedAt).toBe(NOW.toISOString());
  });

  it('kolejność: potwierdzenie dopiero po zapisie', async () => {
    deps.apiKeys.insert(keyInput(accountId));
    const order: string[] = [];
    getSms.mockResolvedValue(SMS);
    confirmSms.mockImplementation(async () => { order.push(`confirm:${deps.inbound.list({ limit: 1, offset: 0 }).length}`); });
    await receiver.pollOnce(target());
    expect(order).toEqual(['confirm:1']);
  });

  it('duplikat po identyfikatorze MI: bez webhooków, ale z potwierdzeniem', async () => {
    deps.apiKeys.insert(keyInput(accountId));
    getSms.mockResolvedValue(SMS);
    await receiver.pollOnce(target());
    const again = await receiver.pollOnce(target());
    expect(again).toMatchObject({ kind: 'message', duplicate: true });
    expect(deps.inbound.list({ limit: 10, offset: 0 })).toHaveLength(1);
    expect(deps.jobs.depth()).toBe(1);
    expect(confirmSms).toHaveBeenCalledTimes(2);
  });

  it('wiąże z ostatnią wysłaną na ten numer z tej usługi w oknie 7 dni', async () => {
    deps.apiKeys.insert(keyInput(accountId));
    const keyId = deps.apiKeys.list()[0]!.id;
    const msg = (id: string, createdAt: string, serviceId = '24138') => deps.messages.insert({
      id, apiKeyId: keyId, accountId, serviceId, dest: '48601000001', body: null, bodyHash: 'h', encoding: 'gsm',
      parts: 1, slots: 1, orig: null, costCenter: null, validTo: null, idempotencyKey: null, createdAt,
    });
    msg('msg_stara', new Date(NOW.getTime() - RELATED_WINDOW_MS - 1000).toISOString());
    msg('msg_a', new Date(NOW.getTime() - 3600_000).toISOString());
    msg('msg_b', new Date(NOW.getTime() - 60_000).toISOString());
    msg('msg_inna', new Date(NOW.getTime() - 1000).toISOString(), '24902');
    getSms.mockResolvedValue(SMS);
    const out = await receiver.pollOnce(target()) as { id: string };
    expect(deps.inbound.get(out.id)!.relatedMessageId).toBe('msg_b');
    expect(JSON.parse(deps.deliveries.listForInbound(out.id)[0]!.payload).relatedMessageId).toBe('msg_b');
  });

  it('konto bez przechowywania treści: skrót w bazie, treść w dostawie, dostawa do wyczyszczenia', async () => {
    db.prepare('UPDATE accounts SET store_content = 0').run();
    deps.apiKeys.insert(keyInput(accountId));
    getSms.mockResolvedValue(SMS);
    const out = await receiver.pollOnce(target()) as { id: string };
    expect(deps.inbound.get(out.id)!.body).toBeNull();
    expect(deps.inbound.get(out.id)!.bodyHash).toHaveLength(64);
    const d = deps.deliveries.listForInbound(out.id)[0]!;
    expect(JSON.parse(d.payload).text).toBe('Dziekuje, jasne');
    expect(d.scrubAfter).toBe(1);
  });

  it('wiadomość binarna: hex bez interpretacji', async () => {
    deps.apiKeys.insert(keyInput(accountId));
    getSms.mockResolvedValue({ ...SMS, kind: 'binary', content: '0605040B8423F0 48656C6C6F' });
    const out = await receiver.pollOnce(target()) as { id: string };
    expect(deps.inbound.get(out.id)).toMatchObject({ kind: 'binary', body: '0605040B8423F0 48656C6C6F' });
    const payload = JSON.parse(deps.deliveries.listForInbound(out.id)[0]!.payload);
    expect(payload.hex).toBe('0605040B8423F0 48656C6C6F');
    expect(payload.text).toBeUndefined();
  });

  it('numer nadawcy niedający się znormalizować zostaje surowy', async () => {
    deps.apiKeys.insert(keyInput(accountId));
    getSms.mockResolvedValue({ ...SMS, sender: '7968' });
    const out = await receiver.pollOnce(target()) as { id: string };
    expect(deps.inbound.get(out.id)!.sender).toBe('7968');
  });

  it('-23 i -24 zatrzymują pętlę i zapisują błąd przy usłudze', async () => {
    getSms.mockRejectedValue(new ProviderError(-24, 'Usluga nie jest aktywna', 'permanent'));
    expect(await receiver.pollOnce(target())).toEqual({ kind: 'stopped', error: '-24: Usluga nie jest aktywna' });
    expect(deps.services.states(accountId)[0]!.error).toBe('-24: Usluga nie jest aktywna');
  });

  it('błąd sieci to błąd przejściowy z zapisem przyczyny', async () => {
    getSms.mockRejectedValue(new ProviderError(-71, 'Nie udało się połączyć: ECONNRESET', 'transient'));
    expect(await receiver.pollOnce(target())).toEqual({ kind: 'error', error: '-71: Nie udało się połączyć: ECONNRESET' });
    expect(deps.services.states(accountId)[0]!.error).toContain('ECONNRESET');
    getSms.mockResolvedValue(null);
    await receiver.pollOnce(target());
    expect(deps.services.states(accountId)[0]!.error).toBeNull();
  });

  it('przerwanie sygnałem nie zostawia błędu przy usłudze', async () => {
    const controller = new AbortController();
    controller.abort();
    getSms.mockRejectedValue(new ProviderError(-71, 'Żądanie przerwane', 'transient'));
    expect(await receiver.pollOnce(target(), controller.signal)).toEqual({ kind: 'error', error: 'przerwane' });
    expect(deps.services.states(accountId)[0]!.error).toBeNull();
  });

  it('nieudane potwierdzenie nie psuje wyniku - wiadomość i tak jest zapisana', async () => {
    deps.apiKeys.insert(keyInput(accountId));
    getSms.mockResolvedValue(SMS);
    confirmSms.mockRejectedValue(new ProviderError(-71, 'sieć', 'transient'));
    expect(await receiver.pollOnce(target())).toMatchObject({ kind: 'message', duplicate: false });
    expect(deps.inbound.list({ limit: 10, offset: 0 })).toHaveLength(1);
  });

  it('data odbioru nieczytelna: wiadomość zapisana z czasem bramki, nie zgubiona', async () => {
    deps.apiKeys.insert(keyInput(accountId));
    getSms.mockResolvedValue({ ...SMS, receivedAt: 'zla-data' });
    const out = await receiver.pollOnce(target()) as { id: string };
    expect(out).toMatchObject({ kind: 'message', duplicate: false });
    expect(deps.inbound.get(out.id)!.receivedAt).toBe(NOW.toISOString());
    expect(confirmSms).toHaveBeenCalledWith('22');
  });

  it('wyjątek przy zapisie: brak potwierdzenia, błąd przejściowy', async () => {
    deps.apiKeys.insert(keyInput(accountId));
    getSms.mockResolvedValue(SMS);
    deps.inbound.insertIfNew = () => { throw new Error('database or disk is full'); };
    expect(await receiver.pollOnce(target())).toMatchObject({ kind: 'error', error: 'database or disk is full' });
    expect(deps.services.states(accountId)[0]!.error).toBe('zapis nieudany: database or disk is full');
    expect(confirmSms).not.toHaveBeenCalled();
    expect(deps.inbound.list({ limit: 10, offset: 0 })).toHaveLength(0);
  });
});
