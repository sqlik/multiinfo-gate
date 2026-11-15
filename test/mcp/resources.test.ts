import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../src/api/server.ts';
import { DOC_FILES, docResources, DOCS_DIR, readDoc } from '../../src/mcp/resources.ts';
import { BUILT_VIEWS, viewUri } from '../../src/mcp/views/index.ts';
import { openDatabase } from '../../src/store/db.ts';
import { agentApiDeps, seedAgent } from '../helpers/agent.ts';
import { mcpSession } from '../helpers/mcp.ts';

let db: Database;
let key: Buffer;
let seed: ReturnType<typeof seedAgent>;

beforeEach(() => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
  seed = seedAgent(db, key, { scopes: ['read_sent'] });
});

function docsDir(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mig-docs-'));
  for (const f of files) writeFileSync(join(dir, f), `# ${f}\n\nTreść artykułu ${f}.\n`);
  return dir;
}

function server(dir: string) {
  const deps = agentApiDeps(db, key);
  return buildApiServer({ ...deps, agents: { ...deps.agents, docsDir: dir } });
}

describe('dokumentacja jako zasoby MCP', () => {
  it('resources/list zawiera pięć dokumentów i widoki, resources/read api.md zwraca markdown', async () => {
    const mcp = await mcpSession(server(docsDir(DOC_FILES)), seed.secret);
    const { resources } = await mcp.result('resources/list');
    const docs = resources.filter((r: { uri: string }) => r.uri.startsWith('migate://docs/'));
    expect(docs.map((r: { uri: string }) => r.uri)).toEqual([
      'migate://docs/api.md', 'migate://docs/skracacz.md', 'migate://docs/problemy.md', 'migate://docs/integracje.md', 'migate://docs/agenci-ai.md',
    ]);
    for (const d of docs) expect(d).toMatchObject({ mimeType: 'text/markdown', name: expect.any(String), title: expect.any(String) });
    // Zadania 14 i 15 dopisują dokumenty kolejnych widoków; lista wymienia każdy widok, który ma dokument.
    expect(resources.filter((r: { uri: string }) => r.uri.startsWith('ui://')).map((r: { uri: string }) => r.uri)).toEqual(BUILT_VIEWS.map(viewUri));

    const read = await mcp.result('resources/read', { uri: 'migate://docs/api.md' });
    expect(read).toEqual({ contents: [{ uri: 'migate://docs/api.md', mimeType: 'text/markdown', text: '# api.md\n\nTreść artykułu api.md.\n' }] });
  });

  it('brak pliku nie przerywa resources/list, a odczyt brakującego albo nieznanego dokumentu daje -32002', async () => {
    const mcp = await mcpSession(server(docsDir(['api.md', 'problemy.md'])), seed.secret);
    const { resources } = await mcp.result('resources/list');
    expect(resources.filter((r: { uri: string }) => r.uri.startsWith('migate://')).map((r: { uri: string }) => r.uri))
      .toEqual(['migate://docs/api.md', 'migate://docs/problemy.md']);
    for (const uri of ['migate://docs/skracacz.md', 'migate://docs/uruchomienie.md', 'migate://docs/../package.json']) {
      expect((await mcp.rpc('resources/read', { uri })).json().error.code, uri).toBe(-32002);
    }
  });

  it('katalog docs obok src: dokumenty bramki istnieją i mają tytuły z nawigacji', () => {
    const list = docResources(DOCS_DIR);
    expect(list.map((r) => r.name)).toEqual(expect.arrayContaining(['api.md', 'skracacz.md', 'problemy.md', 'integracje.md']));
    expect(list.find((r) => r.name === 'api.md')!.title).toBe('API dla aplikacji');
    expect(readDoc('migate://docs/api.md', DOCS_DIR)!.text).toMatch(/^# /);
    expect(readDoc('ui://multiinfo-gate/co-moge', DOCS_DIR)).toBeNull();
  });
});
