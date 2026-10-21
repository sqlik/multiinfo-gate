/** Część adresu po małpie małymi literami; pusta, gdy adres nie ma małpy. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}

/** Czy `candidate` to `domain` albo jej poddomena. */
const within = (candidate: string, domain: string): boolean => candidate === domain || candidate.endsWith(`.${domain}`);

/**
 * Sprawdzenie SPF/DKIM po nagłówku `Authentication-Results` dopisanym przez serwer skrzynki.
 * Przepuszcza `dkim=pass` z `header.d` równym domenie `From` albo jej domenie nadrzędnej
 * oraz `spf=pass` z `smtp.mailfrom` w domenie `From`. Liczy się wyłącznie pierwszy nagłówek
 * od góry: serwer odbierający dopisuje swój nad wszystkimi, które przyszły z mailem, więc
 * nagłówek podrobiony przez nadawcę ląduje niżej i nie jest czytany (RFC 8601, sekcja 5).
 * Bramka nie zna nazwy serwera (authserv-id), dlatego nie porównuje jej z treścią nagłówka.
 */
export function authResultsPass(headers: string[], fromDomain: string): boolean {
  const domain = fromDomain.trim().toLowerCase();
  if (domain === '') return false;
  for (const header of headers.slice(0, 1)) {
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
