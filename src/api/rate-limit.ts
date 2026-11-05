interface Bucket { tokens: number; updatedAt: number }

/** Od tylu kubełków ogranicznik usuwa nieużywane; mniejsza mapa nie wymaga sprzątania. */
const SWEEP_SIZE = 10_000;
/** Po minucie bez żądań kubełek jest pełny przy każdym limicie na minutę, więc jego usunięcie niczego nie zmienia. */
const IDLE_MS = 60_000;

/**
 * Kubełek żetonów, jeden na klucz - identyfikator klucza API albo tekst (np. adres źródłowy
 * dla `/hooks/`). Stan trzymany w pamięci procesu - przy jednym procesie to wystarcza,
 * a restart co najwyżej odblokowuje klucz wcześniej. Przy wielu adresach źródłowych
 * (serwer przekierowań) kubełki nieużywane od minuty są usuwane, żeby mapa nie rosła bez końca.
 */
export class RateLimiter {
  private readonly buckets = new Map<string | number, Bucket>();
  private lastSweep: number;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.lastSweep = now();
  }

  get size(): number {
    return this.buckets.size;
  }

  check(key: string | number, ratePerMin: number): boolean {
    const t = this.now();
    if (this.buckets.size >= SWEEP_SIZE && t - this.lastSweep >= IDLE_MS) this.sweep(t);
    const perMs = ratePerMin / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: ratePerMin, updatedAt: t };

    bucket.tokens = Math.min(ratePerMin, bucket.tokens + (t - bucket.updatedAt) * perMs);
    bucket.updatedAt = t;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  private sweep(t: number): void {
    for (const [key, bucket] of this.buckets) if (t - bucket.updatedAt >= IDLE_MS) this.buckets.delete(key);
    this.lastSweep = t;
  }
}
