import type { MailInConfig } from '../config.ts';

export type SenderEntry = MailInConfig['senders'][number];

/**
 * Dopasowanie adresu `From` do listy nadawców: pełny adres ma pierwszeństwo przed domeną,
 * porównanie bez wielkości liter, domena nie obejmuje poddomen. Pusta lista to „nikt”.
 */
export function matchSender(from: string, senders: SenderEntry[]): SenderEntry | null {
  const address = from.trim().toLowerCase();
  if (address === '' || !address.includes('@')) return null;
  const domain = address.slice(address.lastIndexOf('@'));
  let byDomain: SenderEntry | null = null;
  for (const s of senders) {
    const p = s.pattern.trim().toLowerCase();
    if (p === address) return s;
    if (byDomain === null && p.startsWith('@') && p === domain) byDomain = s;
  }
  return byDomain;
}
