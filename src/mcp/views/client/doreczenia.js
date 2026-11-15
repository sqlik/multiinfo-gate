// Doręczenia po wysyłce, wspólne dla widoków wysyłki, grupy i przebiegu: odczyt list_messages z identyfikatorem
// szkicu co 15 s, do stanów ostatecznych albo 15 minut, oraz zdanie z liczbami w stanach.
import { esc } from './bridge.js';

export const DELIVERY_REFRESH_MS = 15_000;
export const DELIVERY_REFRESH_MAX_MS = 900_000;
const TRANSIT = new Set(['queued', 'sent', 'throttled']);
const COUNT_LABELS = {
  queued: 'w kolejce', sent: 'w drodze', throttled: 'wstrzymane', delivered: 'doręczone', failed: 'niedoręczone', expired: 'wygasłe',
  cancelled: 'anulowane', blocked: 'zablokowane', unknown: 'w stanie nieznanym',
};

/** Liczby doręczeń `n` wiadomości według odczytu `d` = { counts, done }. */
export function deliveryLine(n, d) {
  const counts = d.counts ?? {};
  const others = Object.entries(counts).filter(([k, v]) => k !== 'delivered' && v > 0).map(([k, v]) => `${COUNT_LABELS[k] ?? k} ${v}`);
  return `Doręczone: <b>${counts.delivered ?? 0}</b> z ${n}`
    + (others.length > 0 ? ` · ${esc(others.join(', '))}` : '') + (d.done ? '' : ' · stan odświeża się sam');
}

/**
 * Odświeżanie doręczeń szkicu `draftId`; `onUpdate` otrzymuje { counts, done } po każdym odczycie. Błąd pierwszego
 * odczytu oznacza brak uprawnienia „Odczyt wysłanych” i daje { unavailable: true }, a błąd późniejszy kończy
 * odświeżanie z ostatnimi liczbami.
 */
export function watchDeliveries(bridge, win, draftId, onUpdate, now = () => Date.now()) {
  const started = now();
  let last = null;
  async function tick() {
    let result;
    try {
      result = await bridge.callTool('list_messages', { draftId, limit: 1 });
    } catch {
      result = { isError: true };
    }
    if (result.isError) {
      last = last ? { ...last, done: true } : { unavailable: true };
      onUpdate(last);
      return;
    }
    const counts = result.structuredContent?.counts ?? {};
    const done = now() - started >= DELIVERY_REFRESH_MAX_MS || Object.entries(counts).every(([k, v]) => v === 0 || !TRANSIT.has(k));
    last = { counts, done };
    onUpdate(last);
    if (!done) win.setTimeout(tick, DELIVERY_REFRESH_MS);
  }
  win.setTimeout(tick, 0);
}
