import vm from 'node:vm';
import type { MailField } from '../config.ts';

/** Limit czasu jednego dopasowania wyrażenia regularnego; wzorzec administratora pracuje na treści od obcych. */
export const REGEX_TIMEOUT_MS = 50;

export class FieldError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = 'FieldError';
  }
}

/** Tekst po `after` do `until` albo do końca linii, bez wielkości liter, przycięty. Brak `after` daje pustą wartość. */
function between(text: string, after: string, until: string | undefined): string {
  const lowerText = text.toLocaleLowerCase('pl');
  const start = lowerText.indexOf(after.toLocaleLowerCase('pl'));
  if (start < 0) return '';
  const from = start + after.length;
  const lineEnd = text.indexOf('\n', from);
  const end = lineEnd < 0 ? text.length : lineEnd;
  let stop = end;
  if (until !== undefined) {
    const u = lowerText.indexOf(until.toLocaleLowerCase('pl'), from);
    if (u >= 0 && u < end) stop = u;
  }
  return text.slice(from, stop).trim();
}

/**
 * Dopasowanie w osobnym kontekście `vm` z limitem czasu: to jedyny sposób na przerwanie
 * synchronicznego wyrażenia w Node. Pierwsza grupa albo całe dopasowanie; brak to pusta wartość.
 */
function regex(text: string, name: string, pattern: string, flags: string | undefined): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags ?? '');
  } catch (e) {
    throw new FieldError(name, `Wyrażenie pola ${name} jest nieprawidłowe: ${(e as Error).message}`);
  }
  let match: RegExpExecArray | null;
  try {
    match = vm.runInNewContext('re.exec(text)', { re, text }, { timeout: REGEX_TIMEOUT_MS }) as RegExpExecArray | null;
  } catch {
    throw new FieldError(name, `Wyrażenie pola ${name} przekroczyło ${REGEX_TIMEOUT_MS} ms.`);
  }
  if (!match) return '';
  return (match[1] ?? match[0] ?? '').trim();
}

/** Wycinki z treści maila pod nazwami pól; wynik bez prototypu, bo nazwy pochodzą od administratora. */
export function extractFields(text: string, fields: MailField[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const f of fields) {
    out[f.name] = f.mode === 'between' ? between(text, f.after, f.until) : regex(text, f.name, f.pattern, f.flags);
  }
  return out;
}
