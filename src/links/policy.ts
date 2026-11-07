// Polityka skracania przy kluczu API i normalizacja domen.
import { domainToASCII } from 'node:url';
import type { LinkMode } from '../store/api-keys.ts';

/**
 * Zgłoszenie w odpowiedzi API, że wynik różni się od wyboru wysyłającego: klucz wyłącza albo wymusza
 * skracanie, domena skracacza klucza jest wyłączona albo serwer przekierowań nie działa i linki zostają
 * wysłane bez zmian albo kampania ma wyłączone linki i krótkie linki powstają wyłączone.
 */
export type LinkNotice = 'disabled_by_key' | 'forced_by_key' | 'domain_unavailable' | 'campaign_links_disabled';

/** Ustawienie klucza ma pierwszeństwo przed polem żądania; `notice` zgłasza, że wybór wysyłającego nie został uwzględniony. */
export function decideShortening(mode: LinkMode, requested: boolean | undefined): { shorten: boolean; notice: LinkNotice | null } {
  switch (mode) {
    case 'off':
      return { shorten: false, notice: requested === true ? 'disabled_by_key' : null };
    case 'always':
      return { shorten: true, notice: requested === false ? 'forced_by_key' : null };
    case 'sender':
      return { shorten: requested !== false, notice: null };
  }
}

/** Host równy wpisowi albo jego subdomena; `firma.pl` nie obejmuje `zlafirma.pl`. */
export function targetAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validDomain(domain: string): boolean {
  if (domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;
  // Domena najwyższego poziomu nie składa się z samych cyfr, dlatego adres IPv4 nie jest domeną.
  return !/^\d+$/.test(labels[labels.length - 1]!);
}

/** Pole domeny z panelu: małe litery, `domainToASCII`, bez kropki na końcu; null przy schemacie, ścieżce, porcie, spacji albo bez kropki. */
export function normalizeDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\.$/, '');
  if (value === '' || /[\s/:@?#\\]/.test(value)) return null;
  const ascii = domainToASCII(value);
  return validDomain(ascii) ? ascii : null;
}
