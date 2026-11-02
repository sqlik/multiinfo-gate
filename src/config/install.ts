import { existsSync } from 'node:fs';

/** Sposób instalacji: od niego zależą polecenia podawane na stronach pomocy panelu. */
export type InstallKind = 'docker' | 'lxc';

/**
 * Docker i Podman zostawiają w kontenerze plik znacznika. Kontener LXC ma plik konfiguracji
 * z instalatora (także instalacje sprzed 1.8.7, bo aktualizacja go nie usuwa). Bez znacznika
 * wynik jest nieznany i strony pokazują oba warianty.
 */
export function detectInstall(exists: (path: string) => boolean = existsSync): InstallKind | null {
  if (exists('/.dockerenv') || exists('/run/.containerenv')) return 'docker';
  if (exists('/etc/multiinfo-gate/env')) return 'lxc';
  return null;
}
