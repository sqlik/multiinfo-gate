import type { StartupReason } from './startup/reason.ts';

/** Artykuł „Rozwiązywanie problemów” w dokumentacji publicznej. */
export const TROUBLESHOOTING_URL = 'https://sqlik.github.io/multiinfo-gate/problemy/';

/**
 * Stałe kotwice punktów artykułu (`{#…}` w docs/problemy.md); panel i dziennik odsyłają do nich wprost.
 * Zgodność z artykułem pilnuje test docs-links.
 */
export const PROBLEM_ANCHORS = [
  'panel-nie-odpowiada', 'pierwsze-konto', 'logowanie-wraca', 'kod-odrzucony', 'blad-wewnetrzny',
  'klucz-glowny', 'klucz-nieprawidlowy', 'klucz-czesciowy', 'kopia-przed-aktualizacja', 'baza-z-nowszego-wydania',
  'brak-miejsca', 'uprawnienia', 'uszkodzona-baza', 'nieudana-migracja', 'awaria-startu',
  'zajety-port', 'po-aktualizacji', 'sms-od-abonentow', 'wersja-node', 'zgloszenie',
] as const;

export type ProblemAnchor = typeof PROBLEM_ANCHORS[number];

export function problemUrl(anchor: ProblemAnchor): string {
  return `${TROUBLESHOOTING_URL}#${anchor}`;
}

/** Punkt artykułu opisujący daną przyczynę awarii startu. */
export const REASON_ANCHOR: Record<StartupReason, ProblemAnchor> = {
  key_mismatch: 'klucz-glowny',
  key_invalid: 'klucz-nieprawidlowy',
  backup_failed: 'kopia-przed-aktualizacja',
  newer_database: 'baza-z-nowszego-wydania',
  disk_full: 'brak-miejsca',
  permissions: 'uprawnienia',
  corrupt: 'uszkodzona-baza',
  migration_failed: 'nieudana-migracja',
  unknown: 'awaria-startu',
};
