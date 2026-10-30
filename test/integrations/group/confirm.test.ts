import { describe, expect, it } from 'vitest';
import { confirmText } from '../../../src/integrations/group/confirm.ts';

describe('confirmText', () => {
  it.each([[1, 'Wysłano do 1 odbiorcy'], [2, 'Wysłano do 2 odbiorców'], [5, 'Wysłano do 5 odbiorców'], [22, 'Wysłano do 22 odbiorców'], [500, 'Wysłano do 500 odbiorców']])('%i', (n, text) => expect(confirmText({ kind: 'sent', recipients: n })).toBe(text));
  it('długość i błąd bramki', () => {
    expect(confirmText({ kind: 'too_many_parts', maxParts: 2 })).toBe('Nie wysłano: wiadomość wymaga więcej niż 2 części');
    expect(confirmText({ kind: 'too_many_parts', maxParts: 1 })).toBe('Nie wysłano: wiadomość wymaga więcej niż 1 części');
    expect(confirmText({ kind: 'service' })).toBe('Nie wysłano: błąd bramki, administrator został powiadomiony');
  });
  it('każdy tekst mieści się w jednej części UCS-2', () => {
    for (const e of [{ kind: 'sent', recipients: 500 }, { kind: 'too_many_parts', maxParts: 9 }, { kind: 'service' }] as const) expect([...confirmText(e)].length).toBeLessThanOrEqual(70);
  });
});
