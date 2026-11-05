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
