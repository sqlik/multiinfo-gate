import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/multiinfo/response.ts';
import { INBOUND_BACKOFF_MS, Receiver } from '../../src/inbound/receiver.ts';
import { SMS, buildReceiverDeps, keyInput } from './helpers.ts';

/** Czeka, aż warunek się spełni albo minie limit - pętle działają w tle. */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('warunek nie spełnił się w czasie');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Receiver - pętle', () => {
  it('bez subskrybentów nie pyta; subskrypcja zapala pętlę, jej brak gasi', async () => {
    const { deps, accountId, getSms } = buildReceiverDeps();
    getSms.mockResolvedValue(null);
    const receiver = new Receiver({ ...deps, idleMs: 20, sleep: undefined });
    receiver.refresh();
    expect(receiver.listening()).toEqual([]);
    expect(getSms).not.toHaveBeenCalled();

    const keyId = deps.apiKeys.insert(keyInput(accountId));
    receiver.refresh();
    expect(receiver.listening()).toEqual([{ accountId, serviceId: '24138' }]);
    await until(() => getSms.mock.calls.length >= 2);

    deps.apiKeys.revoke(keyId);
    receiver.refresh();
    await until(() => receiver.listening().length === 0);
    const calls = getSms.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(getSms.mock.calls.length).toBe(calls);
    await receiver.stop();
  });

  it('po wiadomości pyta od razu, po pustej odpowiedzi czeka idleMs', async () => {
    const { deps, accountId, getSms } = buildReceiverDeps();
    deps.apiKeys.insert(keyInput(accountId));
    const sleeps: number[] = [];
    getSms.mockResolvedValueOnce(SMS).mockResolvedValueOnce({ ...SMS, miId: '23' }).mockResolvedValue(null);
    const receiver = new Receiver({ ...deps, idleMs: 30_000, sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 1)); } });
    receiver.refresh();
    await until(() => sleeps.length >= 2);
    await receiver.stop();
    // Dwie wiadomości bez czekania, potem każda pusta odpowiedź z przerwą.
    expect(getSms.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(sleeps.slice(0, 2)).toEqual([30_000, 30_000]);
    expect(deps.inbound.list({ limit: 10, offset: 0 })).toHaveLength(2);
  });

  it('błąd przejściowy: wycofywanie rosnące, zerowane po sukcesie', async () => {
    const { deps, accountId, getSms } = buildReceiverDeps();
    deps.apiKeys.insert(keyInput(accountId));
    const sleeps: number[] = [];
    getSms
      .mockRejectedValueOnce(new ProviderError(-71, 'sieć', 'transient'))
      .mockRejectedValueOnce(new ProviderError(-71, 'sieć', 'transient'))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new ProviderError(-71, 'sieć', 'transient'))
      .mockResolvedValue(null);
    const receiver = new Receiver({ ...deps, idleMs: 0, sleep: async (ms) => { sleeps.push(ms); } });
    receiver.refresh();
    await until(() => getSms.mock.calls.length >= 5);
    await receiver.stop();
    expect(sleeps.slice(0, 3)).toEqual([INBOUND_BACKOFF_MS[0], INBOUND_BACKOFF_MS[1], INBOUND_BACKOFF_MS[0]]);
  });

  it('-24 zatrzymuje pętlę do czasu refresh() po zmianie konfiguracji', async () => {
    const { deps, accountId, getSms } = buildReceiverDeps();
    deps.apiKeys.insert(keyInput(accountId));
    getSms.mockRejectedValueOnce(new ProviderError(-24, 'nieaktywna', 'permanent')).mockResolvedValue(null);
    const receiver = new Receiver({ ...deps, idleMs: 20, sleep: undefined });
    receiver.refresh();
    await until(() => receiver.listening().length === 0);
    expect(getSms).toHaveBeenCalledTimes(1);
    expect(receiver.health()).toEqual({ services: 1, listening: 0, errors: [{ account: 'Firma', serviceId: '24138', error: '-24: nieaktywna' }] });
    // Zwykły tik odświeżania nie wznawia pętli zatrzymanej błędem konfiguracji.
    receiver.refresh();
    expect(receiver.listening()).toEqual([]);
    // Zmiana konfiguracji w panelu wznawia jawnie.
    receiver.refresh({ retryStopped: true });
    await until(() => getSms.mock.calls.length >= 2);
    expect(receiver.health().errors).toEqual([]);
    await receiver.stop();
  });

  it('wyjątek poza zapisem (np. brak sekretów konta) nie zabija pętli', async () => {
    const { deps, accountId, getSms } = buildReceiverDeps();
    deps.apiKeys.insert(keyInput(accountId));
    getSms.mockResolvedValue(null);
    const client = deps.clients.for(accountId);
    const forSpy = vi.spyOn(deps.clients, 'for')
      .mockImplementationOnce(() => { throw new Error('Nie udało się odszyfrować sekretów'); })
      .mockImplementation(() => client);
    const receiver = new Receiver({ ...deps, idleMs: 20, sleep: async () => {} });
    receiver.refresh();
    await until(() => getSms.mock.calls.length >= 2);
    expect(forSpy).toHaveBeenCalled();
    expect(receiver.listening()).toHaveLength(1);
    await receiver.stop();
    expect(deps.services.states(accountId)[0]!.error).toBeNull();
  });

  it('cel zgaszony (brak subskrybentów) nie zostawia błędu przy usłudze ani w /healthz', async () => {
    const { deps, accountId, getSms } = buildReceiverDeps();
    const keyId = deps.apiKeys.insert(keyInput(accountId));
    getSms.mockRejectedValue(new ProviderError(-24, 'nieaktywna', 'permanent'));
    const receiver = new Receiver({ ...deps, idleMs: 20, sleep: undefined });
    receiver.refresh();
    await until(() => receiver.listening().length === 0);
    expect(receiver.health().errors).toHaveLength(1);
    // Administrator odpowiada na błąd wyłączeniem odbioru: stan „zatrzymany” nie ma już czego dotyczyć.
    deps.apiKeys.revoke(keyId);
    receiver.refresh();
    expect(deps.services.states(accountId)[0]!.error).toBeNull();
    expect(receiver.health()).toEqual({ services: 0, listening: 0, errors: [] });
    await receiver.stop();
  });

  it('stop() przerywa oczekujące pytanie', async () => {
    const { deps, accountId, getSms } = buildReceiverDeps();
    deps.apiKeys.insert(keyInput(accountId));
    getSms.mockImplementation((_s: string, _t: number, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new ProviderError(-71, 'Żądanie przerwane', 'transient')));
    }));
    const receiver = new Receiver(deps);
    receiver.refresh();
    await until(() => getSms.mock.calls.length === 1);
    const started = Date.now();
    await receiver.stop();
    expect(Date.now() - started).toBeLessThan(500);
    expect(receiver.listening()).toEqual([]);
    expect(deps.services.states(accountId)[0]!.error).toBeNull();
  });

  it('start() odświeża od razu i potem co REFRESH_INTERVAL_MS', async () => {
    // setImmediate zostaje prawdziwy: pętla oddaje nim turę, a udawany kręciłby się bez końca.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { deps, accountId, getSms } = buildReceiverDeps();
      getSms.mockResolvedValue(null);
      const receiver = new Receiver({ ...deps, idleMs: 1000, sleep: undefined });
      receiver.start();
      expect(receiver.listening()).toEqual([]);
      deps.apiKeys.insert(keyInput(accountId));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(receiver.listening()).toHaveLength(1);
      vi.useRealTimers();
      await receiver.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
