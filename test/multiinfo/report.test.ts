import { describe, expect, it } from 'vitest';
import { formatReportTime, parseReport } from '../../src/multiinfo/report.ts';

/** Plik z prawdziwego getreport.aspx (2026-08-26, rozsyłka 28154463): BOM, pusta linia, nagłówek, opis statusu słowem. */
const REAL_CSV = '\ufeff\r\nNumer odb.;Opis statusu;Id;Data statusu;Ident. wiad. klienta\r\n'
  + '48601000001;Doręczono;2142628823;26.08.2026 17:30:47;\r\n';

describe('parseReport', () => {
  it('czyta prawdziwy raport Multiinfo: kolumny po nagłówku, status opisem, data z kropkami', () => {
    expect(parseReport(REAL_CSV)).toEqual([{
      miId: '2142628823', dest: '48601000001', miStatus: 21, status: 'delivered',
      rawStatus: 'Doręczono', changedAt: '2026-08-26 17:30:47', clientId: null,
    }]);
  });

  it('wiąże identyfikator klienta z piątej kolumny nagłówka i nie zgaduje nieznanego opisu', () => {
    const rows = parseReport('Numer odb.;Opis statusu;Id;Data statusu;Ident. wiad. klienta\n'
      + '48501052442;Coś zupełnie nowego;9002;26.08.2026 17:31:00;faktura-114\n');
    expect(rows[0]).toMatchObject({ dest: '48501052442', miId: '9002', clientId: 'faktura-114',
      miStatus: null, status: 'unknown', rawStatus: 'Coś zupełnie nowego' });
  });

  it('rozumie inną kolejność kolumn w nagłówku', () => {
    const rows = parseReport('Id;Numer odb.;Data statusu;Opis statusu\n9001;48601135134;26.08.2026 12:00:00;Doręczono\n');
    expect(rows[0]).toMatchObject({ miId: '9001', dest: '48601135134', status: 'delivered' });
  });

  it('czyta cztery kolumny rozdzielone średnikiem', () => {
    const rows = parseReport('9001;48601135134;21;20260826120000\n9002;48501052442;11;20260826120001\n');
    expect(rows).toEqual([
      { miId: '9001', dest: '48601135134', miStatus: 21, status: 'delivered', rawStatus: '21', changedAt: '2026-08-26 12:00:00', clientId: null },
      { miId: '9002', dest: '48501052442', miStatus: 11, status: 'failed', rawStatus: '11', changedAt: '2026-08-26 12:00:01', clientId: null },
    ]);
  });

  it('czyta pięć kolumn rozdzielonych przecinkiem i pomija nagłówek', () => {
    const rows = parseReport('id,numer,status,czas,identyfikator\r\n9001,48601135134,21,20260826120000,faktura-114\r\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toBe('faktura-114');
  });

  it('pomija puste linie i wiersze bez numerycznego identyfikatora', () => {
    expect(parseReport('\n\nabc;def\n9001;48601135134;21;20260826120000\n')).toHaveLength(1);
  });

  it('zdejmuje cudzysłowy i znacznik BOM', () => {
    const rows = parseReport('﻿"9001";"48601135134";"21";"20260826120000";""\n');
    expect(rows[0]).toEqual({ miId: '9001', dest: '48601135134', miStatus: 21, status: 'delivered', rawStatus: '21', changedAt: '2026-08-26 12:00:00', clientId: null });
  });

  it('zwraca pustą listę dla pustego raportu', () => {
    expect(parseReport('')).toEqual([]);
    expect(parseReport('\n\n')).toEqual([]);
  });
});

describe('formatReportTime', () => {
  it('rozpisuje czternaście cyfr na datę i godzinę', () => {
    expect(formatReportTime('20260826120000')).toBe('2026-08-26 12:00:00');
  });

  it('przestawia datę z kropkami, jak w raporcie Multiinfo', () => {
    expect(formatReportTime('26.08.2026 17:30:47')).toBe('2026-08-26 17:30:47');
  });

  it('zostawia czas w oryginale, gdy nie ma czternastu cyfr', () => {
    expect(formatReportTime('2026-08-26')).toBe('2026-08-26');
    expect(formatReportTime(' 2026-08-26 12:00:00 ')).toBe('2026-08-26 12:00:00');
  });
});
