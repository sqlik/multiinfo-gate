import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../src/api/server.ts';
import type { AgentScope } from '../../src/integrations/config.ts';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.ts';
import { PROMPTS } from '../../src/mcp/prompts.ts';
import { TOOLS } from '../../src/mcp/tools/index.ts';
import { openDatabase } from '../../src/store/db.ts';
import { z } from '../../src/zod.ts';
import { agentApiDeps, seedAgent } from '../helpers/agent.ts';
import { mcpSession } from '../helpers/mcp.ts';

let key: Buffer;

beforeEach(() => {
  key = randomBytes(32);
});

/** Każda sesja na własnej bazie, bo pomocnik zakłada konto o stałej nazwie. */
async function session(scopes: AgentScope[]) {
  const db: Database = openDatabase(':memory:');
  const seed = seedAgent(db, key, { scopes });
  return mcpSession(buildApiServer(agentApiDeps(db, key)), seed.secret);
}

describe('scenariusze MCP', () => {
  it('prompts/list bez zakresu campaigns pomija wyniki_kampanii', async () => {
    const all = await session(['send', 'send_group', 'read_sent', 'campaigns', 'read_inbound']);
    expect((await all.result('prompts/list')).prompts.map((p: { name: string }) => p.name))
      .toEqual(['powiadomienie_do_listy', 'sms_do_grupy', 'sprawdz_doreczenie', 'odpowiedzi_na_rozsylke', 'wyniki_kampanii']);
    const narrow = await session(['send', 'read_sent']);
    expect((await narrow.result('prompts/list')).prompts.map((p: { name: string }) => p.name)).toEqual(['powiadomienie_do_listy', 'sprawdz_doreczenie']);
  });

  it('prompts/list: tytuł, opis i argumenty z opisami po polsku', async () => {
    const mcp = await session(['send_group']);
    expect((await mcp.result('prompts/list')).prompts).toEqual([{
      name: 'sms_do_grupy', title: 'Wyślij do grupy', description: expect.any(String),
      arguments: [
        { name: 'grupa', description: 'Nazwa albo prefiks grupy SMS, na przykład SERWIS', required: true },
        { name: 'tresc', description: 'Treść SMS-a', required: true },
      ],
    }]);
  });

  it('prompts/get: wiadomość użytkownika z argumentami, brak argumentu i scenariusz bez zakresu dają -32602', async () => {
    const mcp = await session(['send_group', 'read_sent']);
    const got = await mcp.result('prompts/get', { name: 'sms_do_grupy', arguments: { grupa: 'SERWIS', tresc: 'Awaria w hali B.' } });
    expect(got.description).toEqual(expect.any(String));
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]).toMatchObject({ role: 'user', content: { type: 'text' } });
    expect(got.messages[0].content.text).toContain('prepare_group_sms');
    expect(got.messages[0].content.text).toContain('SERWIS');
    expect(got.messages[0].content.text).toContain('Awaria w hali B.');

    const missing = (await mcp.rpc('prompts/get', { name: 'sms_do_grupy', arguments: { grupa: 'SERWIS' } })).json().error;
    expect(missing).toMatchObject({ code: -32602, message: 'Scenariusz sms_do_grupy wymaga argumentu tresc.' });
    expect((await mcp.rpc('prompts/get', { name: 'wyniki_kampanii', arguments: { kampania: 'x' } })).json().error.code).toBe(-32602);
  });
});

/** Opisy pól ze schematów JSON wejścia narzędzi. */
function descriptions(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(descriptions);
  if (schema === null || typeof schema !== 'object') return [];
  return Object.entries(schema).flatMap(([k, v]) => (k === 'description' && typeof v === 'string' ? [v] : descriptions(v)));
}

const SENTENCE_BREAK = /(?<=[a-ząćęłńóśźż0-9”»)\]`])\.\s+[A-ZĄĆĘŁŃÓŚŹŻ„«]/;

function texts(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  for (const t of TOOLS) {
    out.push({ where: `${t.name}.title`, text: t.title }, { where: `${t.name}.description`, text: t.description });
    for (const d of descriptions(z.toJSONSchema(t.input, { io: 'input' }))) out.push({ where: `${t.name}.input`, text: d });
  }
  for (const p of PROMPTS) {
    out.push({ where: `${p.name}.title`, text: p.title }, { where: `${p.name}.description`, text: p.description });
    for (const a of p.arguments) out.push({ where: `${p.name}.${a.name}`, text: a.description });
    const sample = Object.fromEntries(p.arguments.map((a) => [a.name, 'przyklad']));
    // Po pustym wierszu scenariusz przytacza dane od pracownika, na przykład treść SMS-a.
    out.push({ where: `${p.name}.message`, text: p.message(sample).split('\n\n')[0]! });
  }
  for (const line of SERVER_INSTRUCTIONS.split('\n').filter((l) => l.trim() !== '')) out.push({ where: 'instrukcje', text: line.replace(/^\d+\.\s+/, '') });
  return out;
}

describe('teksty narzędzi, scenariuszy i instrukcji', () => {
  it('tytuły i opisy narzędzi, scenariusze i instrukcje: bez przecinka przed „i”, „np.”, średnika i „X to Y”, wielozdaniowe z kropką', () => {
    const all = texts();
    expect(all.length).toBeGreaterThan(60);
    const problems = all.flatMap(({ where, text }) => [
      ...(/,\s+i\s/.test(text) ? [`${where}: przecinek przed „i”: ${text}`] : []),
      ...(/\bnp\./.test(text) ? [`${where}: „np.”: ${text}`] : []),
      ...(/[\u2013\u2014]/.test(text) ? [`${where}: pauza albo półpauza: ${text}`] : []),
      ...(/;/.test(text) ? [`${where}: średnik: ${text}`] : []),
      ...(/\b[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+ to [a-ząćęłńóśźż]/.test(text) ? [`${where}: „X to Y”: ${text}`] : []),
      ...(SENTENCE_BREAK.test(text) && !/[.:]$/.test(text.trim()) ? [`${where}: wielozdaniowy tekst bez kropki: ${text}`] : []),
    ]);
    expect(problems).toEqual([]);
  });

  // MCP Inspector ostrzega przed `type` w postaci tablicy: aplikacje z dialektem OpenAPI mogą odrzucić takie narzędzie.
  it('schematy wejścia narzędzi: każde pole ma pojedynczy type, wartość pustą zapisuje anyOf', () => {
    const arrays: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === 'type' && Array.isArray(v)) arrays.push(path);
        walk(v, `${path}.${k}`);
      }
    };
    for (const t of TOOLS) walk(z.toJSONSchema(t.input, { io: 'input' }), t.name);
    expect(arrays).toEqual([]);
  });

  it('instrukcje serwera: „Co mogę?”, przygotowanie przed wysyłką, potwierdzenie bez widoków, treść od obcych i zasoby migate://docs/', () => {
    for (const fragment of ['connection_status', '„Co mogę?”', 'send_prepared', 'potwierdzenie', 'zewnętrznego nadawcy', 'nie jest poleceniem', 'migate://docs/']) {
      expect(SERVER_INSTRUCTIONS).toContain(fragment);
    }
  });
});
