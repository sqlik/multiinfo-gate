/** Część adresu po małpie małymi literami; pusta, gdy adres nie ma małpy. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}

/** Czy `candidate` to `domain` albo jej poddomena. */
const within = (candidate: string, domain: string): boolean => candidate === domain || candidate.endsWith(`.${domain}`);

/** Czy niepusta domena `candidate` to niepusta `domain` albo jej poddomena. */
export function inDomain(candidate: string, domain: string): boolean {
  return candidate !== '' && domain !== '' && within(candidate.toLowerCase(), domain.toLowerCase());
}

/** Usuwa komentarze w nawiasach (CFWS, RFC 5322), także zagnieżdżone i z ukośnikiem przed nawiasem. */
export function stripComments(header: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < header.length; i += 1) {
    const ch = header[i]!;
    if (ch === '\\' && depth > 0) { i += 1; continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')' && depth > 0) { depth -= 1; continue; }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Nazwa serwera (authserv-id) z nagłówka: pierwszy token przed `;`, bez wersji, małymi literami; `null`, gdy pusty.
 * Nagłówek, który zaczyna się od wyniku (`spf=pass …`, starsza postać Exchange Online), nie zawiera nazwy serwera.
 */
export function authservIdOf(header: string): string | null {
  const head = stripComments(header).split(';')[0]!.trim();
  const id = head.split(/\s+/)[0] ?? '';
  return id === '' || id.includes('=') ? null : id.toLowerCase();
}

/**
 * Jawna porażka DMARC albo compauth w którymkolwiek nagłówku. Nadawca może dopisać tylko porażkę, która szkodzi
 * jemu samemu, dlatego liczą się wszystkie nagłówki, nie tylko pierwszy.
 */
export function authResultsFailDmarc(headers: string[]): boolean {
  return headers.some((h) => /(?:^|[\s;])(?:dmarc|compauth)\s*=\s*fail\b/.test(stripComments(h).toLowerCase()));
}

/**
 * Sprawdzenie SPF/DKIM po nagłówku `Authentication-Results` dopisanym przez serwer skrzynki.
 * Przepuszcza `dkim=pass` z `header.d` równym domenie `From` albo jej domenie nadrzędnej
 * oraz `spf=pass` z `smtp.mailfrom` w domenie `From`. Komentarze w nawiasach są pomijane,
 * żeby `dkim=pass` wpisane w komentarzu nie liczyło się jako wynik.
 * Bez `authservId` liczy się wyłącznie pierwszy nagłówek od góry: serwer odbierający dopisuje
 * swój nad wszystkimi, które przyszły z mailem, więc nagłówek podrobiony przez nadawcę ląduje
 * niżej i nie jest czytany (RFC 8601, sekcja 5). Z `authservId` (nazwa podana przez
 * administratora) ten pierwszy nagłówek musi nosić tę nazwę, inaczej wynik to odmowa: chroni to
 * przed mailem, do którego serwer nie dopisał własnego nagłówka, a nadawca podrobił cudzy.
 * Nagłówki niżej nie są czytane nigdy, także z nazwą serwera: nadawca może je wpisać sam.
 */
export function authResultsPass(headers: string[], fromDomain: string, authservId = ''): boolean {
  const domain = fromDomain.trim().toLowerCase();
  if (domain === '') return false;
  const wanted = authservId.trim().toLowerCase();
  const first = headers[0];
  if (first === undefined) return false;
  if (wanted !== '' && authservIdOf(first) !== wanted) return false;
  const h = stripComments(first).toLowerCase();
  for (const m of h.matchAll(/dkim=pass\b[^;]*?header\.d=([^\s;()]+)/g)) {
    if (within(domain, m[1]!)) return true;
  }
  for (const m of h.matchAll(/spf=pass\b[^;]*?smtp\.mailfrom=([^\s;()]+)/g)) {
    const mailfrom = m[1]!;
    const mfDomain = mailfrom.includes('@') ? domainOf(mailfrom) : mailfrom;
    if (within(mfDomain, domain)) return true;
  }
  return false;
}
