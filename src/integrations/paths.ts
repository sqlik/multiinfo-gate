export class InvalidPathError extends Error {
  constructor(path: string, reason: string) {
    super(`Ścieżka „${path}” jest nieprawidłowa: ${reason}`);
    this.name = 'InvalidPathError';
  }
}

const SEGMENT = /^([^.[\]]+)((?:\[\d+\])*)$/;

/**
 * Własny, prosty zapis `a.b[0].c` - bez wyrażeń, bez filtrów, bez wieloznaczników. Wszystko,
 * co ma logikę, idzie przez szablon Liquid; ścieżka ma tylko wskazać pole w ładunku.
 */
export function parsePath(path: string): Array<string | number> {
  if (path === '') throw new InvalidPathError(path, 'pusta');
  const out: Array<string | number> = [];
  for (const raw of path.split('.')) {
    const m = SEGMENT.exec(raw);
    if (!m) throw new InvalidPathError(path, `człon „${raw}”`);
    out.push(m[1]!);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

export function isValidPath(path: string): boolean {
  try {
    parsePath(path);
    return true;
  } catch {
    return false;
  }
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** Wartość spod ścieżki albo `undefined`; ładunek z obcej aplikacji nie może niczego wysadzić. */
export function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const seg of parsePath(path)) {
    if (current === null || typeof current !== 'object') return undefined;
    if (typeof seg === 'string' && FORBIDDEN.has(seg)) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[seg];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, seg)) return undefined;
      current = (current as Record<string, unknown>)[seg];
    }
  }
  return current;
}

/** Znacznik w miejscu sekretu; nazwa pola zostaje, bo pomaga administratorowi, wartość znika. */
export const SEKRET_ZASTEPCZY = '(sekret)';

/**
 * Kopia ładunku z wartością spod ścieżki zamienioną na znacznik. Klonujemy tylko człony leżące
 * na ścieżce, reszta idzie przez referencję: ładunek bywa duży, a zmieniamy w nim jedno pole.
 * Ścieżka nie do odczytania albo pole, którego nie ma, zwracają ładunek bez zmian.
 */
export function maskPath(value: unknown, path: string): unknown {
  let segments: Array<string | number>;
  try {
    segments = parsePath(path);
  } catch {
    return value;
  }
  const mask = (current: unknown, i: number): unknown => {
    if (current === null || typeof current !== 'object') return current;
    const seg = segments[i]!;
    const last = i === segments.length - 1;
    if (typeof seg === 'number') {
      if (!Array.isArray(current) || seg >= current.length) return current;
      const copy = [...current];
      copy[seg] = last ? SEKRET_ZASTEPCZY : mask(current[seg], i + 1);
      return copy;
    }
    if (FORBIDDEN.has(seg) || Array.isArray(current)) return current;
    if (!Object.prototype.hasOwnProperty.call(current, seg)) return current;
    const copy = { ...(current as Record<string, unknown>) };
    // Przez `defineProperty`, bo ładunek z obcej aplikacji może nieść własne pole o nazwie
    // przykrywającej zapis wprost.
    Object.defineProperty(copy, seg, { value: last ? SEKRET_ZASTEPCZY : mask(copy[seg], i + 1), enumerable: true, writable: true, configurable: true });
    return copy;
  };
  return mask(value, 0);
}
