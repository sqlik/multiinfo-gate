/**
 * Najstarsze wersje Node z wydania bezpieczeństwa z 21 października 2026: między innymi CVE-2026-111497
 * (błąd w dekoderze Brotli, który bramka uruchamia przez wbudowany `fetch` przy webhookach i zapytaniach
 * uzupełniających) oraz obejścia weryfikacji nazwy hosta w TLS.
 */
export const NODE_PATCHED: Readonly<Record<number, string>> = { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' };

/** Wersja dla linii bez wsparcia (nieparzystych i starszych niż 22). */
const FALLBACK = NODE_PATCHED[22]!;

const parts = (v: string): number[] => v.split('.').map((n) => Number(n));

function below(version: number[], minimum: number[]): boolean {
  for (let i = 0; i < 3; i += 1) {
    const a = version[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/** `null`, gdy wersja zawiera poprawki z 21 października 2026; w przeciwnym razie minimalna wersja do instalacji. */
export function nodeUpdateNeeded(version: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-\S+)?/.exec(version.trim());
  if (!m) return FALLBACK;
  const current = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Wersja wstępna albo nocna (22.23.4-rc.1) poprzedza wydanie o tym numerze, więc poprawek jeszcze nie zawiera.
  const prerelease = m[4] !== undefined;
  const major = current[0]!;
  const lines = Object.keys(NODE_PATCHED).map(Number);
  if (major > Math.max(...lines)) return null;
  const minimum = NODE_PATCHED[major];
  if (minimum === undefined) return FALLBACK;
  const min = parts(minimum);
  const equal = current.every((n, i) => n === min[i]);
  return below(current, min) || (prerelease && equal) ? minimum : null;
}

/** Wersja zainstalowana należy do linii bez wydania z poprawkami (nieparzystej albo starszej niż 22). */
export const unsupportedLine = (installed: string, minimum: string): boolean =>
  parts(plainVersion(installed))[0] !== parts(minimum)[0];

/** Numer wersji Node bez litery `v`, do komunikatów. */
export const plainVersion = (version: string): string => version.trim().replace(/^v/, '');
