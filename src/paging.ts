// Stronicowanie list w API i w panelu.

/**
 * Przesunięcie z parametru `offset`: liczba całkowita od 0. Wartość ponad zakres bezpiecznych liczb
 * całkowitych zostaje przycięta, ponieważ SQLite odrzuca ją błędem, a strona po takim przesunięciu
 * i tak jest pusta.
 */
export function parseOffset(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '0', 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}
