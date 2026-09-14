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
/** Sam zapis numeru bez ozdobników: spacje, myślniki, nawiasy, kropki i wiodący plus. */
export const stripPhone = (raw: string): string => raw.trim().replace(/[\s\-().]/g, '').replace(/^\+/, '');

export function normalizePhone(raw: string, defaultCountryCode: string): string {
  const stripped = stripPhone(raw);
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
 * Numer nadawcy wiadomości przychodzącej w postaci bramki; numer krótki albo nietypowy zostaje
 * taki, jak podał Plus. Tej samej postaci używa filtr nadawcy w API i w panelu.
 */
export function normalizeSender(raw: string, countryCode: string): string {
  try {
    return normalizePhone(raw, countryCode);
  } catch {
    return stripPhone(raw);
  }
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

export const MAX_RECIPIENTS_PER_HOOK = 50;

export class TooManyRecipientsError extends Error {
  constructor(count: number) {
    super(`Za dużo odbiorców: ${count}; jedno żądanie może wskazać najwyżej ${MAX_RECIPIENTS_PER_HOOK}.`);
    this.name = 'TooManyRecipientsError';
  }
}

/**
 * Numer z ładunku obcej aplikacji: to samo co `normalizePhone`, ale z dwoma zapisami, których
 * programista API by nie użył, a które w sklepach i CRM-ach są codziennością. Międzynarodowy
 * przedrostek `00` zastępuje plusa, a wiodące zero to krajowy prefiks międzymiastowy, którym
 * kupujący wpisuje numer w formularzu zamówienia („0601 000 001”).
 */
export function normalizeRecipient(raw: string, countryCode: string): string {
  const stripped = stripPhone(raw);
  if (stripped.startsWith('00')) return normalizePhone(stripped.slice(2), countryCode);
  return normalizePhone(withoutTrunkPrefix(stripped, countryCode), countryCode);
}

/**
 * Zdejmuje wiodące zero tylko wtedy, gdy reszta jest numerem krajowym właściwej długości dla
 * kodu kraju konta. Bez znanej długości numeracji zero zostaje: równie dobrze może być cyfrą
 * numeru zagranicznego, a zgadywanie kończyłoby się SMS-em pod cudzy numer.
 */
function withoutTrunkPrefix(stripped: string, countryCode: string): string {
  const nationalLength = NATIONAL_LENGTH[countryCode];
  if (nationalLength === undefined) return stripped;
  if (!stripped.startsWith('0') || stripped.length !== nationalLength + 1) return stripped;
  return stripped.slice(1);
}

/** Lista odbiorców z pola ładunku: tablica, liczba albo tekst rozdzielony przecinkami lub średnikami. */
export function splitRecipients(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value
    : typeof value === 'string' ? value.split(/[,;]/)
    : typeof value === 'number' ? [String(value)]
    : [];
  const out = items.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
    .map((x) => String(x).trim()).filter((x) => x !== '');
  if (out.length > MAX_RECIPIENTS_PER_HOOK) throw new TooManyRecipientsError(out.length);
  return out;
}
