import { describe, expect, it } from 'vitest';
import { endOfWarsawDay, lastValidDay, warsawCompactToIso, warsawDay, warsawStamp, warsawTime, warsawTimeMs } from '../../src/time/warsaw.ts';

describe('endOfWarsawDay', () => {
  it('latem koniec dnia to 22:00 UTC', () => {
    expect(endOfWarsawDay('2026-09-30')).toBe('2026-09-30T22:00:00.000Z');
  });

  it('zimą koniec dnia to 23:00 UTC', () => {
    expect(endOfWarsawDay('2026-12-31')).toBe('2026-12-31T23:00:00.000Z');
  });

  it('w dniu zmiany czasu na zimowy liczy po nowej strefie', () => {
    // 25.10.2026 o 03:00 CEST zegar cofa się na 02:00 CET; północ 26.10 jest już w CET.
    expect(endOfWarsawDay('2026-10-25')).toBe('2026-10-25T23:00:00.000Z');
  });

  it('w dniu zmiany czasu na letni liczy po nowej strefie', () => {
    expect(endOfWarsawDay('2026-03-29')).toBe('2026-03-29T22:00:00.000Z');
  });

  it('odrzuca datę spoza formatu', () => {
    expect(() => endOfWarsawDay('30.09.2026')).toThrow();
    expect(() => endOfWarsawDay('2026-02-30')).toThrow();
  });
});

describe('lastValidDay', () => {
  it('odwraca endOfWarsawDay', () => {
    for (const day of ['2026-09-30', '2026-12-31', '2026-10-25', '2026-03-29']) {
      expect(lastValidDay(endOfWarsawDay(day))).toBe(day);
    }
  });
});

describe('warsawStamp / warsawDay', () => {
  it('latem przesuwa o dwie godziny', () => {
    expect(warsawStamp('2026-08-26T20:50:50.000Z')).toBe('2026-08-26 22:50:50');
  });

  it('zimą o godzinę, także przez granicę doby', () => {
    expect(warsawStamp('2026-12-31T23:30:00.000Z')).toBe('2027-01-01 00:30:00');
    expect(warsawDay('2026-12-31T23:30:00.000Z')).toBe('2027-01-01');
  });

  it('dzień bez godziny traktuje jako północ UTC', () => {
    expect(warsawDay('2027-03-14')).toBe('2027-03-14');
  });
});

describe('warsawTime', () => {
  it('latem godzina to UTC+2', () => {
    expect(warsawTime('2026-08-27T11:52:13.000Z')).toBe('13:52:13');
  });

  it('zimą godzina to UTC+1, także po przekroczeniu północy', () => {
    expect(warsawTime('2026-12-31T23:30:05.000Z')).toBe('00:30:05');
  });

  it('wariant z milisekundami zachowuje ułamek sekundy', () => {
    expect(warsawTimeMs('2026-08-27T11:52:13.457Z')).toBe('13:52:13.457');
  });
});

describe('warsawCompactToIso', () => {
  it('lato: czas polski to UTC+2', () => {
    expect(warsawCompactToIso('20260829091400')).toBe('2026-08-29T07:14:00.000Z');
  });
  it('zima: czas polski to UTC+1', () => {
    expect(warsawCompactToIso('20260115120000')).toBe('2026-01-15T11:00:00.000Z');
  });
  it('odrzuca zły format', () => {
    expect(() => warsawCompactToIso('2026-08-29')).toThrow(/yyyyMMddhhmmss/);
  });
});
