// Doręczenia po wysyłce, wspólne dla widoków wysyłki, grupy i przebiegu: odczyt list_messages z identyfikatorem
// szkicu co 15 s, do stanów ostatecznych albo 15 minut, oraz zdanie z liczbami w stanach.
import { esc, rateLimitWait, retryable, tile } from './bridge.js';

export const DELIVERY_REFRESH_MS = 15_000;
export const DELIVERY_REFRESH_MAX_MS = 900_000;
const TRANSIT = new Set(['queued', 'sent', 'throttled']);
/** Nazwy stanów przy liczbach, wspólne dla doręczeń i raportu rozsyłki; „przedawnione” jak „przedawniona” w panelu. */
export const STATE_LABELS = {
  queued: 'w kolejce', sent: 'w drodze', throttled: 'wstrzymane', delivered: 'doręczone', failed: 'niedoręczone', expired: 'przedawnione',
  cancelled: 'anulowane', blocked: 'zablokowane', unknown: 'w stanie nieznanym',
};

/** Zdanie po wysyłce, gdy połączenie nie może odczytać doręczeń. */
export const NO_READ_SENT = 'Stan doręczeń wymaga uprawnienia „Odczyt wysłanych”, które nadaje administrator bramki w integracji Agent AI';

/** Liczby doręczeń `n` wiadomości według odczytu `d` = { counts, done }. */
export function deliveryLine(n, d) {
  const counts = d.counts ?? {};
  const others = Object.entries(counts).filter(([k, v]) => k !== 'delivered' && v > 0).map(([k, v]) => `${STATE_LABELS[k] ?? k} ${v}`);
  return `Doręczone: <b>${counts.delivered ?? 0}</b> z ${n}`
    + (others.length > 0 ? ` · ${esc(others.join(', '))}` : '') + (d.done ? '' : ' · stan odświeża się sam');
}

/** Kafel podsumowania po wysyłce `n` wiadomości: liczba doręczonych albo samo przyjęcie, gdy odczytu brak. */
export function deliveryTile(n, d, accepted) {
  if (!d || d.unavailable) return tile('Wysyłka', 'przyjęta', accepted);
  return tile('Doręczone', `${d.counts?.delivered ?? 0} z ${n}`, d.done ? 'stan ostateczny' : 'stan odświeża się sam', 'ok');
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
    } catch (error) {
      // Błąd połączenia nie oznacza braku uprawnienia: odczyt wraca za 15 s, a po 15 minutach liczby zostają ostatnie.
      if (retryable(error)) {
        if (now() - started < DELIVERY_REFRESH_MAX_MS) win.setTimeout(tick, DELIVERY_REFRESH_MS);
        else if (last) onUpdate({ ...last, done: true });
        return;
      }
      result = { isError: true };
    }
    // Odmowa limitu żądań klucza nie oznacza braku uprawnienia: odczyt wraca po retryAfterSec.
    const limited = rateLimitWait(result);
    if (limited !== null) {
      if (now() - started < DELIVERY_REFRESH_MAX_MS) win.setTimeout(tick, limited);
      else if (last) onUpdate({ ...last, done: true });
      return;
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
