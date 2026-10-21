import { describe, expect, it } from 'vitest';
import { FieldError, REGEX_TIMEOUT_MS, extractFields } from '../../../src/integrations/mail/fields.ts';

const UPS = 'Device: UPS-01\nStatus: ON BATTERY\nError code: E042 (battery)\nRuntime: 12 min';

describe('extractFields', () => {
  it('tekst po X do końca linii oraz do Y', () => {
    expect(extractFields(UPS, [
      { name: 'urzadzenie', mode: 'between', after: 'Device:' },
      { name: 'kod', mode: 'between', after: 'Error code:', until: '(' },
    ])).toEqual({ urzadzenie: 'UPS-01', kod: 'E042' });
  });

  it('brak frazy daje pustą wartość, nie błąd; porównanie bez wielkości liter', () => {
    expect(extractFields(UPS, [{ name: 'brak', mode: 'between', after: 'Nie ma' }, { name: 'stan', mode: 'between', after: 'status:' }])).toEqual({ brak: '', stan: 'ON BATTERY' });
  });

  it('fraza końcowa, której nie ma, kończy na końcu linii; fraza końcowa w dalszej linii nie sięga poza linię', () => {
    expect(extractFields(UPS, [{ name: 'stan', mode: 'between', after: 'Status:', until: ']' }])).toEqual({ stan: 'ON BATTERY' });
    expect(extractFields(UPS, [{ name: 'stan', mode: 'between', after: 'Status:', until: 'Runtime' }])).toEqual({ stan: 'ON BATTERY' });
  });

  it('wyrażenie regularne: pierwsza grupa albo całe dopasowanie, flagi i oraz m', () => {
    expect(extractFields(UPS, [
      { name: 'kod', mode: 'regex', pattern: 'code: (E\\d+)' },
      { name: 'linia', mode: 'regex', pattern: '^runtime.*$', flags: 'im' },
      { name: 'brak', mode: 'regex', pattern: 'xyz' },
    ])).toEqual({ kod: 'E042', linia: 'Runtime: 12 min', brak: '' });
  });

  it('wyrażenie, które się nie kończy, przerywa po limicie czasu błędem FieldError', () => {
    const evil = { name: 'x', mode: 'regex' as const, pattern: '(a+)+$' };
    const started = Date.now();
    expect(() => extractFields(`${'a'.repeat(40)}!`, [evil])).toThrow(FieldError);
    expect(Date.now() - started).toBeLessThan(REGEX_TIMEOUT_MS * 20);
    try { extractFields(`${'a'.repeat(40)}!`, [evil]); } catch (e) { expect((e as FieldError).field).toBe('x'); expect((e as Error).message).toBe('Wyrażenie pola x przekroczyło 50 ms.'); }
  });

  it('nieprawidłowy wzorzec to FieldError z nazwą pola', () => {
    expect(() => extractFields(UPS, [{ name: 'zly', mode: 'regex', pattern: '(' }])).toThrow(FieldError);
  });

  it('wynik nie zawiera pól spoza listy ani prototypu', () => {
    const out = extractFields(UPS, [{ name: 'constructor', mode: 'between', after: 'Device:' }]);
    expect(Object.keys(out)).toEqual(['constructor']);
    expect(out.constructor).toBe('UPS-01');
  });
});
