import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanText, nameTokens } from '../../../src/integrations/mail/clean.ts';
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

  const STOPKA = 'To jest test wysyłki Email2SMS\n\nJan Kowalski\nSpecjalista ds. IT\nDział Wsparcia Technicznego\n\nPrzyklad Sp. z o.o.\ntel. +48 601000999';

  it('podpis od linii z nazwą nadawcy, także w innej kolejności, z przecinkiem i z dopiskiem w nawiasie', () => {
    for (const name of ['Jan Kowalski', 'Kowalski Jan', 'Kowalski, Jan', 'Jan Kowalski (Przyklad)', 'JAN KOWALSKI']) {
      expect(cleanText(STOPKA, [], name)).toBe('To jest test wysyłki Email2SMS');
    }
  });

  it('linia z nazwą nadawcy liczy się tylko po pustej linii, nie jako pierwsza linia ani pole formularza', () => {
    expect(cleanText('Centrala Alarmowa\nStrefa 3: naruszenie', [], 'Centrala Alarmowa')).toBe('Centrala Alarmowa\nStrefa 3: naruszenie');
    expect(cleanText('Zgłaszający:\nJan Kowalski\nOpis: brak zasilania', [], 'Jan Kowalski')).toBe('Zgłaszający:\nJan Kowalski\nOpis: brak zasilania');
    expect(cleanText('Brak zasilania\n\nJan Kowalski\nSpecjalista', [], 'Jan Kowalski')).toBe('Brak zasilania');
  });

  it('podpis telefonu tylko w krótkiej linii; słaby zwrot rejestrowy tylko ze znacznikiem firmy', () => {
    expect(cleanText('Wysłano z aplikacji Kamery: ruch w strefie 2 przy bramie wjazdowej\nSprawdzić', [])).toBe('Wysłano z aplikacji Kamery: ruch w strefie 2 przy bramie wjazdowej\nSprawdzić');
    expect(cleanText('Sąd Rejonowy wyznaczył termin na 12 listopada\nProszę o obecność', [])).toBe('Sąd Rejonowy wyznaczył termin na 12 listopada\nProszę o obecność');
    expect(cleanText('Kapitał zakładowy do podniesienia na walnym\nProszę o decyzję', [])).toBe('Kapitał zakładowy do podniesienia na walnym\nProszę o decyzję');
    expect(cleanText('Treść\nSąd Rejonowy dla m.st. Warszawy, KRS 0000000000', [])).toBe('Treść');
    expect(cleanText('Treść\nPrzyklad S.A., kapitał zakładowy 5 000 000 zł', [])).toBe('Treść');
  });

  it('nazwa nadawcy pusta albo jednowyrazowa nie ucina', () => {
    expect(cleanText(STOPKA, [], '')).toBe(STOPKA);
    expect(cleanText(STOPKA, [], 'Kowalski')).toBe(STOPKA);
    expect(cleanText('Biuro\nzamknięte jutro', [], 'Biuro')).toBe('Biuro\nzamknięte jutro');
  });

  it('linia [cid:...] znika z treści, a reszta zostaje', () => {
    expect(cleanText('Awaria\n[cid:image001.png@01DA0000.11111111]\nProszę o kontakt', [])).toBe('Awaria\nProszę o kontakt');
    expect(cleanText('Awaria\n\n[cid:obraz.png]\n\nProszę o kontakt', [])).toBe('Awaria\n\nProszę o kontakt');
  });

  it('klauzula rejestrowa ucina niezależnie od nazwy nadawcy, także w środku zdania treści', () => {
    const legal = 'Przyklad sp. z o.o. z siedzibą w Warszawie, 00-001 Warszawa, ul. Przykładowa 1, zarejestrowana w rejestrze przedsiębiorców';
    expect(cleanText(`Treść\n\n${legal}\nKRS 0000000000`, [], '')).toBe('Treść');
    expect(cleanText('Treść\nPrzyklad sp. z o.o., Sąd Rejonowy dla m.st. Warszawy, kapitał zakładowy 5 000 000 zł', [])).toBe('Treść');
    expect(cleanText('Treść\nRegistered office: 1 Main St', [])).toBe('Treść');
    // Ograniczenie reguły: zdanie treści ze zwrotem rejestrowym też kończy treść.
    expect(cleanText('Zamówienie\nFirma z siedzibą w Warszawie zamawia 3 sztuki', [])).toBe('Zamówienie');
  });

  it('podpisy telefonów i Outlooka kończą treść', () => {
    expect(cleanText('Jadę\nWysłane z iPhone’a', [])).toBe('Jadę');
    expect(cleanText('Jadę\nSent from my Galaxy', [])).toBe('Jadę');
    expect(cleanText('Zamów\nGet Outlook for iOS', [])).toBe('Zamów');
    expect(cleanText('Zamów\nPobierz aplikację Outlook dla systemu Android', [])).toBe('Zamów');
    expect(cleanText('Wysłane z magazynu wczoraj\nProszę potwierdzić', [])).toBe('Wysłane z magazynu wczoraj\nProszę potwierdzić');
  });

  it('mail będący samą nazwą nadawcy daje pustą treść', () => {
    expect(cleanText('Jan Kowalski', [], 'Jan Kowalski')).toBe('');
  });

  it('nameTokens: małe litery, bez przecinków i nawiasów; nazwa i linia dłuższe niż 200 znaków nie są porównywane', () => {
    expect(nameTokens('Kowalski, Jan (Przyklad)')).toEqual(['kowalski', 'jan']);
    expect(nameTokens('')).toEqual([]);
    expect(nameTokens('('.repeat(300_000))).toEqual([]);
    const started = Date.now();
    expect(cleanText(`Treść\n${'('.repeat(300_000)}`, [], 'Jan Kowalski')).toBe(`Treść\n${'('.repeat(300_000)}`);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('mail z samym podpisem daje pustą treść', () => {
    expect(cleanText('Pozdrawiam\nJan', [])).toBe('');
    expect(cleanText('', [])).toBe('');
  });
});
