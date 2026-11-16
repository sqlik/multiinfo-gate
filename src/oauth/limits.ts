import { isIPv4, isIPv6 } from 'node:net';
import { v6ToBytes } from '../net/private-address.ts';

/**
 * Klucz źródła do limitów: adres IPv4 bez zmian, IPv4 zapisany jako IPv6 jako IPv4, a IPv6 jako sieć /64.
 * Jeden przydział IPv6 obejmuje miliardy adresów, więc liczenie pojedynczych adresów nie ograniczałoby niczego.
 */
export function sourceKey(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const bytes = v6ToBytes(ip);
  if (bytes === null) return ip;
  const groups = Array.from({ length: 4 }, (_, i) => ((bytes[2 * i]! << 8) | bytes[2 * i + 1]!).toString(16));
  return `${groups.join(':')}::/64`;
}

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
