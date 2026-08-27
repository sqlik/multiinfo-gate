export class InvalidPhoneError extends Error {
  constructor(raw: string, reason?: string) {
    super(`Numer odbiorcy jest nieprawidłowy: ${raw}${reason ? ` (${reason})` : ''}`);
    this.name = 'InvalidPhoneError';
  }
}

/**
 * Liczba cyfr numeru krajowego dla kodów kraju o stałej długości numeracji. Dla pozostałych
 * kodów obowiązuje tylko ogólny zakres 11-15 cyfr, bo bez pełnej tabeli numeracji nie ma
 * czego pilnować.
 */
const NATIONAL_LENGTH: Record<string, number> = { '48': 9 };

export class InvalidOrigError extends Error {
  constructor(orig: string) {
    super(
      `Nadpis nadawcy jest nieprawidłowy: ${orig}. ` +
      'Najwyżej 11 znaków drukowalnych; o dopuszczalnych wartościach decyduje Multiinfo.',
    );
    this.name = 'InvalidOrigError';
  }
}

/**
 * Sprowadza numer do postaci oczekiwanej przez Multiinfo: same cyfry z kodem kraju.
 * Numer dziewięciocyfrowy jest uzupełniany domyślnym kodem kraju konta.
 */
export function normalizePhone(raw: string, defaultCountryCode: string): string {
  const stripped = raw.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(stripped)) throw new InvalidPhoneError(raw);

  const withCode = stripped.length === 9 ? `${defaultCountryCode}${stripped}` : stripped;
  if (withCode.length < 11 || withCode.length > 15) throw new InvalidPhoneError(raw);

  for (const [code, nationalLength] of Object.entries(NATIONAL_LENGTH)) {
    if (!withCode.startsWith(code)) continue;
    if (withCode.length === code.length + nationalLength) break;
    const doubled = code + code;
    if (withCode.startsWith(doubled) && withCode.length === doubled.length + nationalLength) {
      throw new InvalidPhoneError(raw, `kod kraju ${code} podwojony; właściwy numer to zapewne ${withCode.slice(code.length)}`);
    }
    throw new InvalidPhoneError(raw, `numer z kodem ${code} ma ${code.length + nationalLength} cyfr`);
  }
  return withCode;
}

/**
 * Nadpis nadawcy: najwyżej 11 znaków (limit nadawcy alfanumerycznego w GSM), bez znaków
 * sterujących. Dokumentacja Multiinfo nie ogranicza zestawu znaków - nadpisy takie jak
 * „VPBX 2.0” są u operatora poprawne - a właściwym filtrem jest słownik konta.
 */
export function validateOrig(orig: string): void {
  if (orig.length === 0 || orig.length > 11) throw new InvalidOrigError(orig);
  if (/\p{C}/u.test(orig)) throw new InvalidOrigError(orig);
}
