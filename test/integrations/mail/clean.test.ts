import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanText } from '../../../src/integrations/mail/clean.ts';
import { parseMail } from '../../../src/integrations/mail/parse.ts';

const read = (name: string) => readFileSync(new URL(`../../fixtures/mail/${name}`, import.meta.url));
const body = async (name: string) => (await parseMail(read(name))).textFull;

describe('cleanText', () => {
  it.each(['outlook-cytat.eml', 'gmail-cytat.eml', 'thunderbird-cytat.eml', 'telefon-cytat.eml'])('%s: zostaje odpowiedź, cytat znika', async (name) => {
    const text = cleanText(await body(name), []);
    expect(text).toContain('Potwierdzam przerwę');
    expect(text).not.toContain('napisał');
    expect(text).not.toContain('wrote');
    expect(text).not.toContain('Original Message');
    expect(text).not.toMatch(/^>/m);
    expect(text).not.toContain('pisze:');
    expect(text).not.toContain('Serwer plików');
  });

  it('blok Od/Wysłano Outlooka jest cytatem, a samo „Od:” w zwykłym zdaniu nie', () => {
    expect(cleanText('Odpowiedź\n\nOd: Anna\nWysłano: wczoraj\nDo: Jan\nTemat: x\n\nstare', [])).toBe('Odpowiedź');
    expect(cleanText('Od: jutro nie działa VPN\nProszę o zgłoszenie.', [])).toBe('Od: jutro nie działa VPN\nProszę o zgłoszenie.');
  });

  it('ucina podpis i stopkę od zwrotu zamykającego albo separatora', async () => {
    const text = cleanText(await body('stopka-firmowa.eml'), []);
    expect(text).toContain('trzecie zdanie');
    expect(text).not.toContain('Pozdrawiam');
    expect(text).not.toContain('Niniejsza wiadomość');
    expect(text).not.toContain('Przyklad Sp.');
  });

  it('separator podpisu i klauzula prawna ucinają bez zwrotu zamykającego', () => {
    expect(cleanText('Treść\n-- \nJan', [])).toBe('Treść');
    expect(cleanText('Treść\nThis e-mail and any attachments are confidential.', [])).toBe('Treść');
    expect(cleanText('Treść\nAdministratorem danych jest X', [])).toBe('Treść');
  });

  it('zwrot zamykający w długiej linii zostaje', () => {
    expect(cleanText('Dziękuję za zgłoszenie, jutro przerwa serwisowa od 8:00 do 10:00.\n', [])).toBe('Dziękuję za zgłoszenie, jutro przerwa serwisowa od 8:00 do 10:00.');
  });

  it('zwroty angielskie i wielkość liter', () => {
    expect(cleanText('Server down.\nBEST REGARDS,\nJohn', [])).toBe('Server down.');
    expect(cleanText('Server down.\nKind regards\nJohn', [])).toBe('Server down.');
  });

  it('fraza administratora ucina od początku linii bez wielkości liter', () => {
    expect(cleanText('Alarm UPS\nSTATUS: ON BATTERY\nWygenerowano automatycznie przez system\nKontakt: it@x', ['wygenerowano automatycznie'])).toBe('Alarm UPS\nSTATUS: ON BATTERY');
    expect(cleanText('Alarm UPS\nnie wygenerowano automatycznie\nKontakt', ['wygenerowano automatycznie'])).toBe('Alarm UPS\nnie wygenerowano automatycznie\nKontakt');
  });

  it('porządkuje białe znaki: spacje na końcach, puste linie z rzędu, krańce', () => {
    expect(cleanText('  \nA   \n\n\n\nB\n\n', [])).toBe('A\n\nB');
  });

  it('mail z samym podpisem daje pustą treść', () => {
    expect(cleanText('Pozdrawiam\nJan', [])).toBe('');
    expect(cleanText('', [])).toBe('');
  });
});
