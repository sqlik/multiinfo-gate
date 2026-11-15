import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer, type ApiDeps } from '../../src/api/server.ts';
import { defaultSmsGroupConfig, type AgentConfig, type SmsGroupConfig } from '../../src/integrations/config.ts';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, agentApiDeps, seedAgent } from '../helpers/agent.ts';
import { mcpSession, textOf } from '../helpers/mcp.ts';

const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);
const TEXT = 'Przegląd klimatyzacji w czwartek o 9:00. Prosimy o dostęp do hali B.';

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

function group(name: string, config: Partial<SmsGroupConfig>): number {
  return deps.integrations.insert({
    name, kind: 'sms_group', apiKeyId: seed.keyId, serviceId: null, orig: null, preset: 'sms-grupa', enabled: 1,
    config: { ...defaultSmsGroupConfig(), maxParts: 3, ...config }, secrets: {}, storePayloads: 0, createdAt: AGENT_SEED_AT,
  });
}

/** Zmiana integracji agenta w trakcie sesji, tak jak zapis formularza w panelu. */
function setAgent(patch: { enabled?: 0 | 1; scopes?: AgentConfig['scopes'] }): void {
  const row = deps.integrations.get(seed.integrationId)!;
  const config = row.config as AgentConfig;
  deps.integrations.update(seed.integrationId, {
    name: row.name, serviceId: row.serviceId, orig: row.orig, preset: row.preset, enabled: patch.enabled ?? row.enabled,
    config: { ...config, ...(patch.scopes ? { scopes: patch.scopes } : {}) }, storePayloads: row.storePayloads,
  }, NOW);
}

describe('narzędzia wysyłki przez POST /mcp', () => {
  it('pełny przebieg: prepare_sms, send_prepared, list_messages z draftId pokazuje wiadomość queued', async () => {
    setup(['send', 'read_sent']);
    const mcp = await mcpSession(app, seed.secret);
    const prepared = await mcp.call('prepare_sms', { to: ['+48 601 000 011', '601-000-012', '0048601000011'], text: TEXT });
    expect(prepared.isError).toBeUndefined();
    const draftId = prepared.structuredContent!.draftId as string;
    expect(prepared.structuredContent).toMatchObject({ recipients: 2, duplicatesRemoved: 1, route: 'messages' });
    // Sesja bez widoków: szkic bez klucza potwierdzenia, a tekst prosi agenta o potwierdzenie człowieka.
    expect(prepared._meta).toBeUndefined();
    expect(textOf(prepared)).toContain('send_prepared');

    const sent = await mcp.call('send_prepared', { draftId });
    expect(sent.isError).toBeUndefined();
    expect(sent.structuredContent).toMatchObject({ kind: 'messages', repeated: false });
    expect(textOf(sent)).toContain('Przyjęto do wysyłki 2 wiadomości.');
    const again = await mcp.call('send_prepared', { draftId });
    expect(again.structuredContent).toMatchObject({ kind: 'messages', repeated: true });

    const list = await mcp.call('list_messages', { draftId });
    expect(list.isError).toBeUndefined();
    expect(list.structuredContent!.items.map((m: { to: string; status: string }) => [m.to, m.status]).sort())
      .toEqual([['48601000011', 'queued'], ['48601000012', 'queued']]);
    expect(list.structuredContent!.counts).toEqual({ queued: 2 });
    expect(textOf(list)).toContain('w kolejce');
  });

  it('tools/list z zakresami send_group i read_inbound nie zawiera prepare_sms ani send_reply', async () => {
    setup(['send_group', 'read_inbound']);
    const names = (await (await mcpSession(app, seed.secret)).tools()).map((t) => t.name);
    expect(names).toEqual(['connection_status', 'prepare_group_sms', 'send_prepared', 'list_inbound']);
  });

  it('adnotacje: przygotowania i odczyty readOnlyHint, wysyłka i anulowanie destructiveHint, wysyłka tylko dla widoku', async () => {
    setup(['send', 'send_group', 'read_sent', 'campaigns', 'read_inbound', 'reply']);
    const tools = await (await mcpSession(app, seed.secret, { apps: true })).tools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()]).toEqual([
      'connection_status', 'prepare_sms', 'prepare_group_sms', 'send_prepared', 'cancel_message', 'list_messages', 'delivery_trace', 'package_status',
      'package_report', 'list_campaigns', 'campaign_results', 'list_inbound', 'prepare_replies', 'send_reply',
    ]);
    for (const name of ['prepare_sms', 'prepare_group_sms', 'prepare_replies', 'list_messages', 'delivery_trace', 'package_status', 'package_report', 'list_campaigns', 'campaign_results', 'list_inbound']) {
      expect(byName.get(name)!.annotations.readOnlyHint, name).toBe(true);
    }
    for (const name of ['send_prepared', 'send_reply', 'cancel_message']) expect(byName.get(name)!.annotations.destructiveHint, name).toBe(true);
    expect(byName.get('send_prepared')!._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(byName.get('send_reply')!._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(byName.get('cancel_message')!._meta).toBeUndefined();
    expect(byName.get('prepare_sms')!.title).toBe('Przygotuj SMS');
    expect(byName.get('prepare_sms')!.inputSchema.properties.text.description).toBe('Treść SMS-a');
  });

  it('cancel_message i instrukcje serwera nie obiecują anulowania SMS-a przekazanego do sieci', async () => {
    setup(['send']);
    const tools = await (await mcpSession(app, seed.secret, { apps: true })).tools();
    const description = tools.find((t) => t.name === 'cancel_message')!.description;
    expect(description).toContain('nie przekazało jeszcze do sieci operatora');
    expect(description).toContain('Wiadomości przekazanej do sieci nie można anulować');
    expect(description).not.toContain('abonent');
    expect(SERVER_INSTRUCTIONS).toContain('Nie obiecuj anulowania wiadomości, którą bramka już wysłała.');
  });

  it('send_prepared szkicu group przy połączeniu bez send_group: isError', async () => {
    setup(['send', 'send_group']);
    group('SERWIS', { mode: 'lists', prefix: 'serwis', recipients: [{ phone: '48601000021', name: 'Jan Kowalski' }] });
    const mcp = await mcpSession(app, seed.secret);
    const prepared = await mcp.call('prepare_group_sms', { group: 'serwis', text: 'Awaria w hali B.' });
    expect(prepared.isError).toBeUndefined();
    setAgent({ scopes: ['send'] });
    const sent = await mcp.call('send_prepared', { draftId: prepared.structuredContent!.draftId });
    expect(sent.isError).toBe(true);
    expect(textOf(sent)).toBe('Połączenie nie ma uprawnienia „Wysyłka do grup”. Uprawnienia nadaje administrator bramki w integracji Agent AI.');
    expect(deps.messages.list({ apiKeyId: seed.keyId, limit: 10, offset: 0 })).toEqual([]);
  });

  it('prepare_sms zwraca widok wysylka i tekst z liczbą odbiorców bez numerów', async () => {
    setup(['send']);
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    const tool = (await mcp.tools()).find((t) => t.name === 'prepare_sms')!;
    expect(tool._meta).toEqual({ ui: { resourceUri: 'ui://multiinfo-gate/wysylka' } });
    const prepared = await mcp.call('prepare_sms', { to: ['48601000011', '48601000012'], text: TEXT });
    const text = textOf(prepared);
    expect(text).toContain('Odbiorcy: 2.');
    expect(text).toContain('Nic nie zostało wysłane.');
    expect(text).toContain(TEXT);
    expect(text).not.toMatch(/48601000011|48601000012/);
    expect(JSON.stringify(prepared.structuredContent)).not.toMatch(/48601000011|48601000012/);
    // Sesja z widokami: klucz potwierdzenia wyłącznie w _meta, a agent nie widzi narzędzia wysyłki.
    expect(prepared._meta).toEqual({
      confirm: expect.stringMatching(/^mig_cf_/), recipients: [{ phone: '48601000011', clientId: null }, { phone: '48601000012', clientId: null }],
    });
    expect(text).not.toContain(prepared._meta!.confirm);
    expect(text).toContain('przyciskiem „Wyślij”');

    const draftId = prepared.structuredContent!.draftId;
    expect(textOf(await mcp.call('send_prepared', { draftId }))).toBe('Wysyłkę zatwierdza przycisk w widoku bramki.');
    expect((await mcp.call('send_prepared', { draftId, confirm: prepared._meta!.confirm })).structuredContent).toMatchObject({ kind: 'messages' });
  });

  it('prepare_group_sms: structuredContent bez numerów, meta.recipients z numerami i nazwami', async () => {
    setup(['send_group']);
    group('SERWIS', {
      mode: 'lists', prefix: 'serwis',
      recipients: [{ phone: '48601000021', name: 'Jan Kowalski' }, { phone: '48601000022', name: 'Anna "Ania" Wiśniewska' }],
    });
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    const prepared = await mcp.call('prepare_group_sms', { group: 'SERWIS', text: 'Awaria w hali B.' });
    expect(prepared.isError).toBeUndefined();
    expect(prepared.structuredContent).toMatchObject({ group: { name: 'SERWIS' }, recipients: 2 });
    expect(JSON.stringify(prepared.structuredContent)).not.toMatch(/4860100002/);
    expect(textOf(prepared)).not.toMatch(/4860100002/);
    expect(textOf(prepared)).toContain('SERWIS');
    expect(prepared._meta).toEqual({
      recipients: [{ phone: '48601000021', name: 'Jan Kowalski' }, { phone: '48601000022', name: 'Anna "Ania" Wiśniewska' }],
      confirm: expect.stringMatching(/^mig_cf_/),
    });
  });

  it('cancel_message wiadomości innego klucza: isError bez potwierdzenia istnienia', async () => {
    setup(['send']);
    const otherKey = deps.apiKeys.insert({
      accountId: seed.accountId, name: 'biuro', keyHash: 'h2', keyPrefix: 'p2', defaultServiceId: '24138', defaultOrig: null,
      maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], expiresAt: null,
    });
    deps.messages.insert({
      id: 'msg_obca', apiKeyId: otherKey, accountId: seed.accountId, serviceId: '24138', dest: '48601000011', body: 'Faktura do zapłaty.', bodyHash: 'h',
      encoding: 'gsm', parts: 1, slots: 40, orig: null, costCenter: null, validTo: null, idempotencyKey: null, createdAt: NOW.toISOString(),
    });
    const mcp = await mcpSession(app, seed.secret);
    const foreign = await mcp.call('cancel_message', { id: 'msg_obca' });
    const unknown = await mcp.call('cancel_message', { id: 'msg_nieznana' });
    expect(foreign).toEqual(unknown);
    expect(foreign).toMatchObject({ isError: true, structuredContent: { error: 'message_not_found' } });
    expect(deps.messages.get('msg_obca')!.status).toBe('queued');
  });

  it('cancel_message wiadomości w kolejce: stan cancelled', async () => {
    setup(['send', 'read_sent']);
    const mcp = await mcpSession(app, seed.secret);
    const prepared = await mcp.call('prepare_sms', { to: ['48601000011'], text: TEXT });
    const sent = await mcp.call('send_prepared', { draftId: prepared.structuredContent!.draftId });
    const id = sent.structuredContent!.ids[0];
    const cancelled = await mcp.call('cancel_message', { id });
    expect(cancelled).toMatchObject({ structuredContent: { id, status: 'cancelled' } });
    expect(textOf(cancelled)).toBe(`Wiadomość ${id} została anulowana.`);
  });

  it('wyłączona integracja w trakcie sesji: send_prepared isError z powodem, po włączeniu działa', async () => {
    setup(['send']);
    const mcp = await mcpSession(app, seed.secret);
    const prepared = await mcp.call('prepare_sms', { to: ['48601000011'], text: TEXT });
    setAgent({ enabled: 0 });
    const off = await mcp.call('send_prepared', { draftId: prepared.structuredContent!.draftId });
    expect(off.isError).toBe(true);
    expect(textOf(off)).toMatch(/^Połączenie jest chwilowo niedostępne: .+\. Dostęp przywraca administrator bramki\.$/);
    expect(deps.messages.list({ apiKeyId: seed.keyId, limit: 10, offset: 0 })).toEqual([]);
    setAgent({ enabled: 1 });
    expect((await mcp.call('send_prepared', { draftId: prepared.structuredContent!.draftId })).structuredContent).toMatchObject({ kind: 'messages' });
  });

  it('odwołane połączenie w trakcie sesji: 401 invalid_token', async () => {
    setup(['send']);
    const mcp = await mcpSession(app, seed.secret);
    seed.service.revoke(seed.connectionId, NOW);
    const res = await mcp.rpc('tools/call', { name: 'connection_status', arguments: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });
});
