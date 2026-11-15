import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionContext } from '../../src/agents/connections.ts';
import { AgentError, prepareGroup, prepareSms, sendDraft, type AgentDeps } from '../../src/integrations/agent.ts';
import { defaultSmsGroupConfig, type SmsGroupConfig } from '../../src/integrations/config.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, agentToolDeps, seedAgent } from '../helpers/agent.ts';

const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);
const TEXT = 'Awaria klimatyzacji w hali B, proszę o kontakt z dyspozytornią.';
const AGENT_SOURCE = 'agent Agent AI - dyspozytornia · Ewa Nowak';

let db: Database;
let seed: ReturnType<typeof seedAgent>;
let deps: AgentDeps;
let serwis: number;
let flota: number;

function group(name: string, config: Partial<SmsGroupConfig>, enabled: 0 | 1 = 1): number {
  return deps.integrations.insert({
    name, kind: 'sms_group', apiKeyId: seed.keyId, serviceId: null, orig: null, preset: 'sms-grupa', enabled,
    config: { ...defaultSmsGroupConfig(), maxParts: 3, ...config }, secrets: {}, storePayloads: 0, createdAt: AGENT_SEED_AT,
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  const key = randomBytes(32);
  seed = seedAgent(db, key, { scopes: ['send', 'send_group', 'campaigns', 'read_sent'] });
  deps = { ...agentToolDeps(db, key, { now: () => NOW }), notifier: { notify: vi.fn() } as never };
  serwis = group('SERWIS', {
    mode: 'lists', prefix: 'serwis', senders: [{ phone: '48601000020', name: 'Kierownik serwisu' }],
    recipients: [{ phone: '48601000021', name: 'Jan Kowalski' }, { phone: '48601000022', name: 'Anna Wiśniewska' }],
  });
  flota = group('Flota firmowa', {
    mode: 'closed', prefix: 'FLOTA',
    members: [{ phone: '48601000031', name: 'Piotr Zieliński' }, { phone: '48601000032', name: 'Marta Lewandowska' }, { phone: '48601000033', name: '' }],
  });
  group('Magazyn', { mode: 'lists', prefix: 'magazyn', recipients: [{ phone: '48601000041', name: '' }] }, 0);
});

function ctx(): ConnectionContext {
  const resolved = deps.connections.resolve(seed.connectionId, NOW);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.ctx;
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

function setGroup(id: number, patch: Partial<SmsGroupConfig>): void {
  const row = deps.integrations.get(id)!;
  deps.integrations.update(id, {
    name: row.name, serviceId: row.serviceId, orig: row.orig, preset: row.preset, enabled: row.enabled,
    config: { ...(row.config as SmsGroupConfig), ...patch }, storePayloads: row.storePayloads,
  }, NOW);
}

const prepare = (name = 'serwis', text = TEXT) => prepareGroup(deps, ctx(), { group: name, text }, NOW);
const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('prepareGroup', () => {
  it('grupa po prefiksie serwis znajduje SERWIS, nieznana daje listę dostępnych grup', () => {
    const { preview, recipients } = prepare('serwis');
    expect(preview.group).toEqual({ id: serwis, name: 'SERWIS' });
    expect(preview.groups).toEqual(['Flota firmowa', 'SERWIS']);
    expect(preview.recipients).toBe(2);
    expect(recipients).toEqual([{ phone: '48601000021', name: 'Jan Kowalski' }, { phone: '48601000022', name: 'Anna Wiśniewska' }]);
    expect(JSON.stringify(preview)).not.toContain('48601000021');
    expect(prepare('flota').preview.group.name).toBe('Flota firmowa');
    const unknown = agentError(() => prepare('magazyn'));
    expect(unknown.code).toBe('group_unknown');
    expect(unknown.message).toBe('Grupa „magazyn” nie istnieje albo jest wyłączona. Dostępne grupy: Flota firmowa, SERWIS.');
    expect(count('messages')).toBe(0);
  });

  it('tryb closed: wszyscy członkowie są odbiorcami', () => {
    const { preview, recipients } = prepare('Flota firmowa');
    expect(preview.recipients).toBe(3);
    expect(recipients.map((r) => r.phone)).toEqual(['48601000031', '48601000032', '48601000033']);
  });

  it('pusta lista odbiorców: group_empty', () => {
    setGroup(serwis, { recipients: [] });
    expect(agentError(() => prepare()).code).toBe('group_empty');
  });

  it('szablon {{ sender }}: {{ body }} daje Ewa Nowak: treść', () => {
    setGroup(serwis, { text: { mode: 'liquid', template: '{{ sender }}: {{ body }}{{ from }}{{ p.from }}' } });
    expect(prepare().preview.text).toBe(`Ewa Nowak: ${TEXT}`);
  });

  it('warunek grupy niespełniony nie blokuje wysyłki przez agenta', () => {
    setGroup(serwis, { condition: { mode: 'builder', rules: [{ path: 'from', op: 'eq', value: '48601000020' }] } });
    const { preview } = prepare();
    expect(sendDraft(deps, ctx(), preview.draftId, NOW)).toMatchObject({ kind: 'group', group: 'SERWIS', repeated: false });
    expect(count('messages')).toBe(2);
  });

  it('nadawca grupy: nadpis grupy, potem klucza i konta, a bez nich numer usługi; wysyłka używa tego samego nadawcy', () => {
    const orig = (): Array<string | null> => (db.prepare('SELECT orig FROM messages ORDER BY rowid').all() as Array<{ orig: string | null }>).map((r) => r.orig);
    const bare = prepare().preview;
    expect(bare.orig).toBeNull();
    expect(bare.service).toEqual({ id: '24138', label: '24138' });
    deps.accounts.setDefaultOrig(seed.accountId, 'SERWIS');
    expect(prepare().preview.orig).toBe('SERWIS');
    deps.accounts.setOrigs(seed.accountId, [{ orig: 'DYSPOZYTOR', label: null }]);
    db.prepare('INSERT INTO api_key_origs (api_key_id, account_id, orig) VALUES (?, ?, ?)').run(seed.keyId, seed.accountId, 'DYSPOZYTOR');
    const row = deps.integrations.get(serwis)!;
    deps.integrations.update(serwis, {
      name: row.name, serviceId: row.serviceId, orig: 'DYSPOZYTOR', preset: row.preset, enabled: row.enabled, config: row.config, storePayloads: row.storePayloads,
    }, NOW);
    const own = prepare().preview;
    expect(own.orig).toBe('DYSPOZYTOR');
    sendDraft(deps, ctx(), own.draftId, NOW);
    expect(orig()).toEqual(['DYSPOZYTOR', 'DYSPOZYTOR']);
  });

  it('w sesji z widokami szkic grupy otrzymuje klucz potwierdzenia', () => {
    const { preview, confirm } = prepareGroup(deps, ctx(), { group: 'serwis', text: TEXT }, NOW, { apps: true });
    expect(agentError(() => sendDraft(deps, ctx(), preview.draftId, NOW)).code).toBe('confirm_required');
    expect(sendDraft(deps, ctx(), preview.draftId, NOW, confirm!)).toMatchObject({ kind: 'group' });
  });
});

describe('wysyłka szkicu grupy', () => {
  it('wysyłka liczy burzę agenta i grupy, wpisy w obu dziennikach', () => {
    const out = sendDraft(deps, ctx(), prepare().preview.draftId, NOW);
    if (out.kind !== 'group') throw new Error(out.kind);
    expect(deps.guards.peek(seed.integrationId, 60, NOW)).toMatchObject({ count: 1, recipients: 2 });
    expect(deps.guards.peek(serwis, 10, NOW)).toMatchObject({ count: 1 });
    expect(deps.integrationEvents.list(serwis, 10)[0]).toMatchObject({ result: 'sent', sourceIp: AGENT_SOURCE, reason: '2 odbiorców', messageId: out.ids[0] });
    expect(deps.integrationEvents.list(seed.integrationId, 10)[0]).toMatchObject({
      result: 'sent', sourceIp: 'MCP · Ewa Nowak', reason: 'Wyślij SMS do grupy SERWIS, 2 odbiorców', messageId: out.ids[0],
    });
    expect(sendDraft(deps, ctx(), prepare().preview.draftId, NOW)).toMatchObject({ kind: 'group' });
  });

  it('limit burzy grupy wyczerpany: throttled, burza agenta bez zużycia', () => {
    setGroup(serwis, { throttle: { limit: 1, windowMinutes: 10 } });
    const first = prepare().preview.draftId;
    const second = prepare().preview.draftId;
    sendDraft(deps, ctx(), first, NOW);
    const e = agentError(() => sendDraft(deps, ctx(), second, NOW));
    expect(e.code).toBe('throttled');
    expect(e.retryAfterSec).toBe(600);
    expect(e.message).toContain('SERWIS');
    expect(deps.guards.peek(seed.integrationId, 60, NOW)).toMatchObject({ count: 1, recipients: 2 });
    expect(deps.integrationEvents.list(serwis, 10)[0]).toMatchObject({ result: 'throttled', sourceIp: AGENT_SOURCE });
    expect(agentError(() => prepare()).code).toBe('throttled');
    expect(count('messages')).toBe(2);
  });

  it('wiadomości grupy mają integration_id grupy i agent_connection_id', () => {
    const { preview } = prepare('flota');
    const out = sendDraft(deps, ctx(), preview.draftId, NOW);
    if (out.kind !== 'group') throw new Error(out.kind);
    expect(out.ids).toHaveLength(3);
    expect(deps.messages.get(out.ids[0]!)).toMatchObject({
      integrationId: flota, agentConnectionId: seed.connectionId, requestedBy: 'Ewa Nowak', idempotencyKey: `${preview.draftId}#0`, body: null,
    });
    expect(sendDraft(deps, ctx(), preview.draftId, NOW)).toEqual({ ...out, repeated: true });
    expect(count('messages')).toBe(3);
  });

  it('wysyłka do grupy bez zakresu send_group: scope, grupa wyłączona po przygotowaniu: group_unknown', () => {
    const { preview } = prepare();
    deps.integrations.setEnabled(serwis, false, NOW);
    expect(agentError(() => sendDraft(deps, ctx(), preview.draftId, NOW)).code).toBe('group_unknown');
    deps.integrations.setEnabled(serwis, true, NOW);
    const row = deps.integrations.get(seed.integrationId)!;
    deps.integrations.update(seed.integrationId, {
      name: row.name, serviceId: row.serviceId, orig: row.orig, preset: row.preset, enabled: 1,
      config: { ...(row.config as object), scopes: ['send'] }, storePayloads: 0,
    }, NOW);
    expect(agentError(() => sendDraft(deps, ctx(), preview.draftId, NOW)).code).toBe('scope');
    expect(count('messages')).toBe(0);
  });
});

describe('odbiorcy kampanii', () => {
  let campaignId: number;

  beforeEach(() => {
    const domainId = deps.linkDomains.create({ domain: 'l.serwis.pl', displayName: 'Serwis', homeUrl: null, bareLinks: false }, NOW);
    campaignId = deps.campaigns.open(seed.keyId, 'przeglad-klimatyzacji-wiosna', AGENT_SEED_AT);
    const link = (code: string, recipientKey: string, dest: string, clientId: string | null = null) => deps.shortLinks.insert({
      code, domainId, apiKeyId: seed.keyId, campaignId, target: 'https://serwis.pl/przeglad', utm: 0, recipientKey, messageId: recipientKey, packageId: null,
      seq: null, dest, clientId, expiresAt: '2027-02-15T08:00:00.000Z', purgeAfter: '2027-03-15T08:00:00.000Z', createdAt: AGENT_SEED_AT.toISOString(),
    });
    link('aB3xK9q', 'msg_a', '48601000051');
    link('aB3xK9r', 'msg_a', '48601000051');
    link('cD4yL0s', 'msg_b', '48601000052', 'K-1042');
    deps.shortLinks.click('aB3xK9r', AGENT_SEED_AT, false);
  });

  const toCampaign = (segment: 'opened' | 'unopened', campaign = 'przeglad-klimatyzacji-wiosna') =>
    prepareSms(deps, ctx(), { campaignRecipients: { campaign, segment }, text: 'Przypominamy o przeglądzie klimatyzacji.' }, NOW);

  it('odbiorcy bez otwarcia: odbiorca z dwoma kodami, jednym otwartym, liczy się jako otwierający', () => {
    const { preview: unopened, recipients } = toCampaign('unopened');
    expect(unopened.recipients).toBe(1);
    expect(recipients).toEqual([{ phone: '48601000052', clientId: 'K-1042' }]);
    expect((deps.drafts.get(unopened.draftId, seed.connectionId)!.payload as { to: string[] }).to).toEqual(['48601000052']);
    const opened = toCampaign('opened').preview;
    expect((deps.drafts.get(opened.draftId, seed.connectionId)!.payload as { to: string[] }).to).toEqual(['48601000051']);
    expect(agentError(() => toCampaign('opened', 'cennik-zima')).code).toBe('campaign_unknown');
  });

  it('kampania po okresie przechowywania: campaign_purged', () => {
    deps.campaigns.setDetailsPurged(campaignId, NOW);
    const e = agentError(() => toCampaign('unopened'));
    expect(e.code).toBe('campaign_purged');
    expect(e.message).toBe('Szczegóły kampanii zostały usunięte po okresie przechowywania, dlatego listy odbiorców nie można odtworzyć.');
  });

  it('odbiorcy kampanii bez zakresu campaigns: scope', () => {
    const row = deps.integrations.get(seed.integrationId)!;
    deps.integrations.update(seed.integrationId, {
      name: row.name, serviceId: row.serviceId, orig: row.orig, preset: row.preset, enabled: 1,
      config: { ...(row.config as object), scopes: ['send'] }, storePayloads: 0,
    }, NOW);
    expect(agentError(() => toCampaign('unopened')).code).toBe('scope');
  });
});
