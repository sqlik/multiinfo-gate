// Rozpoznawanie linków w treści SMS-a. Linkiem jest wyłącznie adres ze schematem http:// albo https://.
// Adres bez schematu (www.firma.pl) nie jest rozpoznawany, ponieważ jego granice są niejednoznaczne.

/** Przesunięcia w jednostkach UTF-16, `end` wyłącznie. */
export interface FoundLink { start: number; end: number; url: string }

const LINK = /https?:\/\/\S+/gi;
const SCHEME = /^https?:\/\/$/i;
/** Znaki na końcu adresu, które w treści należą do zdania, a nie do linku. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '…', '"', "'", '»', '”']);

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

function trimTrailing(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && TRAILING.has(last)) {
      end--;
      continue;
    }
    // Nawias zamykający należy do adresu tylko wtedy, gdy ma parę wewnątrz adresu: https://firma.pl/a_(b).
    if (last === ')' && count(url.slice(0, end), ')') > count(url.slice(0, end), '(')) {
      end--;
      continue;
    }
    return url.slice(0, end);
  }
}

export function findLinks(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const match of text.matchAll(LINK)) {
    const url = trimTrailing(match[0]);
    if (SCHEME.test(url)) continue;
    found.push({ start: match.index, end: match.index + url.length, url });
  }
  return found;
}

/** Host małymi literami w ASCII (punycode), bez portu; null dla adresu, którego `new URL` nie przyjmuje. */
export function hostOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return host === '' ? null : host;
}
