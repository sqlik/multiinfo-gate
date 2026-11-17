import { describe, expect, it } from 'vitest';
import { DELIVERY_REFRESH_MS, watchDeliveries } from '../../src/mcp/views/client/doreczenia.js';
import { FILE_REFRESH_MS, watchFileSend } from '../../src/mcp/views/client/plik.js';
import { CONVERSATION_REFRESH_MS, watchConversation } from '../../src/mcp/views/client/rozmowa.js';
import { PACKAGE_REFRESH_MS, watchPackage } from '../../src/mcp/views/client/rozsylka.js';

// Odświeżanie widoków liczy się do limitu żądań klucza. Odmowa limitu nie kończy odświeżania: widok odczekuje
// retryAfterSec z odmowy, informuje o tym pracownika i odświeża dalej (decyzja Tomka R3-D4).

const LIMITED = {
  isError: true, content: [{ type: 'text', text: 'Przekroczono limit 60 żądań na minutę klucza. Spróbuj ponownie za minutę.' }],
  structuredContent: { error: 'rate_limited', retryAfterSec: 60 },
};
const LIMIT_TEXT = 'Bramka wstrzymała odświeżanie z powodu limitu żądań klucza. Widok wznowi je za 60 s.';

function harness(results: unknown[]) {
  const timers: Array<{ fn: () => Promise<void>; ms: number }> = [];
  const events: unknown[] = [];
  const bridge = { callTool: async () => results.shift() };
  const win = { setTimeout: (fn: () => Promise<void>, ms: number) => { timers.push({ fn, ms }); } };
  const handlers = {
    onData: () => events.push('dane'),
    onEnd: (why: string, ...rest: string[]) => events.push(['koniec', why, ...rest]),
    onRetry: (detail: string, text?: string) => events.push(['ponowienie', text ?? '', detail]),
  };
  return { timers, events, bridge, win, handlers, step: async () => { await timers.shift()!.fn(); } };
}

describe('odświeżanie widoków po odmowie limitu żądań klucza', () => {
  const cases = [
    ['rozmowa', CONVERSATION_REFRESH_MS, { lastInboundId: 'in_1', items: [] }, (h: ReturnType<typeof harness>) => watchConversation(h.bridge, h.win, { phone: '48601000081' }, h.handlers, () => 0)],
    ['rozsyłka', PACKAGE_REFRESH_MS, { id: 'pkg_1', status: 'open', report: null }, (h: ReturnType<typeof harness>) => watchPackage(h.bridge, h.win, { id: 'pkg_1' }, h.handlers, () => 0)],
    ['wysyłka z pliku', FILE_REFRESH_MS, { id: 'fsd_1', packages: 1, byStatus: { open: 1 }, reportReady: false }, (h: ReturnType<typeof harness>) => watchFileSend(h.bridge, h.win, 'fsd_1', h.handlers, () => 0)],
  ] as const;

  for (const [name, refreshMs, data, start] of cases) {
    it(`${name}: odmowa limitu odczekuje retryAfterSec, informuje pracownika i odświeża dalej`, async () => {
      const h = harness([LIMITED, { structuredContent: data }]);
      start(h);
      expect(h.timers.map((t) => t.ms)).toEqual([refreshMs]);
      await h.step();
      expect(h.events).toEqual([['ponowienie', LIMIT_TEXT, '']]);
      expect(h.timers.map((t) => t.ms)).toEqual([60_000]);
      await h.step();
      expect(h.events).toEqual([['ponowienie', LIMIT_TEXT, ''], 'dane']);
      expect(h.timers.map((t) => t.ms)).toEqual([refreshMs]);
    });
  }

  it('doręczenia: odmowa limitu nie oznacza braku uprawnienia „Odczyt wysłanych” i odczyt wraca po retryAfterSec', async () => {
    const h = harness([LIMITED, { structuredContent: { counts: { delivered: 1 } } }]);
    const updates: unknown[] = [];
    watchDeliveries(h.bridge, h.win, 'drf_1', (d: unknown) => updates.push(d), () => 0);
    await h.step();
    expect(updates).toEqual([]);
    expect(h.timers.map((t) => t.ms)).toEqual([60_000]);
    await h.step();
    expect(updates).toEqual([{ counts: { delivered: 1 }, done: true }]);
    expect(DELIVERY_REFRESH_MS).toBe(15_000);
  });
});
