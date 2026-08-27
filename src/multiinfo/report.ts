import { type GatewayStatus, mapStatus } from './status.ts';

/** Jeden wiersz raportu rozsyłki: identyfikator, numer, status, czas, opcjonalnie identyfikator klienta. */
export interface ReportRow {
  miId: string;
  dest: string;
  /** Kod statusu Multiinfo; `null`, gdy raport podał opis, którego nie umiemy przełożyć na kod. */
  miStatus: number | null;
  status: GatewayStatus;
  /** Status tak, jak stał w pliku - kod albo opis słowny. */
  rawStatus: string;
  changedAt: string;
  clientId: string | null;
}

/**
 * `yyyyMMddhhmmss` (§2.9) albo `dd.MM.yyyy HH:mm:ss` (prawdziwy plik) → `YYYY-MM-DD HH:mm:ss`.
 * Czas zostaje taki, jak podał Plus (polski), bez przeliczania na UTC - nie fabrykujemy
 * strefy. Inne formaty przechodzą bez zmian.
 */
export function formatReportTime(raw: string): string {
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw.trim());
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}:${compact[6]}`;
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(raw.trim());
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]} ${dotted[4]}`;
  return raw.trim();
}

const DELIMITERS = [';', ',', '\t'];

/** Separator, który dzieli pierwszy wiersz na najwięcej kolumn; przy remisie średnik. */
function detectDelimiter(line: string): string {
  return DELIMITERS.reduce((best, d) => (line.split(d).length > line.split(best).length ? d : best), ';');
}

const unquote = (c: string): string => c.trim().replace(/^"(.*)"$/, '$1');

/**
 * Opisy słowne statusu z prawdziwego raportu i ich kody. Zweryfikowane 2026-08-26:
 * „Doręczono”. Pozostałe wpisy idą za słownictwem statusów Multiinfo; opis spoza
 * listy nie jest zgadywany - wiersz dostaje status `unknown`, a worker zapisuje opis
 * w dzienniku, żeby można było uzupełnić słownik.
 */
const STATUS_WORDS: Array<[RegExp, number]> = [
  [/^dor[eę]czon/i, 21],
  [/^nie ?dor[eę]czon/i, 11],
  [/przedawnion|wygas/i, 12],
  [/anulowan/i, 13],
  [/czarn/i, 20],
  [/^wys[lł]an/i, 3],
  [/oczek/i, 1],
];

function statusOf(raw: string): { miStatus: number | null; status: GatewayStatus } {
  if (/^\d+$/.test(raw)) {
    const code = Number.parseInt(raw, 10);
    return { miStatus: code, status: mapStatus(code, code === 21 ? 1 : 0) };
  }
  for (const [pattern, code] of STATUS_WORDS) {
    if (pattern.test(raw)) return { miStatus: code, status: mapStatus(code, code === 21 ? 1 : 0) };
  }
  return { miStatus: null, status: 'unknown' };
}

interface Columns { miId: number; dest: number; status: number; changedAt: number; clientId: number }

/** Kolejność z §2.9: identyfikator, numer, status, czas, identyfikator klienta. */
const PDF_COLUMNS: Columns = { miId: 0, dest: 1, status: 2, changedAt: 3, clientId: 4 };

/**
 * Prawdziwy plik ma nagłówek `Numer odb.;Opis statusu;Id;Data statusu;Ident. wiad. klienta`.
 * Kolumny rozpoznajemy po słowach, nie po pozycji, żeby przestawienie kolumn u operatora
 * nie pomieszało numeru z identyfikatorem.
 */
function columnsFromHeader(cells: string[]): Columns | null {
  const find = (test: (c: string) => boolean): number => cells.findIndex((c) => test(c.toLowerCase()));
  const miId = find((c) => /^id\b/.test(c));
  const cols: Columns = {
    miId,
    dest: find((c) => c.includes('numer')),
    status: find((c) => c.includes('status') && !c.includes('data')),
    changedAt: find((c) => c.includes('data') || c.includes('czas')),
    // „Ident. wiad. klienta” w prawdziwym pliku; bez słowa „klient” - inna kolumna z „ident”.
    clientId: find((c) => c.includes('klient')) >= 0
      ? find((c) => c.includes('klient'))
      : cells.findIndex((c, i) => i !== miId && c.toLowerCase().includes('ident')),
  };
  return cols.dest >= 0 && cols.status >= 0 && cols.miId >= 0 ? cols : null;
}

/**
 * Separator wykrywamy po pierwszym wierszu. Nagłówek, jeśli jest, ustala znaczenie kolumn;
 * bez nagłówka przyjmujemy kolejność z §2.9. Wiersze bez numeru i identyfikatora pomijamy
 * zamiast wywracać import.
 */
export function parseReport(text: string): ReportRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const delimiter = detectDelimiter(lines[0]!);
  const header = columnsFromHeader(lines[0]!.split(delimiter).map(unquote));
  const cols = header ?? PDF_COLUMNS;
  const rows: ReportRow[] = [];
  for (const line of header ? lines.slice(1) : lines) {
    const cells = line.split(delimiter).map(unquote);
    const miId = cells[cols.miId] ?? '';
    const dest = cells[cols.dest] ?? '';
    if (!/^\d+$/.test(miId) || !/^\d+$/.test(dest)) continue;
    const rawStatus = cells[cols.status] ?? '';
    const clientId = cols.clientId >= 0 ? cells[cols.clientId] : undefined;
    rows.push({
      miId,
      dest,
      ...statusOf(rawStatus),
      rawStatus,
      changedAt: formatReportTime(cells[cols.changedAt] ?? ''),
      clientId: clientId ? clientId : null,
    });
  }
  return rows;
}
