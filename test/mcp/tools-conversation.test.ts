import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer, type ApiDeps } from '../../src/api/server.ts';
import type { AgentConfig } from '../../src/integrations/config.ts';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.ts';
import { SENT_NOTICE, UNTRUSTED_NOTICE } from '../../src/mcp/tools.ts';
import { CONVERSATION_MESSAGE } from '../../src/mcp/tools/conversation.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, agentApiDeps, seedAgent } from '../helpers/agent.ts';
import { mcpSession, textOf } from '../helpers/mcp.ts';

const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);
const HOUR = 3_600_000;
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const CLIENT = '48601000011';

let db: Database;
let key: Buffer;
let seed: ReturnType<typeof seedAgent>;
let deps: ApiDeps;
let app: FastifyInstance;

function setup(scopes: AgentConfig['scopes']): void {
  seed = seedAgent(db, key, { scopes });
  deps = agentApiDeps(db, key, { now: () => NOW });
  app = buildApiServer(deps);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
});

function inbound(id: string, offsetMs: number, body: string | null = 'Czy serwisant może przyjechać jutro rano?'): void {
  deps.inbound.insertIfNew({
    id, accountId: seed.accountId, serviceId: '24138', miId: id, sender: CLIENT, dest: '24138', kind: 'text', body, bodyHash: 'h', protocolId: 0,
    codingScheme: 0, connectorId: null, relatedMessageId: null, receivedAt: at(offsetMs), createdAt: at(offsetMs), system: 0,
  });
}

function message(id: string, offsetMs: number, body: string | null = 'Przegląd klimatyzacji w czwartek o 9:00.'): void {
  deps.messages.insert({
    id, apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', dest: CLIENT, body, bodyHash: 'h', encoding: 'gsm', parts: 1, slots: 40,
    orig: null, costCenter: null, validTo: null, idempotencyKey: null, createdAt: at(offsetMs),
  });
}

describe('narzędzie conversation', () => {
  it('conversation: tekst rozmowy dla agenta, wysłane ze znacznikiem, treść nieprzechowywana i wynik dla widoku', async () => {
    setup(['read_sent', 'read_inbound']);
    message('msg_1', -3 * HOUR);
    inbound('in_a', -2 * HOUR);
    message('msg_2', -HOUR, null);
    const result = await (await mcpSession(app, seed.secret)).call('conversation', { phone: CLIENT });
    expect(result.isError).toBeUndefined();
    expect(textOf(result).split('\n')).toEqual([
      `Rozmowa z numerem ${CLIENT}: 3 pozycje z ostatnich 30 dni, od najstarszej.`,
      'Wiadomość msg_1 do klienta, utworzona 15.11.2026 07:00, w kolejce, źródło: API:',
      `${SENT_NOTICE} Przegląd klimatyzacji w czwartek o 9:00.`,
      'SMS in_a od klienta, odebrany 15.11.2026 08:00:',
      `${UNTRUSTED_NOTICE} Czy serwisant może przyjechać jutro rano?`,
      'Wiadomość msg_2 do klienta, utworzona 15.11.2026 09:00, w kolejce, źródło: API:',
      'Treść nie jest przechowywana.',
    ]);
    const data = result.structuredContent!;
    expect(data).toMatchObject({ phone: CLIENT, hasEarlier: false, earliest: null, lastInboundId: 'in_a', sent: 'all', canReply: false });
    expect(data.items.map((i: { id: string }) => i.id)).toEqual(['msg_1', 'in_a', 'msg_2']);
    expect(data.items[0]).toMatchObject({ untrusted: true, notice: SENT_NOTICE });
    expect(data.items[1]).toMatchObject({ untrusted: true, notice: UNTRUSTED_NOTICE });
    expect(data.items[2]).not.toHaveProperty('untrusted');
  });

  it('conversation: rozsyłka z terminem opisana terminem, rozsyłka bez terminu chwilą przyjęcia', async () => {
    setup(['read_sent', 'read_inbound']);
    const pkg = (id: string, startAt: string | null, createdAt: string) => deps.packages.insert({
      id, apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', defaultText: 'Przegląd klimatyzacji jutro o 9:00.', orig: null,
      costCenter: null, startAt, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt, status: startAt === null ? 'queued' : 'scheduled',
    }, [{ dest: CLIENT, text: null, clientId: null }]);
    pkg('pkg_teraz', null, at(-2 * HOUR));
    pkg('pkg_jutro', at(24 * HOUR), at(-HOUR));
    const lines = textOf(await (await mcpSession(app, seed.secret)).call('conversation', { phone: CLIENT })).split('\n');
    expect(lines).toContain('Rozsyłka pkg_teraz do klienta, przyjęta 15.11.2026 08:00, czeka na raport, źródło: API:');
    expect(lines).toContain('Rozsyłka pkg_jutro do klienta, termin 16.11.2026 10:00, zaplanowana, źródło: API:');
  });

  it('conversation bez read_sent zapowiada zawężenie wysłanych, a „Wcześniejsze” wskazuje pole before', async () => {
    setup(['read_inbound']);
    inbound('in_old', -40 * 86_400_000);
    inbound('in_a', -HOUR);
    const mcp = await mcpSession(app, seed.secret);
    const result = await mcp.call('conversation', { inboundId: 'in_a' });
    const lines = textOf(result).split('\n');
    expect(lines).toContain('Z wysłanych wiadomości rozmowa obejmuje wyłącznie odpowiedzi i wysyłkę, na którą odpowiada pierwszy SMS klienta, '
      + 'ponieważ połączenie nie otrzymało uprawnienia „Odczyt wysłanych”.');
    expect(lines).toContain(`Wcześniejsze SMS-y pokazuje wywołanie conversation z polem before równym ${result.structuredContent!.earliest}.`);
    expect(lines.at(-1)).toBe(`Wcześniejsze SMS-y pokazuje wywołanie conversation z polem before równym ${result.structuredContent!.earliest}.`);
    const earlier = await mcp.call('conversation', { phone: CLIENT, before: result.structuredContent!.earliest });
    expect(earlier.structuredContent!.items.map((i: { id: string }) => i.id)).toEqual(['in_old']);
    // Strona wcześniejszych SMS-ów nie twierdzi, że obejmuje ostatnie 30 dni.
    expect(textOf(earlier).split('\n')[0]).toBe(`Rozmowa z numerem ${CLIENT}: 1 pozycja sprzed 16.10.2026 11:00, od najstarszej.`);
  });

  it('conversation z numerem krótkim: rozmowa bez możliwości odpowiedzi, ponieważ bramka nie wyśle SMS-a na numer krótki', async () => {
    setup(['read_inbound', 'reply']);
    deps.inbound.insertIfNew({
      id: 'in_k', accountId: seed.accountId, serviceId: '24138', miId: 'in_k', sender: '8080', dest: '24138', kind: 'text', body: 'START', bodyHash: 'h', protocolId: 0,
      codingScheme: 0, connectorId: null, relatedMessageId: null, receivedAt: at(-HOUR), createdAt: at(-HOUR), system: 0,
    });
    const mcp = await mcpSession(app, seed.secret);
    const first = await mcp.call('conversation', { inboundId: 'in_k' });
    expect(first.structuredContent).toMatchObject({ phone: '8080', canReply: false });
    const again = await mcp.call('conversation', { phone: '8080' });
    expect(again.isError).toBeUndefined();
    expect(again.structuredContent).toMatchObject({ phone: '8080', canReply: false });
  });

  it('conversation bez SMS-ów i z nieznanym odebranym SMS-em', async () => {
    setup(['read_inbound']);
    const mcp = await mcpSession(app, seed.secret);
    expect(textOf(await mcp.call('conversation', { phone: CLIENT })))
      .toBe(`Bramka nie znalazła SMS-ów w rozmowie z numerem ${CLIENT} w ostatnich 30 dniach.`);
    expect(await mcp.call('conversation', { inboundId: 'in_brak' })).toMatchObject({ isError: true, structuredContent: { error: 'inbound_unknown' } });
  });

  it('narzędzia rozmowy według zakresów: conversation przy read_inbound, prepare_conversation_reply przy reply, oba z widokiem rozmowy', async () => {
    setup(['read_inbound']);
    const tools = await (await mcpSession(app, seed.secret, { apps: true })).tools();
    expect(tools.map((t) => t.name)).toEqual(['connection_status', 'list_inbound', 'conversation']);
    const conv = tools.find((t) => t.name === 'conversation')!;
    expect(conv.title).toBe('Rozmowa z numerem');
    expect(conv.annotations.readOnlyHint).toBe(true);
    expect(conv._meta).toEqual({ ui: { resourceUri: 'ui://multiinfo-gate/rozmowa' } });

    db = openDatabase(':memory:');
    setup(['read_inbound', 'reply']);
    const all = await (await mcpSession(app, seed.secret, { apps: true })).tools();
    expect(all.map((t) => t.name)).toEqual(['connection_status', 'list_inbound', 'conversation', 'prepare_replies', 'prepare_conversation_reply', 'send_reply']);
    const reply = all.find((t) => t.name === 'prepare_conversation_reply')!;
    expect(reply._meta).toEqual({ ui: { resourceUri: 'ui://multiinfo-gate/rozmowa' } });
    expect(reply.annotations.readOnlyHint).toBe(true);
  });

  it('stała wiadomość widoku i instrukcje serwera o rozmowie', () => {
    expect(CONVERSATION_MESSAGE).toBe('Klient odpisał w rozmowie w widoku bramki. Przygotuj odpowiedź na jego ostatni SMS.');
    expect(SERVER_INSTRUCTIONS).toContain('Rozmowę z jednym numerem pokazuje narzędzie conversation');
    expect(SERVER_INSTRUCTIONS).toContain('„Klient odpisał w rozmowie w widoku bramki”');
  });

  it('connection_status: rozmowa przy odczycie odebranych, odpowiedź w rozmowie przy odpowiedzi nadawcy', async () => {
    setup(['read_inbound', 'reply']);
    const status = await (await mcpSession(app, seed.secret)).call('connection_status', {});
    expect(textOf(status)).toContain('Rozmowę z jednym numerem z ostatnich 30 dni pokazuje narzędzie conversation. '
      + 'Odpowiedź w rozmowie przygotowuje narzędzie prepare_conversation_reply.');
    expect(status.structuredContent).toMatchObject({ conversation: { days: 30, max: 100, reply: true } });
    db = openDatabase(':memory:');
    setup(['send']);
    expect((await (await mcpSession(app, seed.secret)).call('connection_status', {})).structuredContent).toMatchObject({ conversation: null });
  });
});

describe('narzędzie prepare_conversation_reply', () => {
  it('prepare_conversation_reply: szkic do nadawcy, wynik z historią i szkicem, klucz potwierdzenia tylko w _meta', async () => {
    setup(['read_inbound', 'reply']);
    inbound('in_a', -2 * HOUR, 'Dzień dobry, kiedy przyjedzie serwisant?');
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    const result = await mcp.call('prepare_conversation_reply', { inboundId: 'in_a', text: 'Serwisant przyjedzie jutro o 9:00.' });
    expect(result.isError).toBeUndefined();
    const data = result.structuredContent!;
    expect(data.draft).toMatchObject({ inboundId: 'in_a', to: CLIENT, group: 'rozmowa', text: 'Serwisant przyjedzie jutro o 9:00.', parts: 1 });
    expect(data).toMatchObject({ phone: CLIENT, lastInboundId: 'in_a', canReply: true });
    expect(data.items.map((i: { id: string }) => i.id)).toEqual(['in_a']);
    const confirm = result._meta!.confirm as string;
    expect(confirm).toMatch(/.{16,}/);
    expect(JSON.stringify({ content: result.content, structured: data })).not.toContain(confirm);
    const lines = textOf(result).split('\n');
    expect(lines).toContain(`${UNTRUSTED_NOTICE} Dzień dobry, kiedy przyjedzie serwisant?`);
    expect(lines).toContain(`Szkic ${data.draft.draftId}, odpowiedź do ${CLIENT}, 1 część: Serwisant przyjedzie jutro o 9:00.`);
    expect(lines.at(-1)).toBe('Odpowiedź zatwierdza człowiek przyciskiem „Wyślij odpowiedź” w widoku rozmowy. Nic nie zostało wysłane.');

    // Wysyłka bez zmian: send_reply z kluczem potwierdzenia, a wysłana odpowiedź pojawia się w rozmowie.
    const sent = await mcp.call('send_reply', { draftId: data.draft.draftId, confirm });
    expect(sent.isError).toBeUndefined();
    const after = await mcp.call('conversation', { phone: CLIENT });
    expect(after.structuredContent!.items.map((i: { kind: string }) => i.kind)).toEqual(['in', 'out']);
    expect(deps.messages.get(after.structuredContent!.items[1].id)!.inReplyTo).toBe('in_a');
  });

  it('prepare_conversation_reply bez widoków: bez klucza potwierdzenia, agent pyta człowieka przed send_reply', async () => {
    setup(['read_inbound', 'reply']);
    inbound('in_a', -HOUR);
    const result = await (await mcpSession(app, seed.secret)).call('prepare_conversation_reply', { inboundId: 'in_a', text: 'Tak, jutro o 9:00.' });
    expect(result._meta).toBeUndefined();
    expect(textOf(result).split('\n').at(-1))
      .toBe('Pokaż użytkownikowi odpowiedź, a po wyraźnym potwierdzeniu wywołaj send_reply ze szkicem. Nic nie zostało wysłane.');
    expect(await (await mcpSession(app, seed.secret)).call('prepare_conversation_reply', { inboundId: 'in_brak', text: 'Tak.' }))
      .toMatchObject({ isError: true, structuredContent: { error: 'inbound_unknown' } });
  });
});
