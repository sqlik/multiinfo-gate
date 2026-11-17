import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONVERSATION_MAX, CONVERSATION_WINDOW_MS, conversation } from '../../src/agents/conversation.ts';
import type { ConnectionContext } from '../../src/agents/connections.ts';
import { AgentError } from '../../src/integrations/agent.ts';
import { defaultInboundConfig } from '../../src/integrations/config.ts';
import type { AgentConfig } from '../../src/integrations/config.ts';
import type { AgentToolDeps } from '../../src/mcp/tools.ts';
import { openDatabase } from '../../src/store/db.ts';
import type { InboundKind } from '../../src/store/inbound-messages.ts';
import type { MessageInput } from '../../src/store/messages.ts';
import { AGENT_SEED_AT, agentToolDeps, seedAgent } from '../helpers/agent.ts';

/** 2026-11-15 10:00 w Polsce. */
const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const CLIENT = '48601000011';

let db: Database;
let key: Buffer;
let seed: ReturnType<typeof seedAgent>;
let deps: AgentToolDeps;

function setup(scopes: AgentConfig['scopes']): void {
  seed = seedAgent(db, key, { scopes });
  deps = agentToolDeps(db, key, { now: () => NOW });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
});

function ctx(): ConnectionContext {
  const resolved = deps.connections.resolve(seed.connectionId, NOW);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.ctx;
}

function message(id: string, offsetMs: number, over: Partial<MessageInput> = {}): void {
  deps.messages.insert({
    id, apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', dest: CLIENT,
    body: `Wiadomość ${id}`, bodyHash: 'h', encoding: 'gsm', parts: 1, slots: 40,
    orig: null, costCenter: null, validTo: null, idempotencyKey: null, createdAt: at(offsetMs), ...over,
  });
}

function inbound(id: string, offsetMs: number, over: { sender?: string; serviceId?: string; system?: 0 | 1; body?: string | null; kind?: InboundKind } = {}): void {
  deps.inbound.insertIfNew({
    id, accountId: seed.accountId, serviceId: over.serviceId ?? '24138', miId: id, sender: over.sender ?? CLIENT, dest: '24138', kind: over.kind ?? 'text',
    body: over.body === undefined ? `SMS ${id}` : over.body, bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null,
    receivedAt: at(offsetMs), createdAt: at(offsetMs), system: over.system ?? 0,
  });
}

function pkg(id: string, dests: string[], offsetMs: number): void {
  deps.packages.insert({
    id, apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', defaultText: 'Przypomnienie o przeglądzie klimatyzacji.', orig: null,
    costCenter: null, startAt: null, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: at(offsetMs),
  }, dests.map((dest) => ({ dest, text: null, clientId: null })));
}

function agentError(fn: () => unknown): AgentError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  throw new Error('oczekiwano AgentError');
}

const ids = (data: { items: Array<{ id: string }> }) => data.items.map((i) => i.id);

describe('conversation', () => {
  it('rozmowa: odebrane i wysłane według czasu, okno 30 dni, najwyżej 100 pozycji, Wcześniejsze z before', () => {
    setup(['read_sent', 'read_inbound', 'reply']);
    message('msg_1', -3 * HOUR);
    inbound('in_a', -2 * HOUR);
    inbound('in_b', -HOUR);
    message('msg_2', -30 * MIN);
    message('msg_x', -20 * MIN, { dest: '48601000099' });
    inbound('in_x', -10 * MIN, { sender: '48601000099' });
    inbound('in_old', -31 * DAY);
    inbound('in_older', -100 * DAY);

    // Numer w dowolnym zapisie: bramka zapisuje go jak nadawcę odebranego SMS-a.
    const first = conversation(deps, ctx(), { phone: '+48 601 000 011' }, NOW);
    expect(first.phone).toBe(CLIENT);
    expect(ids(first)).toEqual(['msg_1', 'in_a', 'in_b', 'msg_2']);
    expect(first.items.map((i) => i.kind)).toEqual(['out', 'in', 'in', 'out']);
    expect(first.items[1]).toEqual({
      kind: 'in', id: 'in_a', at: { at: at(-2 * HOUR), local: expect.any(String) }, text: 'SMS in_a', stored: true,
      status: null, statusLabel: null, source: null, packageId: null,
    });
    expect(first.items[0]).toMatchObject({ kind: 'out', text: 'Wiadomość msg_1', stored: true, status: 'queued', statusLabel: 'w kolejce', source: 'API', packageId: null });
    expect(first).toMatchObject({ lastInboundId: 'in_b', sent: 'all', hasEarlier: true, earliest: at(-CONVERSATION_WINDOW_MS) });

    // „Wcześniejsze” sięga 30 dni przed najnowszym SMS-em sprzed okna, więc przerwa w rozmowie nie daje pustej strony.
    const earlier = conversation(deps, ctx(), { phone: CLIENT, before: first.earliest! }, NOW);
    expect(ids(earlier)).toEqual(['in_old']);
    expect(earlier.hasEarlier).toBe(true);
    const oldest = conversation(deps, ctx(), { phone: CLIENT, before: earlier.earliest! }, NOW);
    expect(ids(oldest)).toEqual(['in_older']);
    expect(oldest).toMatchObject({ hasEarlier: false, earliest: null, lastInboundId: 'in_older' });

    // Najwyżej 100 pozycji od najnowszej, a kolejne pokazuje „Wcześniejsze” od najstarszej pokazanej.
    for (let k = 1; k <= CONVERSATION_MAX + 5; k++) inbound(`in_${k}`, -k * MIN, { sender: '48601000022' });
    const full = conversation(deps, ctx(), { phone: '48601000022' }, NOW);
    expect(full.items).toHaveLength(CONVERSATION_MAX);
    expect(full.items[0]!.id).toBe(`in_${CONVERSATION_MAX}`);
    expect(full.items.at(-1)!.id).toBe('in_1');
    expect(full).toMatchObject({ hasEarlier: true, earliest: at(-CONVERSATION_MAX * MIN), lastInboundId: 'in_1' });
    const rest = conversation(deps, ctx(), { phone: '48601000022', before: full.earliest! }, NOW);
    expect(ids(rest)).toEqual(['in_105', 'in_104', 'in_103', 'in_102', 'in_101']);
    expect(rest.hasEarlier).toBe(false);
  });

  it('rozmowa po identyfikatorze odebranego SMS-a: numer z nadawcy, a sprzeczny numer albo brak obu daje błąd', () => {
    setup(['read_inbound']);
    inbound('in_a', -HOUR);
    expect(conversation(deps, ctx(), { inboundId: 'in_a' }, NOW)).toMatchObject({ phone: CLIENT, lastInboundId: 'in_a' });
    expect(conversation(deps, ctx(), { inboundId: 'in_a', phone: '601000011' }, NOW).phone).toBe(CLIENT);
    expect(agentError(() => conversation(deps, ctx(), { inboundId: 'in_a', phone: '48601000099' }, NOW)).code).toBe('invalid');
    expect(agentError(() => conversation(deps, ctx(), {}, NOW)).code).toBe('invalid');
    expect(agentError(() => conversation(deps, ctx(), { phone: 'abc' }, NOW)).code).toBe('invalid_phone');
    expect(agentError(() => conversation(deps, ctx(), { phone: CLIENT, before: 'wczoraj' }, NOW)).code).toBe('invalid');
  });

  it('bez read_sent: z wysłanych tylko odpowiedzi i wysyłka, na którą odpowiada pierwszy odebrany SMS', () => {
    setup(['read_inbound', 'reply']);
    pkg('pkg_1', ['48601000099', CLIENT], -3 * HOUR);
    inbound('in_a', -2 * HOUR);
    // Zwykła wiadomość po pierwszym odebranym: drugi SMS klienta odpowiada na nią, ale wysyłkę wyznacza pierwszy.
    message('msg_other', -90 * MIN);
    inbound('in_b', -HOUR);
    message('msg_reply', -30 * MIN, { inReplyTo: 'in_b' });

    const data = conversation(deps, ctx(), { phone: CLIENT }, NOW);
    expect(ids(data)).toEqual(['pkg_1#2', 'in_a', 'in_b', 'msg_reply']);
    expect(data.items[0]).toMatchObject({
      kind: 'out', packageId: 'pkg_1', text: 'Przypomnienie o przeglądzie klimatyzacji.', stored: true, status: 'pending', statusLabel: 'czeka na raport', source: 'API',
    });
    expect(data.sent).toBe('replies');

    // Pierwszy odebrany SMS odpowiada na wiadomość: rozmowa pokazuje ją, a rozsyłki już nie.
    message('msg_first', -150 * MIN);
    expect(ids(conversation(deps, ctx(), { phone: CLIENT }, NOW))).toEqual(['msg_first', 'in_a', 'in_b', 'msg_reply']);
  });

  it('z read_sent: także wiadomości z innych integracji klucza i odbiorcy rozsyłek na ten numer', () => {
    setup(['read_sent', 'read_inbound']);
    const hook = deps.integrations.insert({
      name: 'Zgłoszenia serwisowe', kind: 'webhook_in', apiKeyId: seed.keyId, serviceId: null, orig: null, preset: 'wlasny', enabled: 1,
      config: defaultInboundConfig(), secrets: {}, storePayloads: 0, createdAt: AGENT_SEED_AT,
    });
    const other = deps.apiKeys.insert({
      accountId: seed.accountId, name: 'inny', keyHash: 'h2', keyPrefix: 'p2', defaultServiceId: '24138', defaultOrig: null,
      maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
    });
    message('msg_hook', -4 * HOUR, { integrationId: hook });
    pkg('pkg_2', [CLIENT], -3 * HOUR);
    message('msg_other_key', -2 * HOUR, { apiKeyId: other });
    inbound('in_a', -HOUR);

    const data = conversation(deps, ctx(), { phone: CLIENT }, NOW);
    expect(ids(data)).toEqual(['msg_hook', 'pkg_2#1', 'in_a']);
    expect(data.items[0]!.source).toBe('integracja Zgłoszenia serwisowe');
    expect(data.items[1]).toMatchObject({ kind: 'out', packageId: 'pkg_2', status: 'pending' });
    expect(data.sent).toBe('all');
  });

  it('SMS systemowy i SMS z usługi spoza klucza niewidoczne', () => {
    setup(['read_sent', 'read_inbound']);
    inbound('in_a', -3 * HOUR);
    inbound('in_sys', -2 * HOUR, { system: 1 });
    inbound('in_svc', -90 * MIN, { serviceId: '99999' });
    message('msg_sys', -HOUR, { system: 1 });

    expect(ids(conversation(deps, ctx(), { phone: CLIENT }, NOW))).toEqual(['in_a']);
    for (const id of ['in_sys', 'in_svc', 'in_none']) {
      expect(agentError(() => conversation(deps, ctx(), { inboundId: id }, NOW)).code, id).toBe('inbound_unknown');
    }
  });

  it('konto bez przechowywania treści: pozycje z stored false', () => {
    setup(['read_sent', 'read_inbound']);
    inbound('in_a', -3 * HOUR, { body: null });
    message('msg_1', -2 * HOUR, { body: null });
    inbound('in_bin', -HOUR, { kind: 'binary', body: '0A0B' });

    const data = conversation(deps, ctx(), { phone: CLIENT }, NOW);
    expect(data.items.map((i) => [i.id, i.text, i.stored])).toEqual([['in_a', null, false], ['msg_1', null, false], ['in_bin', null, true]]);
  });

  it('stan odbiorcy rozsyłki przed raportem: rozsyłka zaplanowana albo anulowana podaje stan rozsyłki', () => {
    setup(['read_sent', 'read_inbound']);
    deps.packages.insert({
      id: 'pkg_s', apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', defaultText: 'Przegląd w czwartek.', orig: null,
      costCenter: null, startAt: at(DAY), deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: at(-HOUR), status: 'scheduled',
    }, [{ dest: CLIENT, text: null, clientId: null }]);
    expect(conversation(deps, ctx(), { phone: CLIENT }, NOW).items[0]).toMatchObject({ status: 'scheduled', statusLabel: 'zaplanowana' });
  });
});
