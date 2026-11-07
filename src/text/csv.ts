// Komórki plików CSV otwieranych w arkuszu: średnik jako separator, jak w polskich ustawieniach Excela.

/** Znacznik BOM: Excel z polskimi ustawieniami rozpoznaje po nim UTF-8 w pobranym pliku. */
export const CSV_BOM = '﻿';

/** Znak, od którego arkusz odczytuje komórkę jako formułę. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Wartość komórki. Tekst od znaku formuły dostaje apostrof, dzięki czemu arkusz pokazuje go jako tekst,
 * a nie wykonuje. Cudzysłów otacza wartość ze średnikiem, cudzysłowem, nowym wierszem albo apostrofem
 * na początku. Liczby zostają bez zmian.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return text !== value || /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
