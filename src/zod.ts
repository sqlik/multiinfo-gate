import { z } from 'zod';

/**
 * Komunikaty walidacji po polsku. Trafiają do odpowiedzi API, do dziennika integracji i do panelu,
 * więc czyta je autor przepływu albo administrator, a nie programista. Każdy moduł ze schematami
 * importuje `z` stąd, żeby mapa obowiązywała, zanim powstanie pierwszy schemat. Pola, przy których
 * ogólne zdanie nie wystarcza (numer, treść, lista odbiorców), mają własne komunikaty w schemacie.
 */

/** Liczba z rzeczownikiem w bierniku: 1 znak, 2 znaki, 5 znaków. */
function count(n: number, one: string, few: string, many: string): string {
  if (n === 1) return `1 ${one}`;
  const last = n % 10;
  const tens = n % 100;
  return `${n} ${last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? few : many}`;
}

const TYPE: Record<string, string> = {
  string: 'Wartość musi być tekstem.',
  number: 'Wartość musi być liczbą.',
  int: 'Wartość musi być liczbą całkowitą.',
  boolean: 'Wartość musi być równa true albo false.',
  array: 'Wartość musi być listą.',
  object: 'Wartość musi być obiektem JSON.',
};

interface Issue {
  code?: string; input?: unknown; expected?: string; origin?: string; format?: string;
  minimum?: number | bigint; maximum?: number | bigint; values?: unknown[];
}

export function polishMessage(issue: Issue): string | undefined {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) return 'Pole jest wymagane.';
      return TYPE[issue.expected ?? ''] ?? 'Wartość ma nieprawidłowy typ.';
    case 'invalid_union':
      return issue.input === undefined ? 'Pole jest wymagane.' : 'Wartość ma nieprawidłowy typ.';
    case 'too_small': {
      const n = Number(issue.minimum);
      if (issue.origin === 'string') return n === 1 ? 'Pole nie może być puste.' : `Wartość musi mieć co najmniej ${count(n, 'znak', 'znaki', 'znaków')}.`;
      if (issue.origin === 'array') return n === 1 ? 'Lista nie może być pusta.' : `Lista musi zawierać co najmniej ${count(n, 'pozycję', 'pozycje', 'pozycji')}.`;
      return `Wartość musi wynosić co najmniej ${n}.`;
    }
    case 'too_big': {
      const n = Number(issue.maximum);
      if (issue.origin === 'string') return `Wartość może mieć najwyżej ${count(n, 'znak', 'znaki', 'znaków')}.`;
      if (issue.origin === 'array') return `Lista może zawierać najwyżej ${count(n, 'pozycję', 'pozycje', 'pozycji')}.`;
      return `Wartość może wynosić najwyżej ${n}.`;
    }
    case 'invalid_format':
      if (issue.format === 'datetime') return 'Wartość musi być datą i godziną w formacie ISO 8601, na przykład 2026-11-04T08:00:00Z.';
      return 'Wartość ma nieprawidłową postać.';
    case 'invalid_value':
      return `Dozwolone wartości: ${(issue.values ?? []).map(String).join(', ')}.`;
    default:
      return undefined;
  }
}

z.config({ customError: (issue) => polishMessage(issue as Issue) });

export { z };

/**
 * Zdanie błędu walidacji do panelu. Komunikat `ZodError` jest tekstem JSON z listą problemów, dlatego
 * formularz pokazuje zdanie pierwszego problemu, a nie pierwszy wiersz tego tekstu.
 */
export function validationMessage(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues[0]?.message ?? 'nieprawidłowa konfiguracja';
  return e instanceof Error ? e.message.split('\n')[0]! : String(e);
}
