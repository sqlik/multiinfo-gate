import { describe, expect, it } from 'vitest';
import { formatNumber, readSheet, readWorkbook, unzip } from '../../src/mcp/views/client/plik-xlsx.js';
import { readFileBytes } from '../../src/mcp/views/client/plik-tabela.js';
import { makeZipFiles } from '../helpers/zip.ts';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const SHEET_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

interface Book {
  sheets: Array<{ name: string; xml: string; state?: string }>;
  strings?: string[];
  numFmts?: Record<number, string>;
  xfs?: number[];
  date1904?: boolean;
}

/** Skoroszyt XLSX złożony z XML: arkusze w kolejności, relacje w odwrotnej kolejności identyfikatorów. */
function xlsx(book: Book, method: 'store' | 'deflate' = 'deflate'): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ${NS}><workbookPr${book.date1904 ? ' date1904="1"' : ''}/>`
      + `<sheets>${book.sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + book.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${SHEET_TYPE}" Target="worksheets/sheet${book.sheets.length - i}.xml"/>`).reverse().join('')
      + '<Relationship Id="rId90" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="/xl/sharedStrings.xml"/>'
      + '<Relationship Id="rId91" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': `<styleSheet ${NS}>`
      + (book.numFmts ? `<numFmts>${Object.entries(book.numFmts).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code.replace(/"/g, '&quot;')}"/>`).join('')}</numFmts>` : '')
      + '<cellStyleXfs count="1"><xf numFmtId="9"/></cellStyleXfs>'
      + `<cellXfs>${(book.xfs ?? [0]).map((id) => `<xf numFmtId="${id}" fontId="0" applyNumberFormat="1"/>`).join('')}</cellXfs></styleSheet>`,
    'xl/sharedStrings.xml': `<sst ${NS}>${(book.strings ?? []).join('')}</sst>`,
  };
  book.sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${book.sheets.length - i}.xml`] = `<?xml version="1.0" encoding="UTF-8"?>\n<worksheet ${NS}><sheetData>${s.xml}</sheetData></worksheet>`;
  });
  return new Uint8Array(makeZipFiles(files, method));
}

const cells = async (book: Book, index = 0) => readSheet(await readWorkbook(xlsx(book)), index);

describe('odczyt XLSX w widoku', () => {
  it('xlsx: sharedStrings z kilku r, inlineStr, liczba ogólna 48601000011 bez części dziesiętnej i wykładnika, formuła z zapisaną wartością', async () => {
    const rows = await cells({
      strings: [
        '<si><t>Numer</t></si>',
        '<si><r><rPr><b/></rPr><t>Kontr</t></r><r><t>ahent</t></r><rPh sb="0" eb="1"><t>KONTRAHENTO</t></rPh></si>',
        '<si><r><t xml:space="preserve">Hurtownia </t></r><r><t>Łódź &amp; Syn</t></r></si>',
        '<si><t>Linia_x000D_\nnowa</t></si>',
      ],
      sheets: [{
        name: 'Listopad',
        xml: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Kwota</t></is></c><c r="D1" t="inlineStr"><is><r><t>Su</t></r><r><t>ma</t></r></is></c></row>'
          + '<row r="3"><c r="A3"><v>48601000011</v></c><c r="B3" t="s"><v>2</v></c><c r="D3"><f>SUM(1,2)</f><v>3</v></c>'
          + '<c r="E3" t="str"><f>A1&amp;"x"</f><v>Numerx</v></c><c r="F3" t="b"><v>1</v></c><c r="G3" t="b"><v>0</v></c><c r="H3" t="e"><v>#N/A</v></c></row>'
          + '<row r="4"><c r="A4"><v>4.8601000012E10</v></c><c r="B4" t="s"><v>3</v></c><c r="C4"><f>1/0</f></c><c r="D4"/></row>',
      }],
    });
    expect(rows).toEqual([
      { line: 1, cells: ['Numer', 'Kontrahent', 'Kwota', 'Suma'] },
      // Puste komórki na końcu wiersza nie poszerzają go, a analiza tabeli dopełnia wiersze do szerokości pliku.
      { line: 3, cells: ['48601000011', 'Hurtownia Łódź & Syn', '', '3', 'Numerx', 'PRAWDA', 'FAŁSZ'] },
      { line: 4, cells: ['48601000012', 'Linia\r\nnowa'] },
    ]);
  });

  it('xlsx: data 46356 z formatem 14 jako 30.11.2026, data z godziną, date1904', async () => {
    const book: Book = {
      numFmts: { 166: 'dd/mm/yyyy\\ hh:mm', 167: 'yyyy-mm-dd', 168: '[$-415]d mmmm yyyy', 169: 'h:mm:ss' },
      xfs: [0, 14, 22, 166, 167, 168, 169, 20],
      sheets: [{
        name: 'Terminy',
        xml: '<row r="1"><c r="A1" s="1"><v>46356</v></c><c r="B1" s="2"><v>46356.583333333336</v></c><c r="C1" s="3"><v>46329.395833333336</v></c>'
          + '<c r="D1" s="4"><v>46356.9</v></c><c r="E1" s="5"><v>46356</v></c><c r="F1" s="6"><v>0.5</v></c><c r="G1" s="7"><v>0.75</v></c></row>',
      }],
    };
    expect((await cells(book))[0]!.cells).toEqual(['30.11.2026', '30.11.2026 14:00', '03.11.2026 09:30', '30.11.2026', '30.11.2026', '12:00:00', '18:00']);
    book.date1904 = true;
    book.sheets[0]!.xml = '<row r="1"><c r="A1" s="1"><v>44894</v></c><c r="B1" s="2"><v>44894.583333333336</v></c></row>';
    expect((await cells(book))[0]!.cells).toEqual(['30.11.2026', '30.11.2026 14:00']);
    expect(formatNumber(46356, 'dd.mm.yyyy', false)).toBe('30.11.2026');
    expect(formatNumber(44894, 'dd.mm.yyyy', true)).toBe('30.11.2026');
  });

  it('xlsx: 1234,5 z formatem walutowym jako 1 234,50 zł ze zwykłą spacją, 0,125 z formatem 0.0% jako 12,5%, format nierozpoznany', async () => {
    const rows = await cells({
      numFmts: { 164: '#,##0.00\\ "zł"', 165: '#,##0.00 [$zł-415]', 167: '0.0%', 170: '_-* #,##0.00\\ "zł"_-;\\-* #,##0.00\\ "zł"_-;_-* "-"??\\ "zł"_-;_-@_-', 171: '0.00E+00' },
      xfs: [0, 164, 165, 167, 170, 171, 4, 3, 1, 10, 49],
      sheets: [{
        name: 'Kwoty',
        xml: '<row r="1"><c r="A1" s="1"><v>1234.5</v></c><c r="B1" s="2"><v>1234.5</v></c><c r="C1" s="3"><v>0.125</v></c><c r="D1" s="4"><v>-1234.5</v></c>'
          + '<c r="E1" s="5"><v>1234.5</v></c><c r="F1" s="6"><v>1234567.891</v></c><c r="G1" s="7"><v>1234567.5</v></c><c r="H1" s="8"><v>48601000011</v></c>'
          + '<c r="I1" s="9"><v>0.05</v></c><c r="J1" s="10"><v>42</v></c><c r="K1"><v>0.30000000000000004</v></c></row>',
      }],
    });
    expect(rows[0]!.cells).toEqual(['1 234,50 zł', '1 234,50 zł', '12,5%', '-1 234,50 zł', '1234,5', '1 234 567,89', '1 234 568', '48601000011', '5,00%', '42', '0,3']);
    expect(formatNumber(1234.5, '#,##0.00\\ "zł"', false)).toBe('1 234,50 zł');
    expect(formatNumber(-0.5, '0.00', false)).toBe('-0,50');
    expect(formatNumber(0, '_-* #,##0.00\\ "zł"_-;\\-* #,##0.00\\ "zł"_-;_-* "-"??\\ "zł"_-;_-@_-', false)).toBe('- zł');
    expect(formatNumber(1.005, '0.00', false)).toBe('1,01');
    expect(formatNumber(1e21, 'General', false)).toBe('1000000000000000000000');
    expect(formatNumber(0.0000001, 'General', false)).toBe('0,0000001');
    expect(formatNumber(12.345, '[Red]0.0', false)).toBe('12,3');
    expect(formatNumber(601000013, '[<=999999999]###\\ ###\\ ###;###\\ ###\\ ###', false)).toBe('601000013');
    expect(formatNumber(true, 'General', false)).toBe('PRAWDA');
    expect(formatNumber('tekst', '0.00', false)).toBe('tekst');
  });

  it('formatNumber: czas trwania [h]:mm ponad dobę, minuty i sekundy mm:ss, [mm]:ss i [h]:mm:ss jak w Excelu', () => {
    expect(formatNumber(1.5, '[h]:mm', false)).toBe('36:00');
    expect(formatNumber(1.5, '[hh]:mm', true)).toBe('36:00');
    expect(formatNumber(1 / 16, '[h]:mm', false)).toBe('1:30');
    expect(formatNumber(1.5 + 30 / 86400, '[h]:mm:ss', false)).toBe('36:00:30');
    expect(formatNumber(1.5 / 24, '[mm]:ss', false)).toBe('90:00');
    expect(formatNumber(15 / 1440, 'mm:ss', false)).toBe('15:00');
    expect(formatNumber(15 / 1440 + 7 / 86400, 'mm:ss', false)).toBe('15:07');
    expect(formatNumber(0.5, 'hh:mm', false)).toBe('12:00');
  });

  it('xlsx: dwa arkusze, lista nazw, odczyt drugiego; metoda store i deflate', async () => {
    const book: Book = {
      strings: ['<si><t>Numer</t></si>'],
      sheets: [
        { name: 'Listopad', xml: '<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>48601000011</v></c></row>' },
        { name: 'Ukryty', state: 'hidden', xml: '<row r="1"><c r="A1"><v>1</v></c></row>' },
        { name: 'Grudzień &amp; styczeń', xml: '<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>48601000021</v></c></row>' },
      ],
    };
    for (const method of ['store', 'deflate'] as const) {
      const wb = await readWorkbook(xlsx(book, method));
      expect(wb.sheets.map((s: { name: string }) => s.name)).toEqual(['Listopad', 'Grudzień & styczeń']);
      expect(wb.date1904).toBe(false);
      expect(readSheet(wb, 1)).toEqual([{ line: 1, cells: ['Numer'] }, { line: 2, cells: ['48601000021'] }]);
      expect(readSheet(wb, 0)[1]).toEqual({ line: 2, cells: ['48601000011'] });
    }
    const files = await unzip(xlsx(book, 'store'));
    expect([...files.keys()]).toContain('xl/workbook.xml');
    expect(new TextDecoder().decode(files.get('xl/sharedStrings.xml'))).toContain('<si><t>Numer</t></si>');
  });

  it('xlsx: archiwum bez skoroszytu albo uszkodzone daje błąd z komunikatem', async () => {
    await expect(readWorkbook(new Uint8Array(makeZipFiles({ 'content.xml': '<office/>' })))).rejects.toThrow('Plik nie jest skoroszytem programu Excel w formacie .xlsx');
    await expect(readWorkbook(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).rejects.toThrow('Widok nie odczytał skoroszytu');
  });

  it('xlsx: adres komórki za kolumną XFD to plik uszkodzony; pusta komórka z formatem nie poszerza wiersza; odległa wartość tylko jako szerokość', async () => {
    const BROKEN = 'Widok nie odczytał skoroszytu, ponieważ plik jest uszkodzony. Zapisz go w Excelu ponownie albo jako „CSV UTF-8”.';
    const beyond = await readWorkbook(xlsx({ sheets: [{ name: 'Listopad', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>Numer</t></is></c><c r="AAAAAAA1" t="inlineStr"><is><t>x</t></is></c></row>' }] }));
    expect(() => readSheet(beyond, 0)).toThrow(BROKEN);
    const rows = await cells({ sheets: [{ name: 'Listopad', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>Numer</t></is></c><c r="XFD1" s="0"/></row>'
      + '<row r="2"><c r="A2"><v>48601000011</v></c><c r="XFD2" t="inlineStr"><is><t>x</t></is></c></row>' }] });
    expect(rows[0]).toEqual({ line: 1, cells: ['Numer'] });
    expect(rows[1]!.cells.length).toBeLessThanOrEqual(51);
    expect(rows[1]).toMatchObject({ line: 2, width: 16_384 });
    expect(rows[1]!.cells[0]).toBe('48601000011');
  });

  it('xlsx: uszkodzone dane deflate arkusza dają polski komunikat o uszkodzonym pliku zamiast błędu rozpakowania', async () => {
    const zip = xlsx({ sheets: [{ name: 'Listopad', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>Numer</t></is></c></row><row r="2"><c r="A2"><v>48601000011</v></c></row>' }] });
    // Dane deflate arkusza zaczynają się po nagłówku lokalnym i nazwie pliku, a plik przerwany przy kopiowaniu ma w tym miejscu inne bajty.
    const name = Buffer.from('xl/worksheets/sheet1.xml');
    const at = Buffer.from(zip).indexOf(name) + name.length;
    for (let i = at; i < at + 8; i += 1) zip[i] = 0xff;
    const BROKEN = 'Widok nie odczytał skoroszytu, ponieważ plik jest uszkodzony. Zapisz go w Excelu ponownie albo jako „CSV UTF-8”.';
    await expect(readWorkbook(zip)).rejects.toThrow(BROKEN);
    await expect(readFileBytes('przypomnienia-listopad.xlsx', zip)).resolves.toEqual({ error: BROKEN });
  });
});
