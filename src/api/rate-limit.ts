interface Bucket { tokens: number; updatedAt: number }

const tokensAt = (bucket: Bucket, ratePerMin: number, t: number): number =>
  Math.min(ratePerMin, bucket.tokens + (t - bucket.updatedAt) * (ratePerMin / 60_000));

/** Od tylu kubełków ogranicznik usuwa nieużywane; mniejsza mapa nie wymaga sprzątania. */
const SWEEP_SIZE = 10_000;
/** Po minucie bez żądań kubełek jest pełny przy każdym limicie na minutę, więc jego usunięcie niczego nie zmienia. */
const IDLE_MS = 60_000;
/** Górna granica mapy: przy zalewie żądań z wielu adresów w ciągu minuty najstarsze kubełki ustępują nowym. */
const MAX_KEYS = 100_000;

/**
 * Kubełek żetonów, jeden na klucz - identyfikator klucza API albo tekst (np. adres źródłowy
 * dla `/hooks/`). Stan trzymany w pamięci procesu - przy jednym procesie to wystarcza,
 * a restart co najwyżej odblokowuje klucz wcześniej. Przy wielu adresach źródłowych
 * (serwer przekierowań) kubełki nieużywane od minuty są usuwane, a liczba kubełków ma górną granicę,
 * żeby mapa nie rosła bez końca.
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
    const existing = this.buckets.get(key);
    const bucket = existing ?? { tokens: ratePerMin, updatedAt: t };

    bucket.tokens = tokensAt(bucket, ratePerMin, t);
    bucket.updatedAt = t;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;

    if (existing === undefined) {
      if (this.buckets.size >= MAX_KEYS) this.evictOldest();
      this.buckets.set(key, bucket);
    }
    return allowed;
  }

  /** Czy kubełek jest pusty, bez zużycia żetonu. Klucz bez kubełka ma pełny kubełek. */
  exhausted(key: string | number, ratePerMin: number): boolean {
    const bucket = this.buckets.get(key);
    return bucket !== undefined && tokensAt(bucket, ratePerMin, this.now()) < 1;
  }

  /** Usuwa jedną dziesiątą najstarszych kubełków naraz: usuwanie po jednym byłoby kwadratowe przy pełnej mapie. */
  private evictOldest(): void {
    let left = MAX_KEYS / 10;
    for (const key of this.buckets.keys()) {
      if (left-- <= 0) break;
      this.buckets.delete(key);
    }
  }

  private sweep(t: number): void {
    for (const [key, bucket] of this.buckets) if (t - bucket.updatedAt >= IDLE_MS) this.buckets.delete(key);
    this.lastSweep = t;
  }
}
