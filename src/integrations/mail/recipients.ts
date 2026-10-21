import type { MailInConfig } from '../config.ts';

export type RecipientsWhere = MailInConfig['recipientsFromMail']['where'];

/** Kandydat na numer: opcjonalny plus, cyfry, spacje i myślniki; o poprawności decyduje normalizacja w potoku. */
export const PHONE_CANDIDATE = /^\+?[\d\s-]{9,20}$/;
const MIN_DIGITS = 9;
const MAX_DIGITS = 15;

const digits = (s: string): number => s.replace(/\D/g, '').length;

/**
 * Segment po przecinku albo średniku może zawierać kilka numerów rozdzielonych spacjami,
 * a jeden numer może być zapisany z odstępami (`601 000 002`). Kolejne grupy cyfr łączą się
 * w numer, dopóki numer ma mniej niż 9 cyfr; potem zaczyna się następny.
 */
function splitSegment(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter((t) => t !== '');
  const out: string[] = [];
  let current = '';
  for (const t of tokens) {
    if (current !== '' && digits(current) >= MIN_DIGITS) { out.push(current); current = t; } else current = current === '' ? t : `${current} ${t}`;
  }
  if (current !== '') out.push(current);
  return out;
}

/** Lista numerów z fragmentu tekstu albo null, gdy choć jeden element nie wygląda na numer. */
function numbersOf(fragment: string): string[] | null {
  const numbers = fragment.split(/[,;]/).flatMap(splitSegment);
  if (numbers.length === 0) return null;
  for (const n of numbers) {
    if (!PHONE_CANDIDATE.test(n)) return null;
    const d = digits(n);
    if (d < MIN_DIGITS || d > MAX_DIGITS) return null;
  }
  return numbers;
}

/**
 * Numery wskazane przez nadawcę: w temacie przed dwukropkiem albo w pierwszej niepustej linii
 * treści. Użyty fragment znika z tematu lub treści. Brak numerów zostawia oba pola bez zmian.
 */
export function pullRecipients(subject: string, text: string, where: RecipientsWhere): { numbers: string[]; subject: string; text: string } {
  if (where === 'subject') {
    const m = /^([^:]{9,400}):\s*(.*)$/s.exec(subject);
    const numbers = m ? numbersOf(m[1]!) : null;
    return numbers ? { numbers, subject: m![2]!.trim(), text } : { numbers: [], subject, text };
  }
  const lines = text.split('\n');
  const index = lines.findIndex((l) => l.trim() !== '');
  if (index < 0) return { numbers: [], subject, text };
  const numbers = numbersOf(lines[index]!);
  if (!numbers) return { numbers: [], subject, text };
  return { numbers, subject, text: lines.slice(index + 1).join('\n').replace(/^\n+/, '') };
}
