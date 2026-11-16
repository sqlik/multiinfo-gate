/** Liczba w zapisie polskim jak w dokumentacji: 50 000 z twardą spacją, a liczby czterocyfrowe bez odstępu, na przykład 5000. */
export function formatCount(n: number): string {
  return n.toLocaleString('pl-PL');
}

/** Komunikat formularza panelu o liczbie spoza zakresu. */
export function rangeError(what: string, min: number, max: number): string {
  return `${what}: podaj liczbę od ${formatCount(min)} do ${formatCount(max)}.`;
}
