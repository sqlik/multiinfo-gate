import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Podpowiedzi i teksty pomocnicze panelu złożone z dwóch albo więcej zdań kończą się kropką,
// a jednozdaniowe nie mają kropki. Test czyta źródła widoków panelu i presetów integracji.
const ROOT = join(import.meta.dirname, '..', '..');
const DIRS = ['src/admin', 'src/integrations', 'src/links'];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return files(path);
    return e.name.endsWith('.ts') ? [path] : [];
  });
}

/** Wstawki `${…}` zamienia na znacznik, znaczniki HTML usuwa, a odstępy scala. */
function plain(text: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (depth === 0 && text.startsWith('${', i)) {
      depth = 1;
      i++;
      out += '«wstawka»';
      continue;
    }
    if (depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      continue;
    }
    out += text[i];
  }
  return out.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Skrót „np.” przed wielką literą nie kończy zdania: „np. Bearer 7f3a…” to jedno zdanie.
// Zdanie może kończyć się wstawką albo wyrażeniem Liquid i zaczynać wstawką: „Opcjonalny. «wstawka» Pusta…”.
const SENTENCE_BREAK = /(?<=[a-ząćęłńóśźż0-9”»)\]}`’])(?<!\bnp)(?<!\btzn)\.\s+[A-ZĄĆĘŁŃÓŚŹŻ„«]/;
const ELEMENT = /<(div|p|span|small|li)\b[^>]*class="[^"]*\b(hint|dim|note|notes|help-body|sub)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;
const LITERALS = String.raw`(?:'(?:[^'\\]|\\.)*'|\`(?:[^\`\\]|\\.)*\`)(?:\s*\+\s*(?:'(?:[^'\\]|\\.)*'|\`(?:[^\`\\]|\\.)*\`))*`;
const HINT_CALL = new RegExp(String.raw`\bhint\(\s*((?:[^()]|\([^()]*\))*?)\)`, 'g');
const GROUP = new RegExp(LITERALS, 'g');
const FIELD = new RegExp(String.raw`\b(?:hint|note|notes|help|description|lead)\s*:\s*(${LITERALS})`, 'g');
const LITERAL = /'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

const joined = (group: string) => [...group.matchAll(LITERAL)].map((m) => m[1] ?? m[2] ?? '').join('');

function texts(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  for (const file of DIRS.flatMap((d) => files(join(ROOT, d)))) {
    const src = readFileSync(file, 'utf8');
    const at = (index: number) => `${relative(ROOT, file)}:${src.slice(0, index).split('\n').length}`;
    for (const m of src.matchAll(ELEMENT)) out.push({ where: at(m.index), text: plain(m[3]!) });
    for (const m of src.matchAll(HINT_CALL)) {
      for (const g of m[1]!.matchAll(GROUP)) out.push({ where: at(m.index), text: plain(joined(g[0])) });
    }
    for (const m of src.matchAll(FIELD)) out.push({ where: at(m.index), text: plain(joined(m[1]!)) });
  }
  return out;
}

describe('podpowiedzi panelu', () => {
  const all = texts();
  const multi = all.filter((t) => SENTENCE_BREAK.test(t.text));

  it('skaner znajduje podpowiedzi wielozdaniowe w widokach i presetach', () => {
    expect(multi.length).toBeGreaterThan(100);
    expect(multi.some((t) => t.where.startsWith('src/admin/views/integration-mail.ts'))).toBe(true);
    expect(multi.some((t) => t.where.startsWith('src/integrations/presets/'))).toBe(true);
  });

  it('podpowiedź z dwóch albo więcej zdań kończy się kropką', () => {
    const bad = multi
      .filter((t) => !t.text.endsWith('«wstawka»'))
      .filter((t) => !/[.?!][”»]?$/.test(t.text))
      .map((t) => `${t.where} …${t.text.slice(-60)}`);
    expect(bad).toEqual([]);
  });

  it('podpowiedź z jednego zdania nie ma kropki na końcu', () => {
    const bad = all
      .filter((t) => t.text !== '' && !SENTENCE_BREAK.test(t.text))
      .filter((t) => /\.[”»]?$/.test(t.text) && !t.text.endsWith('…'))
      .map((t) => `${t.where} …${t.text.slice(-60)}`);
    expect(bad).toEqual([]);
  });
});
