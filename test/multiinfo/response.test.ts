import { describe, expect, it } from 'vitest';
import { classifyCode, parsePackageFullInfo, parseResponse } from '../../src/multiinfo/response.ts';

describe('parseResponse', () => {
  it('czyta odpowiedź powodzenia z jednym identyfikatorem', () => {
    expect(parseResponse('0\n33')).toEqual({ ok: true, lines: ['33'] });
  });

  it('czyta odpowiedź powodzenia z wieloma identyfikatorami', () => {
    expect(parseResponse('0\n8841207\n8841208')).toEqual({ ok: true, lines: ['8841207', '8841208'] });
  });

  it('radzi sobie z zakończeniami linii w stylu Windows', () => {
    expect(parseResponse('0\r\n33\r\n')).toEqual({ ok: true, lines: ['33'] });
  });

  it('czyta odpowiedź błędu wraz z opisem', () => {
    expect(parseResponse('-24\nUsługa o podanym identyfikatorze nie jest aktywna'))
      .toEqual({ ok: false, code: -24, message: 'Usługa o podanym identyfikatorze nie jest aktywna' });
  });

  it('radzi sobie z błędem bez opisu', () => {
    expect(parseResponse('-80')).toEqual({ ok: false, code: -80, message: '' });
  });

  it('zachowuje puste linie w środku odpowiedzi infosms', () => {
    // Wiersz 14 przykładu z dokumentacji, nadawca, bywa pusty.
    const body = '0\n33\n1\nala\n0\n0\n2\n1\n-1\n0\n030706085937\n010101000000\nFalse\n\n48601357368\n21\n0\n2006-03-07 12:47:21';
    const parsed = parseResponse(body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // Przykład z dokumentacji ma osiemnaście linii razem z kodem statusu,
      // który parser odcina, więc danych zostaje siedemnaście.
      expect(parsed.lines).toHaveLength(17);
      expect(parsed.lines[12]).toBe('');
      expect(parsed.lines[14]).toBe('21');
    }
  });

  it('odrzuca odpowiedź, której pierwsza linia nie jest liczbą', () => {
    expect(() => parseResponse('<html>Service Unavailable</html>')).toThrow(/nieoczekiwany kszta/);
  });
});

describe('classifyCode', () => {
  it('uznaje awarie systemu za przejściowe', () => {
    for (const code of [-10, -15, -71]) expect(classifyCode(code), String(code)).toBe('transient');
  });

  it('uznaje błędy żądania za trwałe', () => {
    for (const code of [-1, -2, -12, -14, -21, -22, -23, -24, -31, -41, -61, -62, -63]) {
      expect(classifyCode(code), String(code)).toBe('permanent');
    }
  });

  it('wydziela błędy certyfikatu do osobnej kategorii', () => {
    for (const code of [-80, -81, -82, -83, -84, -85, -86]) {
      expect(classifyCode(code), String(code)).toBe('certificate');
    }
  });

  it('nieznany kod traktuje jako trwały', () => {
    expect(classifyCode(-999)).toBe('permanent');
  });
});

describe('parsePackageFullInfo', () => {
  it('czyta odpowiedź z linią statusu - taką zwraca prawdziwe Multiinfo', () => {
    // Zarejestrowana 2026-08-26 na api2 dla rozsyłki 28154463: status, rozsyłka, raport, etap, minuty.
    expect(parsePackageFullInfo('0\r\n28154463\n7506\n2\n58'))
      .toEqual({ ok: true, packageId: '28154463', reportId: '7506', generation: 2, minutesLeft: 58 });
  });

  it('rozpoznaje powodzenie po dodatniej pierwszej linii', () => {
    expect(parsePackageFullInfo('5\n123\n2\n30\n'))
      .toEqual({ ok: true, packageId: '5', reportId: '123', generation: 2, minutesLeft: 30 });
  });

  it('rozpoznaje błąd po ujemnej pierwszej linii', () => {
    expect(parsePackageFullInfo('-62\nBrak rozsyłki')).toEqual({ ok: false, code: -62, message: 'Brak rozsyłki' });
  });

  it('sprowadza nieznany etap generowania do „błąd”', () => {
    expect(parsePackageFullInfo('5\n123\n9\n')).toMatchObject({ ok: true, generation: 3, minutesLeft: 0 });
  });

  it('odrzuca odpowiedź bez liczby w pierwszej linii', () => {
    expect(() => parsePackageFullInfo('<html>')).toThrow(/nieoczekiwany kształt/);
  });
});
