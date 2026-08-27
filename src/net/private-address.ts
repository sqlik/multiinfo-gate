import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

/** Rozwiązuje nazwę na listę adresów; testy podstawiają własną funkcję. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

export type WebhookTargetVerdict =
  | { kind: 'public' }
  | { kind: 'private'; address: string }
  | { kind: 'unresolved'; reason: string };

/** Zakresy IPv4, które nie są adresami w internecie: pętla zwrotna, sieci prywatne, link-local, CGNAT, multicast. */
const PRIVATE_V4: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x7f000000, 8], [0x64400000, 10], [0xa9fe0000, 16],
  [0xac100000, 12], [0xc0a80000, 16], [0xe0000000, 4], [0xf0000000, 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

function privateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

/**
 * Czy adres wskazuje maszynę poza internetem: hosta bramki, sieć kontenerów, sieć firmową.
 * Adresy IPv6 odwzorowane na IPv4 (`::ffff:a.b.c.d`) sprawdzane są jak IPv4.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIPv4(ip)) return privateV4(ip);
  if (!isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return privateV4(mapped[1]!);
  if (lower === '::' || lower === '::1') return true;
  // fc00::/7 (unikalne lokalne), fe80::/10 (link-local)
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

function isLocalName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/**
 * Werdykt o celu webhooka: adres literalny sprawdzany od razu, nazwa po rozwiązaniu -
 * wszystkie adresy muszą być publiczne, bo klient HTTP użyje dowolnego z nich.
 */
export async function webhookTarget(url: string, resolve: Resolver): Promise<WebhookTargetVerdict> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { kind: 'unresolved', reason: 'adres nie jest poprawnym URL' };
  }
  const literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (isLocalName(literal)) return { kind: 'private', address: literal };
  if (isIPv4(literal) || isIPv6(literal)) {
    return isPrivateAddress(literal) ? { kind: 'private', address: literal } : { kind: 'public' };
  }
  let addresses: string[];
  try {
    addresses = await resolve(literal);
  } catch (e) {
    return { kind: 'unresolved', reason: e instanceof Error ? e.message : String(e) };
  }
  if (addresses.length === 0) return { kind: 'unresolved', reason: 'nazwa nie ma żadnego adresu' };
  const inside = addresses.find(isPrivateAddress);
  return inside === undefined ? { kind: 'public' } : { kind: 'private', address: inside };
}

/** Wspólny komunikat panelu i workera, gdy cel webhooka leży w sieci wewnętrznej. */
export const PRIVATE_TARGET_MESSAGE = 'Adres webhooka wskazuje sieć wewnętrzną; bramka nie woła takich adresów, '
  + 'chyba że w środowisku ustawiono MIG_WEBHOOK_ALLOW_PRIVATE=1';
