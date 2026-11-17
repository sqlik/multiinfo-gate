import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError } from '../../src/integrations/agent.ts';
import { callTool, visibleTools, type ToolContext, type ToolDef } from '../../src/mcp/tools.ts';
import { connectionStatusTool } from '../../src/mcp/tools/status.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, agentToolDeps, seedAgent } from '../helpers/agent.ts';
import { prepareSms, sendPrepared } from '../helpers/mcp.ts';

const NOW = new Date('2026-11-15T09:00:00Z');
let db: Database;
let key: Buffer;

beforeEach(() => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
});

function context(over: Partial<ToolContext> = {}): ToolContext {
  const seed = seedAgent(db, key, { scopes: ['send', 'read_sent'] });
  const deps = agentToolDeps(db, key, { now: () => NOW });
  const resolved = deps.connections.resolve(seed.connectionId, NOW);
  if (!resolved.ok) throw new Error(resolved.reason);
  return { connectionId: seed.connectionId, sessionId: null, conn: resolved.ctx, unavailable: null, apps: false, protocolVersion: '2025-11-25', deps, base: 'https://bramka.serwis.example', now: NOW, ...over };
}

describe('lista narzędzi', () => {
  it('schemat wejścia z zod z opisami pól, tytuł i adnotacje', () => {
    const [tool] = visibleTools([prepareSms], new Set(['send']), false);
    expect(tool).toEqual({
      name: 'prepare_sms', title: 'Przygotuj SMS', description: 'Sprawdza treść i numery, a następnie zapisuje szkic do podglądu.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, description: 'Treść SMS-a' } }, required: ['text'] },
      annotations: { title: 'Przygotuj SMS', readOnlyHint: false, openWorldHint: false },
    });
  });

  it('zakresy: narzędzie widoczne przy jednym z wymaganych zakresów, „każdy” zawsze, przy braku zakresów tylko „każdy”', () => {
    const names = (scopes: ReadonlySet<'send' | 'read_sent' | 'send_group'> | null) => visibleTools([connectionStatusTool, prepareSms, sendPrepared], scopes, false).map((t) => t.name);
    expect(names(new Set(['read_sent']))).toEqual(['connection_status']);
    expect(names(new Set(['send_group']))).toEqual(['connection_status', 'send_prepared']);
    expect(names(new Set(['send']))).toEqual(['connection_status', 'prepare_sms', 'send_prepared']);
    expect(names(null)).toEqual(['connection_status']);
  });

  it('widoki: resourceUri przy obsłudze widoków, visibility app dla narzędzia tylko dla widoku, bez widoków destructiveHint i brak _meta.ui', () => {
    const withApps = visibleTools([prepareSms, sendPrepared], new Set(['send']), true);
    expect(withApps[0]!._meta).toEqual({ ui: { resourceUri: 'ui://multiinfo-gate/co-moge' } });
    expect(withApps[1]!._meta).toEqual({ ui: { visibility: ['app'] } });
    const without = visibleTools([prepareSms, sendPrepared], new Set(['send']), false);
    expect(without.map((t) => t._meta)).toEqual([undefined, undefined]);
    expect(without[1]!.annotations).toEqual({ title: 'Wyślij przygotowany SMS', destructiveHint: true });
  });
});

describe('wywołanie narzędzia', () => {
  it('wynik z treścią tekstową i danymi strukturalnymi, wywołanie zapisuje ostatnie użycie połączenia', async () => {
    const ctx = context();
    expect(await callTool([prepareSms], ctx, 'prepare_sms', { text: 'Serwis jutro o 9:00' })).toEqual({
      content: [{ type: 'text', text: 'Szkic: Serwis jutro o 9:00' }], structuredContent: { draft: 'drf_1' },
    });
    expect(ctx.deps.connectionsRepo.get(ctx.connectionId)!.lastUsedAt).toBe(NOW.toISOString());
  });

  it('brak zakresu i niedostępna integracja: błąd narzędzia z powodem', async () => {
    const ctx = context();
    const denied = await callTool([prepareSms], { ...ctx, conn: { ...ctx.conn!, scopes: new Set(['read_sent']) } }, 'prepare_sms', { text: 'x' });
    expect(denied).toMatchObject({ isError: true });
    expect((denied.content as Array<{ text: string }>)[0]!.text).toBe('Zakresy integracji nie obejmują uprawnienia „Wysyłka SMS-ów”. Uprawnienia nadaje administrator bramki w integracji Agent AI.');
    const off = await callTool([prepareSms], { ...ctx, conn: null, unavailable: 'integracja jest wyłączona' }, 'prepare_sms', { text: 'x' });
    expect(off).toMatchObject({ isError: true });
    expect((off.content as Array<{ text: string }>)[0]!.text).toContain('integracja jest wyłączona');
  });

  it('błędne argumenty: błąd narzędzia z polem i opisem po polsku, nieznane narzędzie: błąd -32602', async () => {
    const ctx = context();
    const bad = await callTool([prepareSms], ctx, 'prepare_sms', { text: 5 });
    expect(bad).toEqual({ content: [{ type: 'text', text: 'Nieprawidłowe argumenty narzędzia. text: Wartość musi być tekstem.' }], isError: true });
    await expect(callTool([prepareSms], ctx, 'nieznane', {})).rejects.toMatchObject({ code: -32602 });
  });

  it('odmowa limitu żądań klucza: structuredContent rate_limited z retryAfterSec 60', async () => {
    const ctx = context();
    const limited = { ...ctx, conn: { ...ctx.conn!, key: { ...ctx.conn!.key, ratePerMin: 2 } } };
    for (let n = 0; n < 2; n += 1) expect((await callTool([prepareSms], limited, 'prepare_sms', { text: 'x' })).isError).toBeUndefined();
    // Widok pliku po odmowie czeka retryAfterSec i ponawia tę samą porcję wierszy (P7).
    expect(await callTool([prepareSms], limited, 'prepare_sms', { text: 'x' })).toEqual({
      content: [{ type: 'text', text: 'Przekroczono limit 2 żądań na minutę klucza. Spróbuj ponownie za minutę.' }],
      structuredContent: { error: 'rate_limited', retryAfterSec: 60 }, isError: true,
    });
  });

  it('AgentError: komunikat dla człowieka z czasem ponowienia; inny wyjątek: wpis mcp.wyjatek bez argumentów i błąd wewnętrzny', async () => {
    const error = vi.fn();
    const ctx = context();
    ctx.deps.log = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const limit: ToolDef = { ...prepareSms, name: 'limit', run: () => { throw new AgentError('throttled', 'Wyczerpano limit wysyłek integracji.', 125); } };
    const broken: ToolDef = { ...prepareSms, name: 'broken', run: () => { throw new Error('awaria'); } };
    expect(await callTool([limit], ctx, 'limit', { text: '48601000011' })).toEqual({
      content: [{ type: 'text', text: 'Wyczerpano limit wysyłek integracji. Spróbuj ponownie za 3 min.' }],
      structuredContent: { error: 'throttled', retryAfterSec: 125 }, isError: true,
    });
    expect(await callTool([broken], ctx, 'broken', { text: '48601000011' })).toEqual({ content: [{ type: 'text', text: 'Błąd wewnętrzny bramki.' }], isError: true });
    expect(error).toHaveBeenCalledWith('mcp.wyjatek', expect.objectContaining({ tool: 'broken', connectionId: ctx.connectionId }));
    expect(JSON.stringify(error.mock.calls)).not.toContain('48601000011');
  });
});

describe('connection_status', () => {
  it('connection_status pokazuje zakresy z etykietami i ważność połączenia', async () => {
    const ctx = context();
    const result = await callTool([connectionStatusTool], ctx, 'connection_status', {});
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('Połączenie: Ewa Nowak, integracja Agent AI - dyspozytornia.');
    expect(text).toContain('Uprawnienia: Wysyłka SMS-ów, Odczyt wysłanych.');
    expect(text).toContain('Połączenie jest ważne do 2027-02-13 09:00:00 czasu polskiego.');
    expect(text).toContain('Usługi Multiinfo: 24138.');
    expect(text).toContain('Nadawca domyślny: numer usługi 24138.');
    expect(text).toContain('Limit żądań klucza: 60 na minutę.');
    expect(result.structuredContent).toMatchObject({
      available: true, connection: 'Ewa Nowak', integration: 'Agent AI - dyspozytornia',
      scopes: [{ id: 'send', label: 'Wysyłka SMS-ów' }, { id: 'read_sent', label: 'Odczyt wysłanych' }],
      expiresAt: new Date(AGENT_SEED_AT.getTime() + 90 * 86_400_000).toISOString(),
      services: [{ id: '24138', label: null }], senders: [{ value: null, label: 'numer usługi 24138' }], orig: null, maxParts: 3, overflow: 'reject', ratePerMin: 60,
      guard: { calls: 0, callLimit: 30, recipients: 0, recipientLimit: 1000, windowMinutes: 60, resetsAt: null }, groups: 0,
    });
  });

  it('niedostępna integracja: nazwa połączenia i powód', async () => {
    const ctx = context();
    const result = await callTool([connectionStatusTool], { ...ctx, conn: null, unavailable: 'integracja jest wyłączona' }, 'connection_status', {});
    expect(result.isError).toBeUndefined();
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('Połączenie: Ewa Nowak, integracja Agent AI - dyspozytornia.');
    expect(text).toContain('Połączenie jest chwilowo niedostępne: integracja jest wyłączona.');
    expect(result.structuredContent).toMatchObject({ available: false, reason: 'integracja jest wyłączona' });
  });
});
