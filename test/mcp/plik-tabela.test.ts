import { describe, expect, it } from 'vitest';
import {
  analyze, columnLetter, FILE_BYTES_MAX, looksLikePhone, nextChunk, PHONE_HEADERS, readFileBytes, ROWS_MAX, UPLOAD_BYTES, UPLOAD_CHUNK,
} from '../../src/mcp/views/client/plik-tabela.js';
import { FILE_MEGABYTES_MAX, FILE_ROWS_MAX, UPLOAD_ROWS_MAX } from '../../src/store/agent-files.ts';
import { makeZipFiles } from '../helpers/zip.ts';

const row = (line: number, ...cells: string[]) => ({ line, cells });
const OLE = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

describe('rozpoznanie tabeli z pliku', () => {
  it('limity widoku zgodne z bramką, porcja z punktu kontrolnego A', () => {
    expect(ROWS_MAX).toBe(FILE_ROWS_MAX);
    expect(FILE_BYTES_MAX).toBe(FILE_MEGABYTES_MAX * 1024 * 1024);
    expect(UPLOAD_CHUNK).toBe(2500);
    expect(UPLOAD_CHUNK).toBeLessThanOrEqual(UPLOAD_ROWS_MAX);
    expect(UPLOAD_BYTES).toBe(900 * 1024);
  });

  it('columnLetter i looksLikePhone', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
    expect(['48601000011', '+48 601 000 011', '601-000-011', '(22) 123-45-67', '601000013', ' 601 000 013 ']
      .map(looksLikePhone)).toEqual([true, true, true, true, true, true]);
    expect(['12345', 'Numer', '1 234,50 zł', '30.11.2026', '', '4860100001112345', '48 601 000 0x1'].map(looksLikePhone)).toEqual([false, false, false, false, false, false, false]);
  });

  it('plik .xls i plik ponad 20 MB: komunikat bez przesyłania', async () => {
    const xls = await readFileBytes('kontrahenci.xls', OLE);
    expect(xls).toEqual({ error: expect.stringContaining('Zapisz plik w Excelu jako „Skoroszyt programu Excel (.xlsx)” albo „CSV UTF-8”') });
    expect(xls.error).toContain('Excel 97-2003');
    // Skoroszyt .xlsx zabezpieczony hasłem Excel zapisuje w tym samym kontenerze co .xls.
    expect((await readFileBytes('kontrahenci.xlsx', OLE)).error).toContain('hasłem');
    expect(await readFileBytes('kontrahenci.csv', new Uint8Array(FILE_BYTES_MAX + 1))).toEqual({ error: 'Rozmiar pliku przekracza 20 MB, dlatego widok go nie odczyta' });
    expect(await readFileBytes('pusty.csv', new Uint8Array(0))).toEqual({ error: 'Plik nie zawiera wierszy danych' });
    expect((await readFileBytes('dokument.odt', new Uint8Array(makeZipFiles({ 'content.xml': '<office/>' })))).error).toContain('Plik nie jest skoroszytem programu Excel w formacie .xlsx');
  });

  it('readFileBytes: CSV z kodowaniem i separatorem, XLSX z listą arkuszy i pierwszym arkuszem', async () => {
    const csv = await readFileBytes('lista.txt', new Uint8Array(Buffer.from('Numer\tKontrahent\n48601000011\tHurtownia Łódź\n')));
    expect(csv).toEqual({ kind: 'csv', encoding: 'utf-8', separator: '\t', rows: [row(1, 'Numer', 'Kontrahent'), row(2, '48601000011', 'Hurtownia Łódź')] });
    const book = makeZipFiles({
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Listopad" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>Telefon</t></is></c></row></sheetData></worksheet>',
    });
    // Rozpoznanie skoroszytu po zawartości, nie po rozszerzeniu nazwy.
    const read = await readFileBytes('lista.txt', new Uint8Array(book));
    expect(read).toMatchObject({ kind: 'xlsx', sheet: 0, rows: [row(2, '', 'Telefon')] });
    expect('book' in read && read.book.sheets).toEqual([{ name: 'Listopad', path: 'xl/worksheets/sheet1.xml' }]);
  });

  it('nagłówek: pierwszy niepusty wiersz; numer w pierwszym wierszu oznacza brak nagłówka i nazwy Kolumna A, Kolumna B', () => {
    const withHeader = analyze([row(1, '', ''), row(2, 'Numer', 'Kontrahent'), row(3, '48601000011', 'Hurtownia Łódź'), row(4, ' ', ''), row(5, '48601000012', 'Apteka Źródło')]);
    expect(withHeader).toEqual({
      header: true, columns: ['Numer', 'Kontrahent'],
      data: [row(3, '48601000011', 'Hurtownia Łódź'), row(5, '48601000012', 'Apteka Źródło')], phoneCandidates: [0],
    });
    const noHeader = analyze([row(1, 'Hurtownia Łódź', '+48 601 000 011'), row(2, 'Apteka Źródło', '48601000012')]);
    expect(noHeader).toEqual({
      header: false, columns: ['Kolumna A', 'Kolumna B'],
      data: [row(1, 'Hurtownia Łódź', '+48 601 000 011'), row(2, 'Apteka Źródło', '48601000012')], phoneCandidates: [1],
    });
    // Pracownik zmienia rozpoznanie polem wyboru: wartości pierwszego wiersza nie stają się nazwami kolumn.
    expect(analyze([row(1, 'Numer', 'Kontrahent'), row(2, '48601000011', 'Hurtownia')], { header: false })).toMatchObject({
      header: false, columns: ['Kolumna A', 'Kolumna B'], data: [row(1, 'Numer', 'Kontrahent'), row(2, '48601000011', 'Hurtownia')],
    });
    expect(analyze([row(1, '', '')])).toEqual({ header: false, columns: [], data: [], phoneCandidates: [] });
  });

  it('numer z kropkami jak w bramce: plik bez nagłówka z takimi numerami otrzymuje nazwy Kolumna A, B, C', () => {
    expect(looksLikePhone('601.000.011')).toBe(true);
    expect(looksLikePhone('+48.601.000.011')).toBe(true);
    const table = analyze([row(1, '601.000.011', 'Hurtownia Łódź', '1 234,50 zł'), row(2, '601.000.012', 'Serwis Kraków', '99,00 zł'), row(3, '601.000.013', 'Flota Gdańsk', '15,00 zł')]);
    expect(table.header).toBe(false);
    expect(table.columns).toEqual(['Kolumna A', 'Kolumna B', 'Kolumna C']);
    expect(table.phoneCandidates).toEqual([0]);
  });

  it('plik bez nagłówka, w którym pierwszy klient nie ma numeru: wartości pierwszego wiersza nie stają się nazwami kolumn', () => {
    const data = Array.from({ length: 10 }, (_, i) => row(i + 2, `4860100001${i}`, `Serwis ${i}`, '99,00 zł'));
    const table = analyze([row(1, '', 'Hurtownia Łódź', '1 234,50 zł'), ...data]);
    expect(table.header).toBe(false);
    expect(table.columns).toEqual(['Kolumna A', 'Kolumna B', 'Kolumna C']);
    expect(table.data[0]).toEqual(row(1, '', 'Hurtownia Łódź', '1 234,50 zł'));
    expect(table.phoneCandidates).toEqual([0]);
    // Nagłówek z nazwą kolumny numeru z listy pozostaje nagłówkiem także przy pustej nazwie innej kolumny.
    expect(analyze([row(1, 'Telefon', '', 'Kwota'), ...data]).header).toBe(true);
    // Nagłówek z nazwą nad kolumną numeru rozpoznaną po zawartości pozostaje nagłówkiem.
    expect(analyze([row(1, 'Komórka służbowa', 'Kontrahent', 'Kwota'), ...data]).header).toBe(true);
  });

  it('pusta i powtórzona nazwa kolumny w nagłówku', () => {
    const t = analyze([row(1, 'Numer', '', ' Kwota ', 'kwota', 'Kwota'), row(2, '48601000011', 'Hurtownia', '1 234,50 zł', '99,00 zł', '10,00 zł', 'uwaga')]);
    expect(t.columns).toEqual(['Numer', 'Kolumna B', 'Kwota', 'kwota (D)', 'Kwota (E)', 'Kolumna F']);
    // Wiersz krótszy od nagłówka otrzymuje puste komórki, a puste kolumny na końcu wszystkich wierszy są pomijane.
    expect(analyze([row(1, 'Numer', 'Kontrahent', ''), row(2, '48601000011', '', '')]).data).toEqual([row(2, '48601000011', '')]);
    expect(analyze([row(1, 'Numer', 'Kontrahent'), row(2, '48601000011')]).data).toEqual([row(2, '48601000011', '')]);
  });

  it('kolumna numeru po nagłówku Telefon, po zawartości 90%, dwie kandydatki: lista do wyboru', () => {
    expect(PHONE_HEADERS).toEqual(expect.arrayContaining(['numer', 'telefon', 'tel', 'komorka', 'nr telefonu', 'phone', 'msisdn']));
    // Nazwa nagłówka bez względu na wielkość liter i polskie znaki ma pierwszeństwo przed zawartością.
    expect(analyze([row(1, 'NIP', 'KOMÓRKA'), row(2, '5260001234', 'brak')]).phoneCandidates).toEqual([1]);
    expect(analyze([row(1, 'Kontrahent', 'Nr telefonu:'), row(2, 'Hurtownia', '')]).phoneCandidates).toEqual([1]);
    // Bez nazwy z listy: kolumna, w której co najmniej 90% wierszy zawiera poprawny numer.
    const data = Array.from({ length: 10 }, (_, i) => row(i + 2, `4860100001${i}`, i < 8 ? `4860200001${i}` : 'brak', 'Hurtownia'));
    expect(analyze([row(1, 'Komórka służbowa', 'Kontakt', 'Kontrahent'), ...data]).phoneCandidates).toEqual([0]);
    const two = data.map((r) => row(r.line, r.cells[0]!, '5260001234', 'x'));
    expect(analyze([row(1, 'Komórka służbowa', 'NIP', 'Kontrahent'), ...two]).phoneCandidates).toEqual([0, 1]);
    expect(analyze([row(1, 'Telefon', 'Tel'), row(2, '48601000011', '48601000012')]).phoneCandidates).toEqual([0, 1]);
    expect(analyze([row(1, 'Kontrahent', 'Kwota'), row(2, 'Hurtownia', '1 234,50 zł')]).phoneCandidates).toEqual([]);
  });

  it('nextChunk: porcja do UPLOAD_CHUNK wierszy i do UPLOAD_BYTES treści JSON', () => {
    const rows = Array.from({ length: 6000 }, (_, i) => row(i + 2, `486010${String(i).padStart(5, '0')}`, 'Hurtownia Łódź'));
    expect(nextChunk(rows, 0)).toBe(2500);
    expect(nextChunk(rows, 5000)).toBe(6000);
    // Wiersze z długimi wartościami: porcja kończy się przed przekroczeniem 900 KB treści JSON.
    const wide = Array.from({ length: 2500 }, (_, i) => row(i + 2, '48601000011', 'ż'.repeat(500)));
    const end = nextChunk(wide, 0);
    const bytes = Buffer.byteLength(JSON.stringify(wide.slice(0, end)));
    expect(end).toBeLessThan(2500);
    expect(bytes).toBeLessThanOrEqual(UPLOAD_BYTES);
    expect(Buffer.byteLength(JSON.stringify(wide.slice(0, end + 1)))).toBeGreaterThan(UPLOAD_BYTES);
    expect(nextChunk(rows, 0, { size: 2 })).toBe(2);
  });
});
