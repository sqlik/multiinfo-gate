import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROBLEM_ANCHORS } from '../src/docs-links.ts';

const article = readFileSync('docs/problemy.md', 'utf8');
const anchors = [...article.matchAll(/\{#([a-z0-9-]+)\}/g)].map((m) => m[1]);

describe('kotwice artykułu Rozwiązywanie problemów', () => {
  it('artykuł ma dokładnie te punkty, do których odsyłają panel i dziennik', () => {
    expect([...anchors].sort()).toEqual([...PROBLEM_ANCHORS].sort());
  });

  it('odnośniki do punktów artykułu w dokumentacji prowadzą do istniejących kotwic', () => {
    for (const file of ['docs/uruchomienie.md', 'docs/api.md', 'docs/index.md', 'docs/problemy.md']) {
      const text = readFileSync(file, 'utf8');
      const targets = [...text.matchAll(/problemy\.md#([a-z0-9-]+)/g), ...(file.endsWith('problemy.md') ? text.matchAll(/\]\(#([a-z0-9-]+)\)/g) : [])].map((m) => m[1]);
      for (const t of targets) expect(anchors, `${file} → #${t}`).toContain(t);
    }
  });
});

describe('artykuł Skracacz linków', () => {
  const sources = execSync('git ls-files src', { encoding: 'utf8' }).trim().split('\n').filter((f) => f.endsWith('.ts'));
  const fromPanel = sources.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\$\{LINKS_DOCS_URL\}#([a-z0-9-]+)/g)].map((m) => m[1]));
  const docs = ['docs/uruchomienie.md', 'docs/api.md', 'docs/index.md', 'docs/problemy.md', 'docs/integracje.md', 'docs/power-automate.md'];
  const fromDocs = docs.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/skracacz\.md#([a-z0-9-]+)/g)].map((m) => m[1]));

  it('jest w nawigacji dokumentacji', () => {
    expect(readFileSync('mkdocs.yml', 'utf8')).toMatch(/^\s+- [^:\n]+: skracacz\.md$/m);
  });

  it('ma kotwice, do których odsyłają panel i pozostałe artykuły', () => {
    const own = [...readFileSync('docs/skracacz.md', 'utf8').matchAll(/\{#([a-z0-9-]+)\}/g)].map((m) => m[1]);
    expect(fromPanel).toContain('obowiazkowa-lista-domen-docelowych');
    for (const t of [...fromPanel, ...fromDocs]) expect(own, `skracacz.md#${t}`).toContain(t);
  });
});
