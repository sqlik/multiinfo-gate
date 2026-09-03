import { isIPv4, isIPv6 } from 'node:net';
import type { Resolver } from '../net/private-address.ts';

export const SOURCE_CACHE_MS = 60_000;
export const SOURCE_RESOLVE_TIMEOUT_MS = 2_000;

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function parseSourceEntry(entry: string): { kind: 'ip' | 'cidr' | 'host' } | null {
  const value = entry.trim();
  if (value === '') return null;
  const slash = value.indexOf('/');
  if (slash !== -1) {
    const ip = value.slice(0, slash);
    const bitsRaw = value.slice(slash + 1);
    if (!/^\d+$/.test(bitsRaw)) return null;
    const bits = Number(bitsRaw);
    if (isIPv4(ip) && bits <= 32) return { kind: 'cidr' };
    if (isIPv6(ip) && bits <= 128) return { kind: 'cidr' };
    return null;
  }
  if (isIPv4(value) || isIPv6(value)) return { kind: 'ip' };
  return HOSTNAME.test(value) ? { kind: 'host' } : null;
}

/** Adres jako 128-bitowa liczba; IPv4 i odwzorowane `::ffff:a.b.c.d` w tej samej przestrzeni. */
function toBigInt(ip: string): bigint | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped ? mapped[1]! : ip;
  if (isIPv4(v4)) {
    const n = v4.split('.').reduce((acc, o) => (acc << 8n) | BigInt(o), 0n);
    return 0xffff00000000n | n;
  }
  if (!isIPv6(ip)) return null;
  const [head, tail = ''] = ip.split('::');
  const expand = (part: string) => (part === '' ? [] : part.split(':'));
  const left = expand(head!);
  const right = expand(tail);
  const zeros = Array.from({ length: 8 - left.length - right.length }, () => '0');
  const groups = ip.includes('::') ? [...left, ...zeros, ...right] : left;
  if (groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
}

function inCidr(ip: bigint, entry: string): boolean {
  const [base, bitsRaw] = entry.split('/');
  const baseN = toBigInt(base!);
  if (baseN === null) return false;
  const bits = Number(bitsRaw) + (isIPv4(base!) ? 96 : 0);
  const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
  return (ip & mask) === (baseN & mask);
}

/**
 * Lista źródeł integracji: adresy, zakresy i nazwy (DDNS dla NAS-a bez stałego adresu).
 * Nazwy rozwiązywane przy żądaniu z buforem, bo każde żądanie z Uptime Kumy nie może czekać na DNS.
 */
export class SourceMatcher {
  private readonly cache = new Map<string, { at: number; addresses: string[] }>();

  constructor(private readonly resolve: Resolver, private readonly now: () => number = () => Date.now()) {}

  async allowed(entries: string[], ip: string): Promise<boolean> {
    if (entries.length === 0) return true;
    const client = toBigInt(ip);
    if (client === null) return false;
    for (const entry of entries) {
      const parsed = parseSourceEntry(entry);
      if (!parsed) continue;
      const value = entry.trim();
      if (parsed.kind === 'ip' && toBigInt(value) === client) return true;
      if (parsed.kind === 'cidr' && inCidr(client, value)) return true;
      if (parsed.kind === 'host' && (await this.addressesOf(value)).some((a) => toBigInt(a) === client)) return true;
    }
    return false;
  }

  private async addressesOf(hostname: string): Promise<string[]> {
    const t = this.now();
    const hit = this.cache.get(hostname);
    if (hit && t - hit.at < SOURCE_CACHE_MS) return hit.addresses;
    let addresses: string[] = [];
    try {
      addresses = await Promise.race([
        this.resolve(hostname),
        new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('limit czasu DNS')), SOURCE_RESOLVE_TIMEOUT_MS).unref()),
      ]);
    } catch {
      addresses = [];
    }
    this.cache.set(hostname, { at: t, addresses });
    return addresses;
  }
}
