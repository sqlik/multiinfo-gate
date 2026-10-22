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

/** Adres IPv6 jako 16 bajtów: rozwija `::` i końcówkę w zapisie IPv4; `null`, gdy zapis jest nieprawidłowy. */
function v6ToBytes(ip: string): Uint8Array | null {
  const groups: number[] = [];
  const pushPart = (part: string): boolean => {
    if (part.includes('.')) {
      if (!isIPv4(part)) return false;
      const n = v4ToInt(part);
      groups.push(n >>> 16, n & 0xffff);
      return true;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return false;
    groups.push(parseInt(part, 16));
    return true;
  };
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1]!.split(':') : [];
  for (const part of head) if (!pushPart(part)) return null;
  const headLen = groups.length;
  for (const part of tail) if (!pushPart(part)) return null;
  const missing = 8 - groups.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  groups.splice(headLen, 0, ...new Array<number>(missing).fill(0));
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => { bytes[2 * i] = g >> 8; bytes[2 * i + 1] = g & 0xff; });
  return bytes;
}

const prefixIs = (bytes: Uint8Array, prefix: number[]): boolean => prefix.every((b, i) => bytes[i] === b);
const embeddedV4 = (bytes: Uint8Array): string => Array.from(bytes.slice(12)).join('.');

/**
 * Czy adres wskazuje maszynę poza internetem: hosta bramki, sieć kontenerów, sieć firmową.
 * IPv6 jest sprawdzany po rozbiorze na bajty, więc każdy zapis tego samego adresu daje ten sam
 * wynik. Adresy z osadzonym IPv4 (odwzorowane `::ffff:0:0/96`, zgodne `::/96`, NAT64 `64:ff9b::/96`)
 * są sprawdzane jak ten IPv4.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIPv4(ip)) return privateV4(ip);
  if (!isIPv6(ip)) return false;
  const bytes = v6ToBytes(ip.toLowerCase());
  if (bytes === null) return true;
  if (prefixIs(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) return privateV4(embeddedV4(bytes));
  if (prefixIs(bytes, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return privateV4(embeddedV4(bytes));
  if (prefixIs(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) {
    // `::` (nieokreślony) i `::1` (pętla zwrotna) są wewnętrzne; reszta `::/96` to osadzony IPv4.
    const v4 = embeddedV4(bytes);
    return v4 === '0.0.0.0' || v4 === '0.0.0.1' || privateV4(v4);
  }
  // fc00::/7 (unikalne lokalne), fe80::/10 (link-local)
  return (bytes[0]! & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80);
}

function isLocalName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/**
 * Werdykt o nazwie hosta: adres literalny i `localhost` sprawdzane od razu, nazwa po
 * rozwiązaniu - wszystkie adresy muszą być publiczne, bo klient użyje dowolnego z nich.
 */
export async function hostTarget(hostname: string, resolve: Resolver): Promise<WebhookTargetVerdict> {
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

/** Werdykt o celu webhooka: nazwa hosta z URL sprawdzana przez `hostTarget`. */
export async function webhookTarget(url: string, resolve: Resolver): Promise<WebhookTargetVerdict> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { kind: 'unresolved', reason: 'adres nie jest poprawnym URL' };
  }
  return hostTarget(hostname, resolve);
}

/** Wspólny komunikat panelu i workera, gdy cel webhooka leży w sieci wewnętrznej. */
export const PRIVATE_TARGET_MESSAGE = 'Adres webhooka wskazuje sieć wewnętrzną; bramka nie woła takich adresów, '
  + 'chyba że w środowisku ustawiono MIG_WEBHOOK_ALLOW_PRIVATE=1';

/** Komunikat panelu i pollera, gdy serwer IMAP leży w sieci wewnętrznej. */
export const PRIVATE_MAIL_MESSAGE = 'Serwer IMAP ma adres w sieci wewnętrznej. Bramka łączy się z takim serwerem wyłącznie '
  + 'przy ustawionej zmiennej MIG_MAIL_ALLOW_PRIVATE=1 w środowisku bramki';
