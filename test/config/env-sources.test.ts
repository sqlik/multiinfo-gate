import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Każda zmienna czytana przez `loadEnv` musi być wymieniona tam, gdzie administrator ją ustawia:
 * w `docker/docker-compose.yml` (Compose nie przekazuje `.env` do kontenera, tylko podstawia
 * wartości w pliku compose) i w szablonie `/etc/multiinfo-gate/env` instalatora LXC.
 * Pominięcia są jawne, z powodem, żeby nowa flaga nie przepadła po drodze.
 */
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const variables = [...new Set([...read('src/config/env.ts').matchAll(/source\.(MIG_[A-Z_]+)/g)].map((m) => m[1]!))].sort();

const POMINIETE_W_COMPOSE: Record<string, string> = {
  MIG_API_HOST: 'w kontenerze API nasłuchuje na wszystkich interfejsach, port mapuje Compose',
  MIG_BACKUP_RETENTION_DAYS: 'kopie bazy w kontenerze z wartością domyślną',
};
const POMINIETE_W_LXC: Record<string, string> = {
  MIG_TRUSTED_PROXIES: 'ustawiana dopiero przy odwrotnym proxy na hoście (docs/uruchomienie.md, rozdział 9)',
};

describe('zmienne środowiskowe bramki', () => {
  it('są wymienione w docker-compose.yml albo jawnie pominięte', () => {
    const compose = read('docker/docker-compose.yml');
    const brakujace = variables.filter((v) => !(v in POMINIETE_W_COMPOSE) && !new RegExp(`^\\s+${v}:`, 'm').test(compose));
    expect(brakujace).toEqual([]);
  });
  it('są wymienione w szablonie pliku env instalatora LXC albo jawnie pominięte', () => {
    const instalator = read('proxmox/install/multiinfogate-install.sh');
    const brakujace = variables.filter((v) => !(v in POMINIETE_W_LXC) && !new RegExp(`^${v}=`, 'm').test(instalator));
    expect(brakujace).toEqual([]);
  });
});
