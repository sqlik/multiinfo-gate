import { describe, expect, it } from 'vitest';
import { InvalidOrigError, InvalidPhoneError, MAX_RECIPIENTS_PER_HOOK, normalizePhone, normalizeRecipient, splitRecipients, TooManyRecipientsError, validateOrig } from '../../src/text/phone.ts';

describe('normalizePhone', () => {
  it('przepuszcza numer z kodem kraju', () => {
    expect(normalizePhone('48601135134', '48')).toBe('48601135134');
  });

  it('usuwa spacje, myślniki i wiodący plus', () => {
    expect(normalizePhone('+48 601-135-134', '48')).toBe('48601135134');
  });

  it('dokleja domyślny kod kraju do numeru dziewięciocyfrowego', () => {
    expect(normalizePhone('601135134', '48')).toBe('48601135134');
  });

  it('odrzuca numer za krótki', () => {
    expect(() => normalizePhone('12345', '48')).toThrow(InvalidPhoneError);
  });

  it('odrzuca numer za długi', () => {
    expect(() => normalizePhone('4860113513412345', '48')).toThrow(InvalidPhoneError);
  });

  it('odrzuca numer z literami', () => {
    expect(() => normalizePhone('48601abc134', '48')).toThrow(InvalidPhoneError);
  });

  it('odrzuca numer polski o liczbie cyfr innej niż dziewięć po kodzie kraju', () => {
    expect(() => normalizePhone('4860113513', '48')).toThrow(InvalidPhoneError);
    expect(() => normalizePhone('486011351345', '48')).toThrow(InvalidPhoneError);
  });

  it('odrzuca podwojony kod kraju i podpowiada właściwy numer', () => {
    expect(() => normalizePhone('4848601130239', '48')).toThrow(InvalidPhoneError);
    expect(() => normalizePhone('4848601130239', '48')).toThrow('48601130239');
    expect(() => normalizePhone('+48 48 601 130 239', '48')).toThrow('podwojony');
  });

  it('przepuszcza numer zagraniczny o długości spoza reguły polskiej', () => {
    expect(normalizePhone('4915123456789', '48')).toBe('4915123456789');
    expect(normalizePhone('12025550123', '48')).toBe('12025550123');
  });

  it('stosuje regułę polską według kodu w numerze, nie kodu domyślnego konta', () => {
    expect(() => normalizePhone('486011351345', '49')).toThrow(InvalidPhoneError);
    expect(normalizePhone('48601135134', '49')).toBe('48601135134');
  });
});

describe('validateOrig', () => {
  it('przyjmuje nadpis do 11 znaków drukowalnych - także z kropką i podkreśleniem', () => {
    expect(() => validateOrig('Firma Info')).not.toThrow();
    expect(() => validateOrig('12345678901')).not.toThrow();
    expect(() => validateOrig('VPBX 2.0')).not.toThrow();
    expect(() => validateOrig('Firma_Info')).not.toThrow();
    expect(() => validateOrig('Firma-Info')).not.toThrow();
  });

  it('odrzuca nadpis dłuższy niż 11 znaków', () => {
    expect(() => validateOrig('Firma Informacje')).toThrow(InvalidOrigError);
  });

  it('odrzuca nadpis ze znakiem sterującym albo nowym wierszem', () => {
    expect(() => validateOrig('Firma\nInfo')).toThrow(InvalidOrigError);
    expect(() => validateOrig('Firma\u0007')).toThrow(InvalidOrigError);
  });

  it('odrzuca nadpis pusty', () => {
    expect(() => validateOrig('')).toThrow(InvalidOrigError);
  });
});

describe('normalizeRecipient', () => {
  it.each([
    ['+48 601 000 001', '48601000001'],
    ['601-000-001', '48601000001'],
    ['(48) 601.000.001', '48601000001'],
    ['0048601000001', '48601000001'],
    ['00 48 601 000 001', '48601000001'],
    ['48601000001', '48601000001'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeRecipient(raw, '48')).toBe(expected);
  });
  it('odrzuca litery i za krótkie', () => {
    expect(() => normalizeRecipient('jan@firma.pl', '48')).toThrow(InvalidPhoneError);
    expect(() => normalizeRecipient('12345', '48')).toThrow(InvalidPhoneError);
  });
});

describe('splitRecipients', () => {
  it('przyjmuje tekst z przecinkami i średnikami oraz tablice', () => {
    expect(splitRecipients('48601000001, 48601000002;48601000003')).toEqual(['48601000001', '48601000002', '48601000003']);
    expect(splitRecipients(['48601000001', '', ' 48601000002 '])).toEqual(['48601000001', '48601000002']);
    expect(splitRecipients(48601000001)).toEqual(['48601000001']);
  });
  it('pomija puste i nietekstowe', () => {
    expect(splitRecipients(undefined)).toEqual([]);
    expect(splitRecipients(null)).toEqual([]);
    expect(splitRecipients({ a: 1 })).toEqual([]);
  });
  it('odrzuca ponad limit', () => {
    const many = Array.from({ length: MAX_RECIPIENTS_PER_HOOK + 1 }, (_, i) => `4860100${String(i).padStart(4, '0')}`);
    expect(() => splitRecipients(many)).toThrow(TooManyRecipientsError);
  });
});
