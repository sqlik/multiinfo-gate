interface Bucket { tokens: number; updatedAt: number }

/**
 * Kubełek żetonów, jeden na klucz API. Stan trzymany w pamięci procesu - przy
 * jednym procesie to wystarcza, a restart co najwyżej odblokowuje klucz wcześniej.
 */
export class RateLimiter {
  private readonly buckets = new Map<number, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  check(apiKeyId: number, ratePerMin: number): boolean {
    const t = this.now();
    const perMs = ratePerMin / 60_000;
    const bucket = this.buckets.get(apiKeyId) ?? { tokens: ratePerMin, updatedAt: t };

    bucket.tokens = Math.min(ratePerMin, bucket.tokens + (t - bucket.updatedAt) * perMs);
    bucket.updatedAt = t;

    if (bucket.tokens < 1) {
      this.buckets.set(apiKeyId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(apiKeyId, bucket);
    return true;
  }
}
