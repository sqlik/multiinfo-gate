/** Okno stałe na klucz (adres źródłowy albo klucz globalny): `limit` zdarzeń, potem blokada do końca okna. */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = () => Date.now()) {}

  blocked(key: string): boolean {
    const entry = this.windows.get(key);
    return entry !== undefined && this.now() - entry.start < this.windowMs && entry.count >= this.limit;
  }

  hit(key: string): void {
    const now = this.now();
    const entry = this.windows.get(key);
    if (entry === undefined || now - entry.start >= this.windowMs) this.windows.set(key, { start: now, count: 1 });
    else entry.count += 1;
    if (this.windows.size > 10_000) this.sweep(now);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.windows) if (now - entry.start >= this.windowMs) this.windows.delete(key);
  }
}
