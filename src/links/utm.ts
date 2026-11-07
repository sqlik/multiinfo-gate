// Parametry UTM i wzorzec grupowania adresów docelowych.
// Adres jest modyfikowany jako tekst, a nie przez `URL`, żeby zapis istniejącego zapytania pozostał
// bez zmian. Podpisany adres przestaje działać po ponownym zakodowaniu parametrów.

const PLACEHOLDER = '{…}';

function splitHash(url: string): [string, string] {
  const i = url.indexOf('#');
  return i === -1 ? [url, ''] : [url.slice(0, i), url.slice(i)];
}

function queryKeys(query: string): string[] {
  return query.split('&').map((pair) => pair.split('=')[0]!.toLowerCase());
}

export function withUtm(target: string, campaign: string): string {
  const [base, hash] = splitHash(target);
  const q = base.indexOf('?');
  if (q !== -1 && queryKeys(base.slice(q + 1)).some((key) => key.startsWith('utm_'))) return target;
  const utm = `utm_source=sms&utm_medium=sms&utm_campaign=${encodeURIComponent(campaign)}`;
  const separator = q === -1 ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&';
  return `${base}${separator}${utm}${hash}`;
}

/** Cyfra poza zapisem `%XX`, ponieważ zakodowana litera, na przykład `%C4%85`, nie wyróżnia odbiorcy. */
const hasDigit = (segment: string): boolean => /\d/.test(segment.replace(/%[0-9A-Fa-f]{2}/g, ''));

/** Człony ścieżki z cyfrą zastąpione `{…}`; gdy żaden człon nie zawiera cyfry, zastąpiony jest ostatni niepusty człon. */
function pathPattern(path: string): string {
  const segments = path.split('/');
  if (segments.some(hasDigit)) return segments.map((s) => (hasDigit(s) ? PLACEHOLDER : s)).join('/');
  const last = segments.findLastIndex((s) => s !== '');
  if (last !== -1) segments[last] = PLACEHOLDER;
  return segments.join('/');
}

/**
 * Wzorzec do grupowania linków indywidualnych: człony ścieżki z numerem odbiorcy (albo ostatni człon)
 * i wartości zapytania zastąpione `{…}`. Na przykład `klient/10482/przeglad` daje `klient/{…}/przeglad`.
 */
export function targetPattern(url: string): string {
  const [base] = splitHash(url);
  const q = base.indexOf('?');
  const beforeQuery = q === -1 ? base : base.slice(0, q);
  const pathStart = beforeQuery.indexOf('/', beforeQuery.indexOf('://') + 3);
  const pattern = pathStart === -1 ? beforeQuery : beforeQuery.slice(0, pathStart) + pathPattern(beforeQuery.slice(pathStart));
  if (q === -1) return pattern;
  const query = base
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1 ? PLACEHOLDER : `${pair.slice(0, eq + 1)}${PLACEHOLDER}`;
    })
    .join('&');
  return `${pattern}?${query}`;
}

/**
 * Wzorzec adresu indywidualnego po retencji, ostrzejszy od `targetPattern`: zostaje host bez danych
 * logowania i pierwszy człon ścieżki, a reszta ścieżki i całe zapytanie stają się `{…}`. Na przykład
 * `klient/jan-kowalski/przeglad?kod=9` daje `klient/{…}?{…}`. Pierwszy człon z cyfrą albo ze średnikiem
 * i człon jedyny w adresie też stają się `{…}`, ponieważ mogą wskazywać odbiorcę.
 */
export function retentionPattern(url: string): string {
  const [base] = splitHash(url);
  const q = base.indexOf('?');
  const beforeQuery = q === -1 ? base : base.slice(0, q);
  const query = q === -1 ? '' : base.slice(q + 1);
  const authorityStart = beforeQuery.indexOf('://') + 3;
  const pathStart = beforeQuery.indexOf('/', authorityStart);
  const authority = pathStart === -1 ? beforeQuery.slice(authorityStart) : beforeQuery.slice(authorityStart, pathStart);
  let out = `${beforeQuery.slice(0, authorityStart)}${authority.slice(authority.lastIndexOf('@') + 1)}`;
  if (pathStart !== -1) {
    const [first = '', ...rest] = beforeQuery.slice(pathStart + 1).split('/');
    const restHasData = rest.some((segment) => segment !== '');
    const keepFirst = first !== '' && !hasDigit(first) && !first.includes(';') && (restHasData || query !== '');
    if (first === '' && !restHasData) out += '/';
    else if (!keepFirst) out += `/${PLACEHOLDER}`;
    else out += `/${first}${restHasData ? `/${PLACEHOLDER}` : rest.length > 0 ? '/' : ''}`;
  }
  return query === '' ? out : `${out}?${PLACEHOLDER}`;
}
