/**
 * Daty dzienne w panelu są w czasie polskim, a baza trzyma chwile UTC.
 * Nie polegamy na strefie procesu - kontener chodzi w UTC.
 */
const TIME_ZONE = 'Europe/Warsaw';

const CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function warsawParts(at: Date): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const parts = CLOCK.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

/** Przesunięcie strefy w danej chwili: ile trzeba dodać do UTC, żeby dostać czas ścienny. */
function offsetMs(at: Date): number {
  const p = warsawParts(at);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - at.getTime();
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Chwila UTC, w której kończy się dany dzień w Polsce: północ następnego dnia.
 * Dwa przebiegi, bo przesunięcie w dniu zmiany czasu zależy od wyniku.
 */
export function endOfWarsawDay(day: string): string {
  const m = DAY.exec(day);
  if (!m) throw new Error(`Data musi mieć postać RRRR-MM-DD, jest: ${day}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new Error(`Nie ma takiego dnia: ${day}`);
  }
  const wall = Date.UTC(y, mo - 1, d + 1, 0, 0, 0);
  const guess = new Date(wall - offsetMs(new Date(wall)));
  const exact = new Date(wall - offsetMs(guess));
  return exact.toISOString();
}

const COMPACT = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/**
 * Chwila UTC dla daty `yyyyMMddhhmmss` podanej w czasie polskim - tak Multiinfo
 * datuje wiadomości przychodzące. Dwa przebiegi, jak w `endOfWarsawDay`.
 */
export function warsawCompactToIso(compact: string): string {
  const m = COMPACT.exec(compact.trim());
  if (!m) throw new Error(`Data musi mieć postać yyyyMMddhhmmss, jest: ${compact}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const guess = new Date(wall - offsetMs(new Date(wall)));
  return new Date(wall - offsetMs(guess)).toISOString();
}

const two = (n: number) => String(n).padStart(2, '0');

/** Chwila z bazy (UTC) jako czas ścienny w Polsce: `RRRR-MM-DD GG:MM:SS`. */
export function warsawStamp(iso: string): string {
  const p = warsawParts(new Date(iso));
  return `${p.y}-${two(p.m)}-${two(p.d)} ${two(p.h)}:${two(p.min)}:${two(p.s)}`;
}

/** Dzień w Polsce dla chwili z bazy. */
export function warsawDay(iso: string): string {
  const p = warsawParts(new Date(iso));
  return `${p.y}-${two(p.m)}-${two(p.d)}`;
}

/** Ostatni dzień ważności (w czasie polskim) dla chwili wygaśnięcia z `endOfWarsawDay`. */
export function lastValidDay(iso: string): string {
  return warsawDay(new Date(Date.parse(iso) - 1).toISOString());
}

/** Sama godzina w Polsce: `GG:MM:SS` - do list, gdzie dzień wynika z kontekstu. */
export function warsawTime(iso: string): string {
  const p = warsawParts(new Date(iso));
  return `${two(p.h)}:${two(p.min)}:${two(p.s)}`;
}

/** Godzina w Polsce z milisekundami: `GG:MM:SS.mmm` - do śladu protokołu. */
export function warsawTimeMs(iso: string): string {
  const ms = new Date(iso).getUTCMilliseconds();
  return `${warsawTime(iso)}.${String(ms).padStart(3, '0')}`;
}
