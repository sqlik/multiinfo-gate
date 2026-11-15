/** Forma liczebnika: 1 rozsyłka, 2 rozsyłki, 5 rozsyłek. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return `${n} ${one}`;
  const tens = n % 100;
  return n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14) ? `${n} ${few}` : `${n} ${many}`;
}
