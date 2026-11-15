import { describe, expect, it } from 'vitest';
import { DELIVERY_REFRESH_MAX_MS, DELIVERY_REFRESH_MS, deliveryLine, watchDeliveries } from '../../src/mcp/views/client/doreczenia.js';

type Result = { isError?: boolean; structuredContent?: { counts: Record<string, number> } };

/** Atrapa mostu i okna: odpowiedzi list_messages po kolei, zegar i kolejka zaplanowanych odczytów. */
function fake(results: Array<Result | Error>) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const timers: Array<{ fn: () => Promise<void>; ms: number }> = [];
  let clock = 0;
  const bridge = {
    callTool: async (name: string, args: unknown) => {
      calls.push({ name, args });
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next ?? { isError: true };
    },
  };
  const win = { setTimeout: (fn: () => Promise<void>, ms: number) => { timers.push({ fn, ms }); } };
  const updates: unknown[] = [];
  watchDeliveries(bridge, win, 'drf_2', (d: unknown) => updates.push(d), () => clock);
  const step = async (advance = 0) => {
    clock += advance;
    await timers.shift()!.fn();
  };
  return { calls, timers, updates, step };
}

const counts = (c: Record<string, number>): Result => ({ structuredContent: { counts: c } });

describe('odświeżanie doręczeń', () => {
  it('watchDeliveries: odczyt list_messages z draftId co 15 s, koniec po stanach ostatecznych', async () => {
    const f = fake([counts({ sent: 2 }), counts({ delivered: 1, sent: 1 }), counts({ delivered: 1, failed: 1 })]);
    expect(f.timers.map((t) => t.ms)).toEqual([0]);
    await f.step();
    await f.step(DELIVERY_REFRESH_MS);
    await f.step(DELIVERY_REFRESH_MS);
    expect(f.calls).toEqual(Array(3).fill({ name: 'list_messages', args: { draftId: 'drf_2', limit: 1 } }));
    expect(f.updates).toEqual([
      { counts: { sent: 2 }, done: false }, { counts: { delivered: 1, sent: 1 }, done: false }, { counts: { delivered: 1, failed: 1 }, done: true },
    ]);
    expect(f.timers).toEqual([]);
  });

  it('watchDeliveries: błąd pierwszego odczytu oznacza brak odczytu wysłanych, błąd późniejszy kończy odświeżanie', async () => {
    const denied = fake([{ isError: true }]);
    await denied.step();
    expect(denied.updates).toEqual([{ unavailable: true }]);
    expect(denied.timers).toEqual([]);
    const broken = fake([counts({ queued: 2 }), new Error('zerwane połączenie')]);
    await broken.step();
    await broken.step(DELIVERY_REFRESH_MS);
    expect(broken.updates.at(-1)).toEqual({ counts: { queued: 2 }, done: true });
    expect(broken.timers).toEqual([]);
  });

  it('watchDeliveries: po 15 minutach odświeżanie kończy się także przy stanach w drodze', async () => {
    const f = fake([counts({ sent: 2 }), counts({ sent: 2 })]);
    await f.step();
    await f.step(DELIVERY_REFRESH_MAX_MS);
    expect(f.updates.at(-1)).toEqual({ counts: { sent: 2 }, done: true });
    expect(f.timers).toEqual([]);
  });

  it('deliveryLine: doręczone z liczbą wszystkich, pozostałe stany i informacja o odświeżaniu', () => {
    expect(deliveryLine(12, { counts: { delivered: 5, sent: 7 }, done: false })).toBe('Doręczone: <b>5</b> z 12 · w drodze 7 · stan odświeża się sam');
    expect(deliveryLine(2, { counts: { delivered: 2 }, done: true })).toBe('Doręczone: <b>2</b> z 2');
  });
});
