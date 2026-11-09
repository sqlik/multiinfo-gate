import { describe, expect, it } from 'vitest';
import { validationMessage, z } from '../src/zod.ts';

describe('validationMessage', () => {
  it('błąd schematu daje zdanie pierwszego problemu zamiast tekstu JSON', () => {
    const schema = z.object({ phone: z.string().regex(/^\d{11,15}$/, 'numer nieznormalizowany'), name: z.string().max(3) });
    let error: unknown;
    try { schema.parse({ phone: '+48 601', name: 'Marek' }); } catch (e) { error = e; }
    expect(validationMessage(error)).toBe('numer nieznormalizowany');
    expect(validationMessage(error)).not.toContain('[');
  });
  it('zwykły błąd daje pierwszy wiersz, a inna wartość jej tekst', () => {
    expect(validationMessage(new Error('pierwszy\ndrugi'))).toBe('pierwszy');
    expect(validationMessage('tekst')).toBe('tekst');
  });
});
