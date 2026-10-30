export type ConfirmEvent = { kind: 'sent'; recipients: number } | { kind: 'too_many_parts'; maxParts: number } | { kind: 'service' };

/** Odmiana: „1 odbiorcy” w dopełniaczu liczby pojedynczej, od 2 w górę „odbiorców”. */
const recipientsWord = (n: number): string => (n === 1 ? 'odbiorcy' : 'odbiorców');

/** Treść potwierdzenia do nadawcy (spec 5): stała, z diakrytykami, zawsze krótsza niż 70 znaków, więc jedna część. */
export function confirmText(e: ConfirmEvent): string {
  if (e.kind === 'sent') return `Wysłano do ${e.recipients} ${recipientsWord(e.recipients)}`;
  if (e.kind === 'too_many_parts') return `Nie wysłano: wiadomość wymaga więcej niż ${e.maxParts} części`;
  return 'Nie wysłano: błąd bramki, administrator został powiadomiony';
}
