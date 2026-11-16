// Gwarancje potoku agenta na krawędziach: szkic wysyła dokładnie to, co pokazał podgląd, ochrona przed burzą
// liczy wszystkie przygotowane odpowiedzi i nie zużywa limitu na nieudaną wysyłkę, numery grupy trafiają
// wyłącznie do widoku, a link do pobrania gaśnie razem z dostępem.
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionContext } from '../../src/agents/connections.ts';
import { createDownload } from '../../src/agents/downloads.ts';
import { buildApiServer, type AgentServerDeps, type ApiDeps } from '../../src/api/server.ts';
import { authFromKey, submitMessages } from '../../src/api/submit.ts';
import {
  AgentError, prepareGroup, prepareReplies, prepareSms, sendDraft, type AgentDeps,
} from '../../src/integrations/agent.ts';
import { defaultSmsGroupConfig, type AgentConfig, type SmsGroupConfig } from '../../src/integrations/config.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, agentApiDeps, agentToolDeps, seedAgent } from '../helpers/agent.ts';
import { mcpSession, textOf } from '../helpers/mcp.ts';

const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);
const TEXT = 'Przegląd klimatyzacji w czwartek o 9:00. Prosimy o dostęp do hali B.';

let db: Database;
let key: Buffer;
let seed: ReturnType<typeof seedAgent>;

beforeEach(() => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
});

function agentError(fn: () => unknown): AgentError | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  return null;
}

/** Potok bez serwera HTTP, jak w test/integrations/agent.test.ts. */
function pipeline(opts: Parameters<typeof seedAgent>[2] = {}) {
  seed = seedAgent(db, key, { scopes: ['send', 'send_group', 'read_sent', 'read_inbound', 'reply'], ...opts });
  const deps: AgentDeps = { ...agentToolDeps(db, key, { now: () => NOW }), notifier: { notify: vi.fn() } as never };
  const ctx = (at: Date = NOW): ConnectionContext => {
    const r = deps.connections.resolve(seed.connectionId, at);
    if (!r.ok) throw new Error(r.reason);
    return r.ctx;
  };
  const inbound = (sender: string): string => {
    const id = `in_${randomBytes(6).toString('hex')}`;
    deps.inbound.insertIfNew({
      id, accountId: seed.accountId, serviceId: '24138', miId: id, sender, dest: '24138', kind: 'sms',
      body: 'Czy serwis przyjedzie w czwartek?', bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null,
      receivedAt: AGENT_SEED_AT.toISOString(), createdAt: AGENT_SEED_AT.toISOString(), system: 0,
    });
    return id;
  };
  const group = (name: string, config: Partial<SmsGroupConfig>, over: { orig?: string | null } = {}): number => deps.integrations.insert({
    name, kind: 'sms_group', apiKeyId: seed.keyId, serviceId: null, orig: over.orig ?? null, preset: 'sms-grupa', enabled: 1,
    config: { ...defaultSmsGroupConfig(), maxParts: 3, ...config }, secrets: {}, storePayloads: 0, createdAt: AGENT_SEED_AT,
  });
  const keyOrigs = (origs: string[]): void => {
    const k = deps.apiKeys.get(seed.keyId)!;
    deps.apiKeys.update(seed.keyId, {
      name: k.name, defaultServiceId: k.defaultServiceId, defaultOrig: k.defaultOrig, maxParts: k.maxParts, ratePerMin: k.ratePerMin,
      webhookUrl: k.webhookUrl, expiresAt: k.expiresAt, serviceIds: k.allowedServiceIds, origs, inboundSubscribed: 0, integrationsOnly: 0,
    });
  };
  return { deps, ctx, inbound, group, keyOrigs };
}

/** Serwer API z /mcp, jak w test/mcp/tools-send.test.ts. */
function server(scopes: AgentConfig['scopes']): { deps: ApiDeps & { agents: AgentServerDeps }; app: FastifyInstance } {
  seed = seedAgent(db, key, { scopes });
  const deps = agentApiDeps(db, key, { now: () => NOW });
  return { deps, app: buildApiServer(deps) };
}

const SERWIS = { mode: 'lists' as const, prefix: 'serwis', recipients: [{ phone: '48601000021', name: 'Jan Kowalski' }, { phone: '48601000022', name: 'Anna Wiśniewska' }] };

describe('ochrona przed burzą przy przygotowaniu odpowiedzi', () => {
  it('przy domyślnym limicie 30 wysyłek 50 szkiców odpowiedzi odpada już przy przygotowaniu, bez zużycia limitu', () => {
    const { deps, ctx, inbound } = pipeline();
    const items = Array.from({ length: 50 }, (_, i) => ({ inboundId: inbound(`48601000${String(100 + i)}`), group: 'Termin', text: 'Potwierdzamy czwartek.' }));
    const e = agentError(() => prepareReplies(deps, ctx(), items, NOW, { apps: true }));
    expect(e?.code).toBe('throttled');
    expect(e?.message).toContain('30');
    expect(deps.guards.peek(seed.integrationId, 60, NOW).count).toBe(0);
  });

  it('30 szkiców przechodzi, a każdy z nich da się wysłać w tym samym oknie', () => {
    const { deps, ctx, inbound } = pipeline();
    const items = Array.from({ length: 30 }, (_, i) => ({ inboundId: inbound(`48601000${String(100 + i)}`), group: 'Termin', text: 'Potwierdzamy czwartek.' }));
    const { drafts } = prepareReplies(deps, ctx(), items, NOW);
    for (const d of drafts) sendDraft(deps, ctx(), d.draftId, NOW);
    expect(deps.guards.peek(seed.integrationId, 60, NOW).count).toBe(30);
  });

  it('po zużyciu części okna odmowa podaje, ile odpowiedzi można jeszcze przygotować', () => {
    const { deps, ctx, inbound } = pipeline({ throttle: { limit: 3 } });
    const first = prepareReplies(deps, ctx(), [{ inboundId: inbound('48601000101'), group: 'Termin', text: 'Potwierdzamy czwartek.' }], NOW);
    sendDraft(deps, ctx(), first.drafts[0]!.draftId, NOW);
    const items = Array.from({ length: 3 }, (_, i) => ({ inboundId: inbound(`48601000${String(110 + i)}`), group: 'Termin', text: 'Potwierdzamy czwartek.' }));
    const e = agentError(() => prepareReplies(deps, ctx(), items, NOW));
    expect(e?.code).toBe('throttled');
    expect(e?.message).toContain('2 odpowiedzi');
    expect(e?.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('odmowa limitu odbiorców', () => {
  it('przy jednym odbiorcy liczebnik stoi w dopełniaczu', () => {
    const { deps, ctx } = pipeline({ throttle: { recipients: 1 } });
    sendDraft(deps, ctx(), prepareSms(deps, ctx(), { to: ['48601000011'], text: TEXT }, NOW).preview.draftId, NOW);
    const e = agentError(() => prepareSms(deps, ctx(), { to: ['48601000012'], text: TEXT }, NOW));
    expect(e?.message).toContain('Wysyłka do 1 odbiorcy przekroczyłaby limit');
  });
});

describe('numery i nazwy członków grupy wyłącznie dla widoku', () => {
  it('prepare_group_sms w sesji bez widoków nie zwraca numerów ani nazw w _meta', async () => {
    const { deps, app } = server(['send_group']);
    deps.integrations.insert({
      name: 'SERWIS', kind: 'sms_group', apiKeyId: seed.keyId, serviceId: null, orig: null, preset: 'sms-grupa', enabled: 1,
      config: { ...defaultSmsGroupConfig(), maxParts: 3, ...SERWIS }, secrets: {}, storePayloads: 0, createdAt: AGENT_SEED_AT,
    });
    const mcp = await mcpSession(app, seed.secret);
    const prepared = await mcp.call('prepare_group_sms', { group: 'SERWIS', text: 'Awaria w hali B.' });
    expect(prepared.isError).toBeUndefined();
    expect(JSON.stringify(prepared)).not.toMatch(/48601000021|Kowalski/);
  });
});

describe('szkic wysyła dokładnie to, co pokazał podgląd', () => {
  it('nadpis grupy zmieniony po podglądzie: czytelna odmowa bez wysyłki', () => {
    const { deps, ctx, group, keyOrigs } = pipeline();
    deps.accounts.setOrigs(seed.accountId, [{ orig: 'SERWIS', label: null }]);
    keyOrigs(['SERWIS']);
    const id = group('SERWIS', SERWIS);
    const { preview } = prepareGroup(deps, ctx(), { group: 'SERWIS', text: 'Awaria w hali B.' }, NOW);
    expect(preview.orig).toBeNull();
    const row = deps.integrations.get(id)!;
    deps.integrations.update(id, { name: row.name, serviceId: row.serviceId, orig: 'SERWIS', preset: row.preset, enabled: 1, config: row.config, storePayloads: 0 }, NOW);
    const e = agentError(() => sendDraft(deps, ctx(), preview.draftId, NOW));
    expect(e?.code).toBe('draft_stale');
    expect(e?.message).toContain('SERWIS');
    expect(deps.messages.list({ apiKeyId: seed.keyId, limit: 10, offset: 0 })).toEqual([]);
    expect(deps.guards.peek(seed.integrationId, 60, NOW).count).toBe(0);
  });

  it('osoba usunięta z listy grupy po podglądzie: czytelna odmowa bez wysyłki', () => {
    const { deps, ctx, group } = pipeline();
    const id = group('SERWIS', SERWIS);
    const { preview } = prepareGroup(deps, ctx(), { group: 'SERWIS', text: 'Awaria w hali B.' }, NOW);
    const row = deps.integrations.get(id)!;
    const config = { ...(row.config as SmsGroupConfig), recipients: [SERWIS.recipients[0]!] };
    deps.integrations.update(id, { name: row.name, serviceId: row.serviceId, orig: row.orig, preset: row.preset, enabled: 1, config, storePayloads: 0 }, NOW);
    expect(agentError(() => sendDraft(deps, ctx(), preview.draftId, NOW))?.code).toBe('draft_stale');
    expect(deps.messages.list({ apiKeyId: seed.keyId, limit: 10, offset: 0 })).toEqual([]);
  });

  it('szkic z numerem usługi: domyślny nadpis konta dodany po podglądzie daje odmowę zamiast SMS-a z nadpisem', () => {
    const { deps, ctx } = pipeline();
    const { preview } = prepareSms(deps, ctx(), { to: ['48601000011'], text: TEXT }, NOW);
    expect(preview.orig).toBeNull();
    deps.accounts.setDefaultOrig(seed.accountId, 'SERWIS');
    expect(agentError(() => sendDraft(deps, ctx(), preview.draftId, NOW))?.code).toBe('draft_stale');
    expect(deps.messages.list({ apiKeyId: seed.keyId, limit: 10, offset: 0 })).toEqual([]);
  });

  it('odpowiedź z numeru usługi: domyślny nadpis konta dodany po podglądzie daje odmowę', () => {
    const { deps, ctx, inbound } = pipeline();
    const { drafts } = prepareReplies(deps, ctx(), [{ inboundId: inbound('48601000031'), group: 'Termin', text: 'Potwierdzamy czwartek.' }], NOW);
    deps.accounts.setDefaultOrig(seed.accountId, 'SERWIS');
    expect(agentError(() => sendDraft(deps, ctx(), drafts[0]!.draftId, NOW))?.code).toBe('draft_stale');
  });

  it('wyłączenie skracania po podglądzie daje odmowę zamiast SMS-a z długim linkiem', () => {
    const { deps, ctx } = pipeline();
    const domainId = deps.linkDomains.create({ domain: 'l.serwis.pl', displayName: 'Serwis', homeUrl: null, bareLinks: false }, NOW);
    deps.apiKeys.setLinkSettings(seed.keyId, { mode: 'always', domainIds: [domainId], defaultDomainId: domainId, targets: ['serwis.pl'], validityDays: 30, utm: false });
    const { preview } = prepareSms(deps, ctx(), { to: ['48601000011'], text: 'Umów przegląd: https://serwis.pl/przeglad/wiosna-2027' }, NOW);
    expect(preview.text).toContain('l.serwis.pl');
    deps.apiKeys.setLinkSettings(seed.keyId, { mode: 'off', domainIds: [domainId], defaultDomainId: domainId, targets: ['serwis.pl'], validityDays: 30, utm: false });
    expect(agentError(() => sendDraft(deps, ctx(), preview.draftId, NOW))?.code).toBe('draft_stale');
  });

  it('szkic bez zmian ustawień wychodzi, także z krótkim linkiem', () => {
    const { deps, ctx } = pipeline();
    const domainId = deps.linkDomains.create({ domain: 'l.serwis.pl', displayName: 'Serwis', homeUrl: null, bareLinks: false }, NOW);
    deps.apiKeys.setLinkSettings(seed.keyId, { mode: 'always', domainIds: [domainId], defaultDomainId: domainId, targets: ['serwis.pl'], validityDays: 30, utm: false });
    const { preview } = prepareSms(deps, ctx(), { to: ['48601000011'], text: 'Umów przegląd: https://serwis.pl/przeglad/wiosna-2027' }, NOW);
    const out = sendDraft(deps, ctx(), preview.draftId, NOW);
    expect(out.kind).toBe('messages');
  });
});

describe('nieudana wysyłka nie zużywa limitu ochrony', () => {
  it('nadpis odebrany kluczowi po podglądzie: błąd bez wysyłki i bez zużycia okna', () => {
    const { deps, ctx, keyOrigs } = pipeline({ throttle: { limit: 2 } });
    deps.accounts.setOrigs(seed.accountId, [{ orig: 'SERWIS', label: null }]);
    keyOrigs(['SERWIS']);
    const { preview } = prepareSms(deps, ctx(), { to: ['48601000011'], text: TEXT, orig: 'SERWIS' }, NOW);
    keyOrigs([]);
    expect(() => sendDraft(deps, ctx(), preview.draftId, NOW)).toThrow();
    expect(deps.messages.list({ apiKeyId: seed.keyId, limit: 10, offset: 0 })).toEqual([]);
    const window = deps.guards.peek(seed.integrationId, 60, NOW);
    expect([window.count, window.recipients]).toEqual([0, 0]);
  });

  it('błąd wysyłki do grupy zwraca okno agenta i okno grupy', () => {
    const { deps, ctx, group, keyOrigs } = pipeline();
    deps.accounts.setOrigs(seed.accountId, [{ orig: 'SERWIS', label: null }]);
    keyOrigs(['SERWIS']);
    const id = group('SERWIS', SERWIS, { orig: 'SERWIS' });
    const { preview } = prepareGroup(deps, ctx(), { group: 'SERWIS', text: 'Awaria w hali B.' }, NOW);
    keyOrigs([]);
    expect(() => sendDraft(deps, ctx(), preview.draftId, NOW)).toThrow();
    expect(deps.guards.peek(seed.integrationId, 60, NOW).count).toBe(0);
    expect(deps.guards.peek(id, 60, NOW).count).toBe(0);
  });
});

describe('link do pobrania gaśnie razem z dostępem', () => {
  function withPackage() {
    seed = seedAgent(db, key, { scopes: ['read_sent'] });
    const deps = agentApiDeps(db, key, { now: () => NOW });
    deps.packages.insert({
      id: 'pkg_1', apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', defaultText: 'Przypomnienie o przeglądzie.', orig: null,
      costCenter: null, startAt: null, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: AGENT_SEED_AT.toISOString(),
    }, [{ dest: '48601000011', text: null, clientId: null }]);
    const link = createDownload(deps.agents, 'https://bramka.serwis.example', { apiKeyId: seed.keyId, connectionId: seed.connectionId }, 'package_report', 'pkg_1', NOW);
    const get = () => buildApiServer(deps).inject({ method: 'GET', url: link.url.replace('https://bramka.serwis.example', '') });
    return { deps, get };
  }

  it('działa, dopóki połączenie ma dostęp', async () => {
    const { get } = withPackage();
    expect((await get()).statusCode).toBe(200);
  });

  it('po odwołaniu klucza integracji link przestaje działać', async () => {
    const { deps, get } = withPackage();
    deps.apiKeys.revoke(seed.keyId);
    expect((await get()).statusCode).toBe(404);
  });

  it('po odwołaniu połączenia link przestaje działać', async () => {
    const { get } = withPackage();
    seed.service.revoke(seed.connectionId, NOW);
    expect((await get()).statusCode).toBe(404);
  });

  it('po odebraniu zakresu odczytu wysłanych link do raportu przestaje działać', async () => {
    const { deps, get } = withPackage();
    const row = deps.integrations.get(seed.integrationId)!;
    deps.integrations.update(seed.integrationId, {
      name: row.name, serviceId: row.serviceId, orig: row.orig, preset: row.preset, enabled: 1,
      config: { ...(row.config as AgentConfig), scopes: ['send'] }, storePayloads: 0,
    }, NOW);
    expect((await get()).statusCode).toBe(404);
  });
});

describe('przypomnienie kampanii jako rozsyłka', () => {
  it('501 odbiorców kampanii: rozsyłka zapisuje identyfikatory klienta, które pokazał podgląd', () => {
    const { deps, ctx } = pipeline({ scopes: ['send', 'campaigns'], throttle: { recipients: 50_000 } });
    const domainId = deps.linkDomains.create({ domain: 'l.serwis.pl', displayName: 'Serwis', homeUrl: null, bareLinks: false }, NOW);
    const campaignId = deps.campaigns.open(seed.keyId, 'przeglad-klimatyzacji-wiosna', AGENT_SEED_AT);
    for (let i = 0; i < 501; i++) {
      deps.shortLinks.insert({
        code: `c${String(i).padStart(6, '0')}`, domainId, apiKeyId: seed.keyId, campaignId, target: 'https://serwis.pl/przeglad', utm: 0,
        recipientKey: `msg_${i}`, messageId: `msg_${i}`, packageId: null, seq: null, dest: `48601000${String(i).padStart(3, '0')}`, clientId: `K-${i}`,
        expiresAt: '2027-02-15T08:00:00.000Z', purgeAfter: '2027-03-15T08:00:00.000Z', createdAt: AGENT_SEED_AT.toISOString(),
      });
    }
    const input = { campaignRecipients: { campaign: 'przeglad-klimatyzacji-wiosna', segment: 'unopened' as const }, text: 'Przypominamy o przeglądzie klimatyzacji.' };
    const { preview, recipients } = prepareSms(deps, ctx(), input, NOW);
    expect(preview.route).toBe('package');
    const shown = new Map(recipients.map((r) => [r.phone, r.clientId]));
    const out = sendDraft(deps, ctx(), preview.draftId, NOW);
    if (out.kind !== 'package') throw new Error(out.kind);
    const saved = deps.packages.recipients(out.id, 501);
    expect(saved).toHaveLength(501);
    for (const r of saved) expect(r.clientId).toBe(shown.get(r.dest));
  });
});

describe('anulowanie przez agenta obejmuje wyłącznie wysyłki jego integracji', () => {
  it('wiadomość wysłana przez API tym samym kluczem, na przykład alarm z systemu dyspozytorni, zostaje w kolejce', async () => {
    const { deps, app } = server(['send']);
    const [api] = submitMessages(deps, authFromKey(deps.apiKeys.get(seed.keyId)!), { to: ['48601000031'], text: 'Alarm: awaria chłodni w hali C.' }, NOW);
    const mcp = await mcpSession(app, seed.secret, { apps: true });
    const result = await mcp.call('cancel_message', { id: api!.id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('wyłącznie wiadomości wysłane przez integrację');
    expect(deps.messages.get(api!.id)!.status).toBe('queued');
  });
});

describe('ślad anulowania przez agenta', () => {
  it('zdarzenie anulowania wskazuje integrację i połączenie', async () => {
    const { app } = server(['send']);
    const mcp = await mcpSession(app, seed.secret);
    const prepared = await mcp.call('prepare_sms', { to: ['48601000011'], text: TEXT });
    const sent = await mcp.call('send_prepared', { draftId: prepared.structuredContent!.draftId });
    const id = sent.structuredContent!.ids[0] as string;
    await mcp.call('cancel_message', { id });
    const events = db.prepare("SELECT detail FROM message_events WHERE message_id = ? AND kind = 'cancelled'").all(id) as Array<{ detail: string | null }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toContain('Ewa Nowak');
  });
});
