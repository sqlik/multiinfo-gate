import { toGsm } from '../templates.ts';

/** Postać do porównania prefiksu: polskie znaki sprowadzone do łacińskich, małe litery. „Żłobek” i „zlobek” to ten sam prefiks. */
export const foldText = (text: string): string => toGsm(text).toLowerCase();

export type PrefixMatch = { ok: true; body: string } | { ok: false; reason: 'no_prefix' | 'empty' };

/**
 * Dopasowanie prefiksu do treści SMS-a. Białe znaki z początku są zdjęte, porównanie idzie po
 * `foldText`, a bezpośrednio po prefiksie musi stać koniec tekstu, biały znak albo dwukropek:
 * „serwisant awaria” nie uruchamia grupy „serwis”. Pusty prefiks przepuszcza każdą treść.
 * Treść wraca z oryginalnymi znakami i wielkością liter, bez dwukropka i białych znaków po prefiksie.
 */
export function matchPrefix(text: string, prefix: string): PrefixMatch {
  const trimmed = text.replace(/^\s+/, '');
  if (prefix === '') {
    const body = trimmed.trim();
    return body === '' ? { ok: false, reason: 'empty' } : { ok: true, body };
  }
  const candidate = trimmed.slice(0, prefix.length);
  if (foldText(candidate) !== foldText(prefix)) return { ok: false, reason: 'no_prefix' };
  const rest = trimmed.slice(prefix.length);
  if (rest !== '' && !/^[\s:]/.test(rest)) return { ok: false, reason: 'no_prefix' };
  const body = rest.replace(/^\s*:?/, '').trim();
  return body === '' ? { ok: false, reason: 'empty' } : { ok: true, body };
}
