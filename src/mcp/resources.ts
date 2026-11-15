import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dokumentacja bramki w wersji zainstalowanej jako zasoby MCP. Katalog `docs` leży obok `src` w repozytorium
 * i w instalacji LXC z archiwum wydania oraz obok `dist` w obrazie Dockera.
 */
export const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../docs');

/** Artykuły udostępniane agentom, z tytułami z nawigacji dokumentacji. */
const DOCS = {
  'api.md': 'API dla aplikacji',
  'skracacz.md': 'Skracacz linków i kampanie',
  'problemy.md': 'Rozwiązywanie problemów',
  'integracje.md': 'Integracje z aplikacjami',
  'agenci-ai.md': 'Agenci AI',
} as const;

type DocFile = keyof typeof DOCS;
export const DOC_FILES = Object.keys(DOCS) as DocFile[];
export const DOC_MIME = 'text/markdown';

const docUri = (file: DocFile): string => `migate://docs/${file}`;

function readText(dir: string, file: DocFile): string | null {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return null;
  }
}

/** Zasoby `resources/list`: wyłącznie artykuły, które istnieją. Brak pliku nie przerywa listy. */
export function docResources(dir: string = DOCS_DIR): Array<{ uri: string; name: string; title: string; mimeType: string }> {
  return DOC_FILES.filter((file) => existsSync(join(dir, file))).map((file) => ({ uri: docUri(file), name: file, title: DOCS[file], mimeType: DOC_MIME }));
}

/** Treść artykułu o adresie z listy; adres spoza listy i brakujący plik dają `null`. */
export function readDoc(uri: unknown, dir: string = DOCS_DIR): { uri: string; mimeType: string; text: string } | null {
  const file = DOC_FILES.find((f) => docUri(f) === uri);
  if (file === undefined) return null;
  const text = readText(dir, file);
  return text === null ? null : { uri: docUri(file), mimeType: DOC_MIME, text };
}
