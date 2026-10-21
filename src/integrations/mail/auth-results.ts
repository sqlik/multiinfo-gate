/** Część adresu po małpie małymi literami; pusta, gdy adres nie ma małpy. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}

/** Czy `candidate` to `domain` albo jej poddomena. */
const within = (candidate: string, domain: string): boolean => candidate === domain || candidate.endsWith(`.${domain}`);

/**
 * Sprawdzenie SPF/DKIM po nagłówkach `Authentication-Results` dopisanych przez serwer skrzynki.
 * Przepuszcza `dkim=pass` z `header.d` równym domenie `From` albo jej domenie nadrzędnej
 * oraz `spf=pass` z `smtp.mailfrom` w domenie `From`. Liczy się każdy nagłówek; bramka nie
 * sprawdza, który serwer go dopisał (świadome uproszczenie ze specyfikacji).
 */
export function authResultsPass(headers: string[], fromDomain: string): boolean {
  const domain = fromDomain.trim().toLowerCase();
  if (domain === '') return false;
  for (const header of headers) {
    const h = header.toLowerCase();
    for (const m of h.matchAll(/dkim=pass\b[^;]*?header\.d=([^\s;()]+)/g)) {
      const d = m[1]!;
      if (within(domain, d)) return true;
    }
    for (const m of h.matchAll(/spf=pass\b[^;]*?smtp\.mailfrom=([^\s;()]+)/g)) {
      const mailfrom = m[1]!;
      const mfDomain = mailfrom.includes('@') ? domainOf(mailfrom) : mailfrom;
      if (within(mfDomain, domain)) return true;
    }
  }
  return false;
}
