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
    // Bez zakresu read_sent lista nie zawiera list_packages, a cancel_package obejmuje także zakres send_group.
    expect(names).toEqual(['connection_status', 'prepare_group_sms', 'send_prepared', 'cancel_package', 'list_inbound', 'conversation']);
  });

  it('adnotacje: przygotowania i odczyty readOnlyHint, wysyłka i anulowanie destructiveHint, wysyłka tylko dla widoku', async () => {
    setup(['send', 'send_group', 'read_sent', 'campaigns', 'read_inbound', 'reply']);
    const tools = await (await mcpSession(app, seed.secret, { apps: true })).tools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()]).toEqual([
      'connection_status', 'prepare_sms', 'prepare_group_sms', 'send_prepared', 'cancel_message', 'cancel_package', 'open_file_send', 'upload_file_rows',
      'file_summary', 'prepare_file_sms', 'send_file_sms', 'file_send_status', 'list_messages', 'list_packages',
      'delivery_trace', 'package_status', 'package_report', 'list_campaigns', 'campaign_results', 'list_inbound', 'conversation', 'prepare_replies',
      'prepare_conversation_reply', 'send_reply',
    ]);
    for (const name of ['prepare_sms', 'prepare_group_sms', 'prepare_replies', 'prepare_conversation_reply', 'conversation', 'list_messages', 'delivery_trace', 'package_status', 'package_report', 'file_send_status', 'list_campaigns', 'campaign_results', 'list_inbound']) {
      expect(byName.get(name)!.annotations.readOnlyHint, name).toBe(true);
    }
    for (const name of ['send_prepared', 'send_reply', 'send_file_sms', 'cancel_message', 'cancel_package']) expect(byName.get(name)!.annotations.destructiveHint, name).toBe(true);
    expect(byName.get('list_packages')!.annotations.readOnlyHint).toBe(true);
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

  it('limit ochrony przed burzą w tekstach narzędzi liczony w wysyłkach, jak w panelu', async () => {
    setup(['send']);
    const mcp = await mcpSession(app, seed.secret);
    const prepared = textOf(await mcp.call('prepare_sms', { to: ['48601000011'], text: TEXT }));
    const status = textOf(await mcp.call('connection_status', {}));
    expect(prepared).toMatch(/można jeszcze wykonać \d+ wysył(ek|ki|kę) i wysłać SMS-y do/);
    expect(status).toMatch(/wykorzystano 0 z \d+ wysyłek i 0 z \d+ odbiorców/);
    for (const text of [prepared, status]) expect(text).not.toMatch(/wywoła[nń][a-z]* wysyłając/);
  });

  it('prepare_sms z krótkim linkiem: tekst dla agenta oznacza adres z kodem 0000000 jako znacznik, a nie link', async () => {
    setup(['send']);
    const domainId = deps.linkDomains.create({ domain: 'l.serwis.pl', displayName: 'Serwis', homeUrl: null, bareLinks: false }, NOW);
    deps.apiKeys.setLinkSettings(seed.keyId, { mode: 'always', domainIds: [domainId], defaultDomainId: domainId, targets: ['serwis.pl'], validityDays: 30, utm: false });
    const text = textOf(await (await mcpSession(app, seed.secret)).call('prepare_sms', { to: ['48601000011'], text: 'Umów przegląd: https://serwis.pl/przeglad' }));
    expect(text).toContain('Umów przegląd: https://l.serwis.pl/0000000');
    expect(text).toContain('Adres https://l.serwis.pl/0000000 jest znacznikiem miejsca na krótki link, a nie działającym linkiem. '
      + 'Każdy odbiorca otrzyma przy wysyłce link z własnym kodem, dlatego nie przedstawiaj tego adresu użytkownikowi jako linku.');
    const plain = textOf(await (await mcpSession(app, seed.secret)).call('prepare_sms', { to: ['48601000011'], text: TEXT }));
    expect(plain).not.toContain('znacznikiem');
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
    expect(textOf(sent)).toBe('Zakresy integracji nie obejmują uprawnienia „Wysyłka do grup”. Uprawnienia nadaje administrator bramki w integracji Agent AI.');
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

describe('wysyłka z terminem i anulowanie rozsyłki przez POST /mcp', () => {
  function pending(id: string, status: 'scheduled' | 'open', integrationId: number | null): void {
    deps.packages.insert({
      id, apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', defaultText: 'Przegląd klimatyzacji w czwartek.', orig: null,
      costCenter: null, startAt: '2026-11-20T07:00:00.000Z', deliveryReport: 1, encoding: 'gsm', multipart: 0,
      createdAt: AGENT_SEED_AT.toISOString(), status, integrationId,
    }, [{ dest: '48601000011', text: null, clientId: null }]);
  }

  it('prepare_sms i send_prepared z terminem: tekst z terminem, chwilą przekazania i oknem anulowania, wynik „Zaplanowano rozsyłkę”', async () => {
    setup(['send', 'read_sent']);
    const mcp = await mcpSession(app, seed.secret);
    const prepared = await mcp.call('prepare_sms', { to: ['48601000011'], text: TEXT, startAt: '2026-11-20 08:00' });
    const text = textOf(prepared);
    expect(text).toContain('Termin rozpoczęcia rozsyłki: 20.11.2026 08:00 czasu polskiego. Bramka przekaże rozsyłkę do Multiinfo 20.11.2026 07:50.');
    expect(text).toContain('Anulowanie jest możliwe do chwili przekazania rozsyłki do Multiinfo, zwykle 10 minut przed terminem.');
    expect(text).toContain('Bramka zaplanuje rozsyłkę ze wspólną treścią.');
    const sent = await mcp.call('send_prepared', { draftId: prepared.structuredContent!.draftId });
    expect(textOf(sent)).toMatch(/^Zaplanowano rozsyłkę pkg_\S+ do 1 odbiorcy na 20\.11\.2026 08:00 czasu polskiego\. Bramka przekaże ją do Multiinfo 20\.11\.2026 07:50, a do tej chwili rozsyłkę anuluje narzędzie cancel_package\.$/);
    expect(sent.structuredContent).toMatchObject({ kind: 'package', schedule: { startAt: '2026-11-20T07:00:00.000Z' } });
  });

  it('cancel_package: własna rozsyłka scheduled anulowana, dziennik panelu z aktorem agent integracja · połączenie', async () => {
    setup(['send']);
    pending('pkg_s', 'scheduled', seed.integrationId);
    const result = await (await mcpSession(app, seed.secret)).call('cancel_package', { id: 'pkg_s' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('Rozsyłka pkg_s została anulowana.');
    expect(result.structuredContent).toEqual({ id: 'pkg_s', status: 'cancelled' });
    expect(deps.packages.get('pkg_s')!.status).toBe('cancelled');
    expect(deps.audit.list(10, 0).find((e) => e.action === 'rozsylka.anulowanie')).toMatchObject({
      actor: 'agent Agent AI - dyspozytornia · Ewa Nowak', target: 'rozsylka:pkg_s',
    });
  });

  it('cancel_package: rozsyłka z API tego klucza daje not_own; rozsyłka open daje package_not_cancellable', async () => {
    setup(['send']);
    pending('pkg_api', 'scheduled', null);
    pending('pkg_open', 'open', seed.integrationId);
    const mcp = await mcpSession(app, seed.secret);
    const api = await mcp.call('cancel_package', { id: 'pkg_api' });
    expect(api.isError).toBe(true);
    expect(textOf(api)).toBe('Agent anuluje wyłącznie rozsyłki wysłane przez integrację Agent AI - dyspozytornia. Pozostałe rozsyłki anuluje administrator w panelu bramki.');
    expect(api.structuredContent).toEqual({ error: 'not_own' });
    const open = await mcp.call('cancel_package', { id: 'pkg_open' });
    expect(open.structuredContent).toEqual({ error: 'package_not_cancellable' });
    expect(textOf(open)).toBe('Rozsyłka została już przekazana do Multiinfo, które nie pozwala jej anulować.');
    const unknown = await mcp.call('cancel_package', { id: 'pkg_brak' });
    expect(unknown.structuredContent).toEqual({ error: 'package_unknown' });
    expect(deps.packages.get('pkg_api')!.status).toBe('scheduled');
  });
});
