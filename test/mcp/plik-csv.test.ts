import { describe, expect, it } from 'vitest';
import { decodeBytes, detectSeparator, parseCsv } from '../../src/mcp/views/client/plik-csv.js';

const TEXT = 'Numer;Kontrahent;Kwota\r\n48601000011;Hurtownia Łódź;1 234,50 zł\r\n48601000012;Zakład Usług Żuraw;99,00 zł\r\n48601000013;Piekarnia Świętokrzyska;12,5%\r\n';

// Bajty polskich liter w Windows-1250 i w MacCentralEurope (tabela Apple CENTEURO), niezależnie od czytnika.
const CP1250: Record<string, number> = {
  ą: 0xb9, ć: 0xe6, ę: 0xea, ł: 0xb3, ń: 0xf1, ó: 0xf3, ś: 0x9c, ź: 0x9f, ż: 0xbf,
  Ą: 0xa5, Ć: 0xc6, Ę: 0xca, Ł: 0xa3, Ń: 0xd1, Ó: 0xd3, Ś: 0x8c, Ź: 0x8f, Ż: 0xaf,
};
const MAC_CE: Record<string, number> = {
  ą: 0x88, ć: 0x8d, ę: 0xab, ł: 0xb8, ń: 0xc4, ó: 0x97, ś: 0xe6, ź: 0x90, ż: 0xfd,
  Ą: 0x84, Ć: 0x8c, Ę: 0xa2, Ł: 0xfc, Ń: 0xc1, Ó: 0xee, Ś: 0xe5, Ź: 0x8f, Ż: 0xfb,
};

/** Tekst zapisany jednobajtowo: znaki ASCII bez zmian, polskie litery według tabeli. */
function encode(text: string, table: Record<string, number>): Uint8Array {
  return Uint8Array.from([...text].map((ch) => {
    if (ch.charCodeAt(0) < 0x80) return ch.charCodeAt(0);
    const byte = table[ch];
    if (byte === undefined) throw new Error(`Brak znaku ${ch} w tabeli testu.`);
    return byte;
  }));
}

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

describe('odczyt CSV w widoku: kodowanie', () => {
  it('UTF-8 ze znacznikiem BOM, UTF-8 bez znacznika i Windows-1250: ten sam tekst z ł, ś, ż', () => {
    expect(decodeBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(TEXT)]))).toEqual({ text: TEXT, encoding: 'utf-8' });
    expect(decodeBytes(utf8(TEXT))).toEqual({ text: TEXT, encoding: 'utf-8' });
    expect(decodeBytes(encode(TEXT, CP1250))).toEqual({ text: TEXT, encoding: 'windows-1250' });
  });

  it('MacCentralEurope z Excela dla macOS: wybór kodowania po liczbie polskich liter', () => {
    const mac = 'Numer;Kontrahent;Termin\r\n48601000011;Hurtownia Łódź;30.11.2026\r\n48601000012;Przedsiębiorstwo Handlowe Gęś;3.11.2026\r\n'
      + '48601000013;Apteka Źródło, Ćma i Śliwa;5.11.2026\r\n48601000014;Kwiaciarnia Róża, ul. Ńowa;6.11.2026\r\n';
    expect(decodeBytes(encode(mac, MAC_CE))).toEqual({ text: mac, encoding: 'x-mac-ce' });
    // Tekst Windows-1250 z literami, które w MacCentralEurope też są polskimi literami, zostaje przy Windows-1250.
    const cp = 'Kontrahent\r\nśćź Ćma\r\n';
    expect(decodeBytes(encode(cp, CP1250))).toEqual({ text: cp, encoding: 'windows-1250' });
  });

  it('UTF-16 ze znacznikiem BOM z zapisu „Tekst Unicode” w Excelu', () => {
    const tabs = 'Numer\tKontrahent\r\n48601000011\tHurtownia Łódź\r\n';
    expect(decodeBytes(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(tabs, 'utf16le')])))).toEqual({ text: tabs, encoding: 'utf-16le' });
  });
});

describe('odczyt CSV w widoku: separator i pola', () => {
  it('separator średnik, przecinek i tabulator; średnik w polu w cudzysłowie nie dzieli pola', () => {
    expect(detectSeparator(TEXT)).toBe(';');
    expect(detectSeparator('Numer,Kontrahent,Kwota\n48601000011,"Kowalski; Nowak s.c.",99.00\n')).toBe(',');
    expect(detectSeparator('Numer\tKontrahent\n48601000011\tHurtownia, oddział Kraków\n')).toBe('\t');
    expect(detectSeparator('Numer\n48601000011\n')).toBe(';');
    expect(detectSeparator('a;b,c\n')).toBe(';');
    // Polski Excel nie ujmuje w cudzysłów pól z przecinkami: przecinki przeważają liczbą, ale tylko średnik dzieli
    // każdy wiersz na tyle samo pól co nagłówek.
    const rows = Array.from({ length: 30 }, (_, i) => `48601000${100 + i};Hurtownia ${i}, oddział Kraków;1234,50;płatność po terminie, wysłano monit, kontakt z księgową`);
    expect(detectSeparator(['Numer;Kontrahent;Kwota;Uwagi', ...rows].join('\r\n'))).toBe(';');
    expect(parseCsv('Numer,Kontrahent\n48601000011,"Kowalski; Nowak s.c., oddział Kraków"\n', ',')).toEqual([
      { line: 1, cells: ['Numer', 'Kontrahent'] },
      { line: 2, cells: ['48601000011', 'Kowalski; Nowak s.c., oddział Kraków'] },
    ]);
    expect(parseCsv('Numer;Kontrahent\n48601000011;"Kowalski; Nowak s.c."\n', ';')[1]!.cells).toEqual(['48601000011', 'Kowalski; Nowak s.c.']);
  });

  it('RFC 4180: podwojony cudzysłów, pole z podziałem wiersza, pusty ostatni wiersz, numery wierszy pliku', () => {
    const csv = 'Numer;Kontrahent;Uwagi\r\n48601000011;"Serwis ""Północ"" Sp. z o.o.";\r\n48601000012;"Zakład Usług\r\nElektrycznych Żuraw";"a\nb"\r\n\r\n48601000013;Hotel Łabędź;x\r\n';
    expect(parseCsv(csv, ';')).toEqual([
      { line: 1, cells: ['Numer', 'Kontrahent', 'Uwagi'] },
      { line: 2, cells: ['48601000011', 'Serwis "Północ" Sp. z o.o.', ''] },
      { line: 3, cells: ['48601000012', 'Zakład Usług\r\nElektrycznych Żuraw', 'a\nb'] },
      { line: 4, cells: [''] },
      { line: 5, cells: ['48601000013', 'Hotel Łabędź', 'x'] },
    ]);
    expect(parseCsv('Numer\n48601000011', ';')).toEqual([{ line: 1, cells: ['Numer'] }, { line: 2, cells: ['48601000011'] }]);
    expect(parseCsv('', ';')).toEqual([]);
    // Cudzysłów bez pary obejmuje resztę pliku, a cudzysłów w środku pola bez cudzysłowów jest zwykłym znakiem.
    expect(parseCsv('a;"b\nc', ';')).toEqual([{ line: 1, cells: ['a', 'b\nc'] }]);
    expect(parseCsv('a;b"c;d\n', ';')).toEqual([{ line: 1, cells: ['a', 'b"c', 'd'] }]);
  });
});
