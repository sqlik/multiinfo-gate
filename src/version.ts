import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Numer wersji z package.json - jedno źródło dla tagu wydania, obrazu, masztu panelu
 * i /healthz. Plik leży katalog wyżej zarówno przy uruchomieniu ze źródeł (src/),
 * jak i z wyniku budowania (dist/), więc ścieżka jest ta sama w obu przypadkach.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const GATE_VERSION = readVersion();
