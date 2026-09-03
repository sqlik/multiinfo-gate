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
