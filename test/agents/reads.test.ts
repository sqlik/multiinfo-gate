import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { cancelMessage, FINAL_STATUSES } from '../../src/api/cancel-message.ts';
import { ApiError } from '../../src/api/errors.ts';
import { answersTo, campaignResults, deliveryTrace, listInbound, listPackages, listSent, ownPackage, packageStatus } from '../../src/agents/reads.ts';
import type { ConnectionContext } from '../../src/agents/connections.ts';
import { AgentError } from '../../src/integrations/agent.ts';
import type { AgentToolDeps } from '../../src/mcp/tools.ts';
import type { ReportRow } from '../../src/multiinfo/report.ts';
import { defaultInboundConfig, defaultMailInConfig, defaultPowerAutomateConfig, defaultSmsGroupConfig } from '../../src/integrations/config.ts';
import { openDatabase } from '../../src/store/db.ts';
import type { MessageInput } from '../../src/store/messages.ts';
import { AGENT_SEED_AT, agentToolDeps, seedAgent } from '../helpers/agent.ts';

/** 2026-11-15 10:00 w Polsce. */
const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);
const DAY = 86_400_000;
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

const CONFIGS = {
  webhook_in: defaultInboundConfig, sms_group: defaultSmsGroupConfig, power_automate: defaultPowerAutomateConfig, mail_in: defaultMailInConfig,
} as const;

let db: Database;
let seed: ReturnType<typeof seedAgent>;
let deps: AgentToolDeps;

beforeEach(() => {
  db = openDatabase(':memory:');
  const key = randomBytes(32);
  seed = seedAgent(db, key, { scopes: ['send', 'read_sent', 'read_inbound', 'campaigns'] });
  deps = agentToolDeps(db, key, { now: () => NOW });
});

function ctx(): ConnectionContext {
  const resolved = deps.connections.resolve(seed.connectionId, NOW);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.ctx;
}

function message(id: string, over: Partial<MessageInput> = {}): string {
  deps.messages.insert({
    id, apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', dest: '48601000011',
    body: 'Przegląd klimatyzacji w czwartek o 9:00.', bodyHash: 'h', encoding: 'gsm', parts: 1, slots: 40,
    orig: null, costCenter: null, validTo: null, idempotencyKey: null, createdAt: at(-3_600_000), ...over,
  });
  return id;
}

function integration(name: string, kind: 'webhook_in' | 'sms_group' | 'power_automate', apiKeyId = seed.keyId): number {
  return deps.integrations.insert({
    name, kind, apiKeyId, serviceId: null, orig: null, preset: 'wlasny', enabled: 1, config: CONFIGS[kind](), secrets: {}, storePayloads: 0,
    createdAt: AGENT_SEED_AT,
  });
}

function pkg(id: string, dests: string[], createdAt = at(-2 * 3_600_000)): string {
  deps.packages.insert({
    id, apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', defaultText: 'Przypomnienie o przeglądzie.', orig: null,
    costCenter: null, startAt: null, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt,
  }, dests.map((dest, i) => ({ dest, text: null, clientId: i === 0 ? 'K-17' : null })));
  return id;
}

const report = (dest: string, miStatus: number, status: ReportRow['status'], changedAt: string, miId: string): ReportRow => ({
  miId, dest, miStatus, status, rawStatus: String(miStatus), changedAt, clientId: null,
});

function inbound(id: string, over: { sender?: string; receivedAt?: string; system?: 0 | 1; body?: string } = {}): string {
  deps.inbound.insertIfNew({
    id, accountId: seed.accountId, serviceId: '24138', miId: id, sender: over.sender ?? '48601000011', dest: '24138', kind: 'text',
    body: over.body ?? 'Potwierdzam termin przeglądu.', bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null,
    receivedAt: over.receivedAt ?? at(-600_000), createdAt: over.receivedAt ?? at(-600_000), system: over.system ?? 0,
  });
  return id;
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

describe('cancelMessage', () => {
  it('trasa anulowania po wydzieleniu: anuluje wiadomość przed przekazaniem do Multiinfo', async () => {
    message('msg_q');
    expect(FINAL_STATUSES.has('delivered')).toBe(true);
    expect(FINAL_STATUSES.has('queued')).toBe(false);
    await expect(cancelMessage(deps, seed.keyId, 'msg_q', NOW)).resolves.toEqual({ id: 'msg_q', status: 'cancelled' });
    expect(deps.messages.get('msg_q')!.status).toBe('cancelled');
    expect(deps.events.list('msg_q').map((e) => [e.kind, e.detail])).toEqual([['cancelled', 'przed przekazaniem do Multiinfo']]);
    const foreign = await cancelMessage(deps, seed.keyId + 1, 'msg_q', NOW).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(ApiError);
    expect((foreign as ApiError).httpStatus).toBe(404);
  });
});

describe('listSent', () => {
  it('listSent pokazuje wiadomość innej integracji tego klucza i pomija systemową', () => {
    const hook = integration('Zgłoszenia serwisowe', 'webhook_in');
    message('msg_hook', { integrationId: hook });
    message('msg_api', { createdAt: at(-1_800_000) });
    message('msg_sys', { system: 1 });
    const other = deps.apiKeys.insert({
      accountId: seed.accountId, name: 'inny', keyHash: 'h2', keyPrefix: 'p2', defaultServiceId: '24138', defaultOrig: null,
      maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
    });
    message('msg_other', { apiKeyId: other });
    const out = listSent(deps, ctx(), { offset: 0, limit: 25 });
    expect(out.items.map((m) => [m.id, m.source])).toEqual([['msg_api', 'API'], ['msg_hook', 'integracja Zgłoszenia serwisowe']]);
    expect(out.counts).toEqual({ queued: 2 });
    expect(out.hasMore).toBe(false);
    expect(listSent(deps, ctx(), { offset: 0, limit: 1 })).toMatchObject({ hasMore: true, counts: { queued: 2 } });
  });

  it('listSent z draftId zwraca 3 wiadomości szkicu i liczby w stanach', () => {
    message('msg_d0', { idempotencyKey: 'drf_abc#0', dest: '48601000011' });
    message('msg_d1', { idempotencyKey: 'drf_abc#1', dest: '48601000012' });
    message('msg_d2', { idempotencyKey: 'drf_abc#2', dest: '48601000013' });
    message('msg_x', { idempotencyKey: 'drf_abcd#0', dest: '48601000014' });
    message('msg_y', { idempotencyKey: 'drf_abcd', dest: '48601000015' });
    deps.messages.setStatus('msg_d0', { status: 'delivered', finalAt: NOW });
    deps.messages.setStatus('msg_d1', { status: 'delivered', finalAt: NOW });
    deps.messages.setStatus('msg_d2', { status: 'sent' });
    const out = listSent(deps, ctx(), { draftId: 'drf_abc', offset: 0, limit: 25 });
    expect(out.items.map((m) => m.id).sort()).toEqual(['msg_d0', 'msg_d1', 'msg_d2']);
    expect(out.counts).toEqual({ delivered: 2, sent: 1 });
    expect(listSent(deps, ctx(), { draftId: 'drf_abcd', offset: 0, limit: 25 }).items.map((m) => m.id).sort()).toEqual(['msg_x', 'msg_y']);
    expect(listSent(deps, ctx(), { draftId: 'drf_abc', status: 'delivered', offset: 0, limit: 1 })).toMatchObject({
      hasMore: true, counts: { delivered: 2, sent: 1 },
    });
  });
});

describe('deliveryTrace', () => {
  it('przebieg po numerze w różnym zapisie znajduje wiadomość i odbiorcę rozsyłki', () => {
    message('msg_new');
    message('msg_old', { createdAt: at(-8 * DAY) });
    message('msg_else', { dest: '48601000099' });
    pkg('pkg_1', ['48601000012', '48601000011']);
    for (const to of ['+48 601 000 011', '0048601000011', '601-000-011']) {
      const out = deliveryTrace(deps, ctx(), { to }, NOW);
      expect(out.entries.map((e) => [e.kind, e.id, e.to])).toEqual([
        ['message', 'msg_new', '48601000011'],
        ['package_recipient', 'pkg_1#2', '48601000011'],
      ]);
    }
    expect(deliveryTrace(deps, ctx(), { to: '601000011', from: at(-9 * DAY) }, NOW).entries).toHaveLength(3);
    expect(agentError(() => deliveryTrace(deps, ctx(), { to: 'abc' }, NOW)).code).toBe('invalid_phone');
  });

  it('pozycja przebiegu podaje nadawcę, usługę i kodowanie treści dla okna treści w widoku', () => {
    message('msg_s', { orig: 'SERWIS', encoding: 'ucs2', parts: 2 });
    pkg('pkg_s', ['48601000011']);
    const entries = deliveryTrace(deps, ctx(), { to: '601000011' }, NOW).entries;
    expect(entries.find((e) => e.id === 'msg_s')).toMatchObject({ sender: 'SERWIS', serviceId: '24138', encoding: 'ucs2', parts: 2 });
    expect(entries.find((e) => e.kind === 'package_recipient')).toMatchObject({ sender: null, serviceId: '24138', encoding: 'gsm', parts: null });
  });

  it('przebieg odbiorcy rozsyłki bez kodu szczegółowego', () => {
    pkg('pkg_1', ['48601000011'], at(-2 * 3_600_000));
    deps.packages.setCompleted('pkg_1', new Date(at(-90 * 60_000)));
    deps.packages.applyReport('pkg_1', [report('48601000011', 21, 'delivered', '2026-11-15 08:30:00', '9001')]);
    deps.packages.setReport('pkg_1', { status: 'ready' });
    const [entry] = deliveryTrace(deps, ctx(), { to: '601000011' }, NOW).entries;
    expect(entry).toMatchObject({
      kind: 'package_recipient', status: 'delivered', statusLabel: 'doręczona', operator: null, cancellable: false,
      packageId: 'pkg_1', source: 'API', text: 'Przypomnienie o przeglądzie.',
    });
    expect(entry!.stages.map((s) => [s.kind, s.local])).toEqual([
      ['package_queued', '15.11.2026 08:00'],
      ['package_completed', '15.11.2026 08:30'],
      ['report', '15.11.2026 08:30'],
    ]);
    expect(entry!.stages[2]).toMatchObject({ at: '2026-11-15T07:30:00.000Z', label: 'Stan z raportu: doręczona' });
  });

  it('etapy z czasem warszawskim: 2026-11-14T13:05:00Z daje 14.11.2026 14:05', () => {
    message('msg_t', { createdAt: '2026-11-14T13:05:00.000Z' });
    deps.events.record('msg_t', new Date('2026-11-14T13:05:00Z'), 'queued', null);
    deps.events.record('msg_t', new Date('2026-11-14T13:05:02Z'), 'sent', 'identyfikatory 5501');
    deps.messages.setStatus('msg_t', { status: 'failed', miStatus: 11, miSubstatus: 2, finalAt: new Date('2026-11-14T13:20:00Z') });
    const [entry] = deliveryTrace(deps, ctx(), { id: 'msg_t' }, NOW).entries;
    expect(entry!.stages[0]).toEqual({
      at: '2026-11-14T13:05:00.000Z', local: '14.11.2026 14:05', kind: 'queued', label: 'Przyjęta przez bramkę, zapisana w kolejce', detail: null,
    });
    expect(entry!.stages[1]).toMatchObject({ kind: 'sent', label: 'Przekazana do Multiinfo', detail: 'identyfikatory 5501' });
    expect(entry!.created).toEqual({ at: '2026-11-14T13:05:00.000Z', local: '14.11.2026 14:05' });
    expect(entry!.operator).toEqual({ code: '11/2', description: 'Wiadomość nie została doręczona' });
    expect(entry!.cancellable).toBe(false);
    expect(entry!.text).toBe('Przegląd klimatyzacji w czwartek o 9:00.');
  });

  it('od godziny bez strefy liczy czas polski, wiadomość w kolejce można anulować', () => {
    message('msg_in', { createdAt: '2026-11-14T13:05:00.000Z', integrationId: seed.integrationId });
    message('msg_out', { createdAt: '2026-11-14T12:55:00.000Z' });
    const entries = deliveryTrace(deps, ctx(), { to: '601000011', from: '2026-11-14T14:00' }, NOW).entries;
    expect(entries.map((e) => e.id)).toEqual(['msg_in']);
    expect(entries[0]).toMatchObject({ cancellable: true, status: 'queued', statusLabel: 'w kolejce', operator: null });
    expect(deliveryTrace(deps, ctx(), { to: '601000011', from: '2026-11-14', until: '2026-11-14' }, NOW).entries).toHaveLength(2);
    expect(agentError(() => deliveryTrace(deps, ctx(), { to: '601000011', from: 'wczoraj' }, NOW)).code).toBe('invalid');
  });

  it('anulować można wyłącznie wysyłki integracji agenta, także jej SMS-y do grup', () => {
    message('msg_api', { createdAt: at(-60_000) });
    const group = integration('SERWIS', 'sms_group');
    message('msg_grupa', { createdAt: at(-60_000), integrationId: group, agentConnectionId: seed.connectionId });
    message('msg_inna_grupa', { createdAt: at(-60_000), integrationId: group });
    const entry = (id: string) => deliveryTrace(deps, ctx(), { id }, NOW).entries[0]!;
    expect(entry('msg_api')).toMatchObject({ cancellable: false, agentSent: false, status: 'queued' });
    expect(entry('msg_grupa')).toMatchObject({ cancellable: true, agentSent: true });
    expect(entry('msg_inna_grupa')).toMatchObject({ cancellable: false, agentSent: false });
  });

  it('anulowanie tylko przed przekazaniem do sieci: kolejka bramki, status 0 i limit, bez statusu 1 i 3', () => {
    const state = (id: string, status: 'queued' | 'sent' | 'throttled', miStatus: number | null): boolean => {
      message(id, { createdAt: at(-60_000), integrationId: seed.integrationId });
      if (miStatus !== null) {
        deps.messages.setSent(id, ['55' + id.length], new Date(at(-50_000)));
        deps.messages.setStatus(id, { status, miStatus, miSubstatus: 0 });
      }
      return deliveryTrace(deps, ctx(), { id }, NOW).entries[0]!.cancellable;
    };
    expect(state('msg_k', 'queued', null)).toBe(true);
    expect(state('msg_m0', 'queued', 0)).toBe(true);
    expect(state('msg_m7', 'throttled', 7)).toBe(true);
    expect(state('msg_m1', 'sent', 1)).toBe(false);
    expect(state('msg_m3', 'sent', 3)).toBe(false);
  });

  it('przebieg po identyfikatorze innego klucza albo wiadomości systemowej jest pusty', () => {
    message('msg_sys', { system: 1 });
    expect(deliveryTrace(deps, ctx(), { id: 'msg_sys' }, NOW).entries).toEqual([]);
    expect(deliveryTrace(deps, ctx(), { id: 'msg_brak' }, NOW).entries).toEqual([]);
  });
});

describe('packageStatus', () => {
  it('w trakcie wysyłania: postęp z remaining_count i odbiorcy porcjami', () => {
    pkg('pkg_1', ['48601000011', '48601000012', '48601000013']);
    deps.packages.setProgress('pkg_1', { remaining: 2, miStatus: 2, status: 'sending' });
    const out = packageStatus(deps, ctx(), 'pkg_1', { offset: 1, limit: 1 });
    expect(out).toMatchObject({ id: 'pkg_1', status: 'sending', statusLabel: 'w wysyłce', final: false, recipients: 3, remaining: 2, report: null, hasMore: true, source: 'API' });
    expect(out.items).toEqual([{ to: '48601000012', clientId: null, status: 'pending', statusLabel: 'czeka na raport', changed: null }]);
    expect(agentError(() => packageStatus(deps, ctx(), 'pkg_brak', { offset: 0, limit: 25 })).code).toBe('package_unknown');
  });

  it('przyczyny niedoręczeń z raportu z liczbami', () => {
    pkg('pkg_1', ['48601000011', '48601000012', '48601000013', '48601000014', '48601000015', '48601000016']);
    deps.packages.setCompleted('pkg_1', NOW);
    deps.packages.applyReport('pkg_1', [
      report('48601000011', 21, 'delivered', '2026-11-15 08:10:00', '1'),
      report('48601000012', 21, 'delivered', '2026-11-15 09:40:00', '2'),
      report('48601000013', 11, 'failed', '2026-11-15 08:20:00', '3'),
      report('48601000014', 11, 'failed', '2026-11-15 08:25:00', '4'),
      report('48601000015', 12, 'expired', '2026-11-15 08:30:00', '5'),
    ]);
    deps.packages.setReport('pkg_1', { status: 'ready' });
    expect(deps.packages.reportBreakdown('pkg_1').reasons).toEqual([
      { miStatus: 11, description: 'Wiadomość nie została doręczona', count: 2 },
      { miStatus: 12, description: 'Wiadomość została przedawniona', count: 1 },
      { miStatus: null, description: 'Brak pozycji w raporcie', count: 1 },
    ]);
    const out = packageStatus(deps, ctx(), 'pkg_1', { offset: 0, limit: 2 });
    expect(out.final).toBe(true);
    expect(out.report).toEqual({
      byStatus: { delivered: 2, failed: 2, expired: 1, unknown: 1 },
      reasons: [
        { description: 'Wiadomość nie została doręczona', count: 2 },
        { description: 'Wiadomość została przedawniona', count: 1 },
        { description: 'Brak pozycji w raporcie', count: 1 },
      ],
      deliveredByHour: [{ hour: '2026-11-15 08:00', count: 1 }, { hour: '2026-11-15 09:00', count: 1 }],
    });
    expect(out.items[0]).toEqual({
      to: '48601000011', clientId: 'K-17', status: 'delivered', statusLabel: 'doręczona',
      changed: { at: '2026-11-15T07:10:00.000Z', local: '15.11.2026 08:10' },
    });
  });
});

describe('campaignResults', () => {
  function campaign(at: Date): { id: number; link: (code: string, dest: string, key: string) => void } {
    const domainId = deps.linkDomains.create({ domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, at);
    const id = deps.campaigns.open(seed.keyId, 'przeglad-klimatyzacji-wiosna', at);
    deps.campaigns.addSent(id, 3);
    const link = (code: string, dest: string, key: string): void => {
      deps.shortLinks.insert({
        code, domainId, apiKeyId: seed.keyId, campaignId: id, target: 'https://firma.pl/przeglad', utm: 0, recipientKey: key,
        messageId: key, packageId: null, seq: null, dest, clientId: null, expiresAt: '2026-12-31T23:00:00.000Z',
        purgeAfter: '2027-01-30T23:00:00.000Z', createdAt: at.toISOString(),
      });
      deps.campaigns.addTarget(id, 'https://firma.pl/przeglad', '2027-01-30T23:00:00.000Z');
    };
    return { id, link };
  }

  function click(id: number, code: string, when: string): void {
    const { firstOpen } = deps.shortLinks.click(code, new Date(when), false);
    deps.campaigns.countClick(id, when.slice(0, 13), false);
    if (firstOpen) deps.campaigns.countOpen(id);
  }

  it('otwarcie 2026-10-24T22:30:00Z liczy się do dnia 2026-10-25', () => {
    const c = campaign(new Date('2026-10-24T08:00:00Z'));
    c.link('aB3xK9q', '48601000011', 'msg_a');
    c.link('cD4yL0s', '48601000012', 'msg_b');
    c.link('eF5zM1t', '48601000013', 'msg_c');
    click(c.id, 'aB3xK9q', '2026-10-24T22:30:00.000Z');
    click(c.id, 'aB3xK9q', '2026-10-24T22:40:00.000Z');
    click(c.id, 'cD4yL0s', '2026-10-24T21:30:00.000Z');
    const out = campaignResults(deps, ctx(), 'przeglad-klimatyzacji-wiosna', { offset: 0, limit: 1 });
    expect(out.opensByDay).toEqual([{ day: '2026-10-24', opens: 1 }, { day: '2026-10-25', opens: 1 }]);
    expect(out.clicksByHour).toEqual([{ hour: '2026-10-24 23:00', clicks: 1 }, { hour: '2026-10-25 00:00', clicks: 2 }]);
    expect(out).toMatchObject({ name: 'przeglad-klimatyzacji-wiosna', sent: 3, opens: 2, clicks: 3, detailsPurged: false });
    expect(out.first).toEqual({ at: '2026-10-24T08:00:00.000Z', local: '24.10.2026 10:00' });
    expect(out.unopened).toEqual({ total: 1, items: [{ to: '48601000013', clientId: null }], hasMore: false });
    expect(out.targets).toEqual([{ target: 'https://firma.pl/przeglad', kind: 'shared', opens: 0, clicks: 0 }]);
    expect(agentError(() => campaignResults(deps, ctx(), 'cennik-zima', { offset: 0, limit: 25 })).code).toBe('campaign_unknown');
  });

  it('kampania po okresie przechowywania: same kliknięcia, detailsPurged true', () => {
    const c = campaign(new Date('2026-10-24T08:00:00Z'));
    c.link('aB3xK9q', '48601000011', 'msg_a');
    click(c.id, 'aB3xK9q', '2026-10-24T09:30:00.000Z');
    deps.shortLinks.purge(new Date('2027-02-01T00:00:00Z'));
    deps.campaigns.setDetailsPurged(c.id, new Date('2027-02-01T00:00:00Z'));
    const out = campaignResults(deps, ctx(), 'przeglad-klimatyzacji-wiosna', { offset: 0, limit: 25 });
    expect(out).toMatchObject({ detailsPurged: true, opensByDay: [], unopened: null, opens: 1, clicks: 1 });
    expect(out.clicksByHour).toEqual([{ hour: '2026-10-24 11:00', clicks: 1 }]);
  });
});

describe('answersTo i listInbound', () => {
  it('answersTo: odpowiedź po 6 dniach przypisana, po 8 dniach null, dwie wysyłki: późniejsza', () => {
    const t0 = new Date('2026-11-01T10:00:00Z').getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    message('msg_1', { createdAt: iso(t0) });
    expect(answersTo(deps, seed.keyId, { sender: '48601000011', receivedAt: iso(t0 + 6 * DAY) })).toEqual({ messageId: 'msg_1' });
    expect(answersTo(deps, seed.keyId, { sender: '48601000011', receivedAt: iso(t0 + 8 * DAY) })).toBeNull();
    expect(answersTo(deps, seed.keyId, { sender: '48601000011', receivedAt: iso(t0 - 60_000) })).toBeNull();
    expect(answersTo(deps, seed.keyId + 1, { sender: '48601000011', receivedAt: iso(t0 + DAY) })).toBeNull();
    pkg('pkg_1', ['48601000011'], iso(t0 + DAY));
    expect(answersTo(deps, seed.keyId, { sender: '48601000011', receivedAt: iso(t0 + 2 * DAY) })).toEqual({ packageId: 'pkg_1' });
    message('msg_2', { createdAt: iso(t0 + 1.5 * DAY) });
    expect(answersTo(deps, seed.keyId, { sender: '48601000011', receivedAt: iso(t0 + 2 * DAY) })).toEqual({ messageId: 'msg_2' });
    message('msg_sys', { createdAt: iso(t0 + 1.8 * DAY), system: 1 });
    expect(answersTo(deps, seed.keyId, { sender: '48601000011', receivedAt: iso(t0 + 2 * DAY) })).toEqual({ messageId: 'msg_2' });
  });

  it('listInbound oznacza każdą pozycję source external_sender i pomija systemowe', () => {
    message('msg_1', { createdAt: at(-DAY) });
    inbound('in_1', { body: '<img src=x onerror=alert(1)>' });
    inbound('in_sys', { system: 1 });
    inbound('in_2', { sender: '48601000077', receivedAt: at(-300_000) });
    const out = listInbound(deps, ctx(), { offset: 0, limit: 25 });
    expect(out.items.map((i) => [i.id, i.source, i.answersTo])).toEqual([
      ['in_2', 'external_sender', null],
      ['in_1', 'external_sender', { messageId: 'msg_1' }],
    ]);
    expect(out.items[1]).toMatchObject({ from: '48601000011', text: '<img src=x onerror=alert(1)>' });
    expect(out.items[1]!.received.local).toBe('15.11.2026 09:50');
    expect(listInbound(deps, ctx(), { sender: '601 000 077', offset: 0, limit: 25 }).items.map((i) => i.id)).toEqual(['in_2']);
    expect(listInbound(deps, ctx(), { answersToMessage: 'msg_1', offset: 0, limit: 25 }).items.map((i) => i.id)).toEqual(['in_1']);
    expect(listInbound(deps, ctx(), { answersToPackage: 'pkg_brak', offset: 0, limit: 25 }).items).toEqual([]);
  });

  it('listInbound z answersToPackage zwraca odpowiedzi odbiorców rozsyłki porcjami', () => {
    pkg('pkg_1', ['48601000011', '48601000012'], at(-DAY));
    inbound('in_1', { sender: '48601000011', receivedAt: at(-3_600_000) });
    inbound('in_2', { sender: '48601000012', receivedAt: at(-1_800_000) });
    inbound('in_3', { sender: '48601000013', receivedAt: at(-900_000) });
    message('msg_later', { dest: '48601000012', createdAt: at(-2_000_000) });
    const first = listInbound(deps, ctx(), { answersToPackage: 'pkg_1', offset: 0, limit: 1 });
    expect(first).toMatchObject({ hasMore: false });
    expect(first.items.map((i) => i.id)).toEqual(['in_1']);
  });
});

describe('rozsyłki z terminem', () => {
  /** Rozsyłka klucza agenta: z integracji agenta, z połączenia albo z API. */
  function scheduled(id: string, status: 'scheduled' | 'overdue' | 'open', over: { integrationId?: number | null; agentConnectionId?: number | null; createdAt?: string } = {}): string {
    deps.packages.insert({
      id, apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', defaultText: 'Przegląd klimatyzacji w czwartek.', orig: null,
      costCenter: null, startAt: '2026-11-20T07:00:00.000Z', deliveryReport: 1, encoding: 'gsm', multipart: 0,
      createdAt: over.createdAt ?? at(-3_600_000), status, integrationId: over.integrationId === undefined ? seed.integrationId : over.integrationId,
      agentConnectionId: over.agentConnectionId ?? null,
    }, [{ dest: '48601000011', text: null, clientId: null }]);
    return id;
  }

  it('ownPackage: rozsyłka integracji agenta albo jej połączenia, nie z API ani z innej integracji', () => {
    const group = integration('SERWIS', 'sms_group');
    scheduled('pkg_a', 'scheduled');
    scheduled('pkg_g', 'scheduled', { integrationId: group, agentConnectionId: seed.connectionId });
    scheduled('pkg_api', 'scheduled', { integrationId: null });
    scheduled('pkg_inna', 'scheduled', { integrationId: group });
    const own = (id: string) => ownPackage(deps, ctx(), deps.packages.get(id)!);
    expect(['pkg_a', 'pkg_g', 'pkg_api', 'pkg_inna'].map(own)).toEqual([true, true, false, false]);
  });

  it('package_status: scheduled z terminem, chwilą przekazania i cancellable; overdue bez chwili przekazania', () => {
    scheduled('pkg_s', 'scheduled');
    scheduled('pkg_o', 'overdue');
    scheduled('pkg_api', 'scheduled', { integrationId: null });
    const s = packageStatus(deps, ctx(), 'pkg_s', { offset: 0, limit: 25 });
    expect(s).toMatchObject({
      status: 'scheduled', statusLabel: 'zaplanowana', final: false, cancellable: true,
      schedule: { startAt: { at: '2026-11-20T07:00:00.000Z', local: '20.11.2026 08:00' }, handoverAt: { at: '2026-11-20T06:50:00.000Z', local: '20.11.2026 07:50' } },
    });
    expect(packageStatus(deps, ctx(), 'pkg_o', { offset: 0, limit: 25 })).toMatchObject({
      status: 'overdue', cancellable: true, schedule: { startAt: { local: '20.11.2026 08:00' }, handoverAt: null },
    });
    expect(packageStatus(deps, ctx(), 'pkg_api', { offset: 0, limit: 25 }).cancellable).toBe(false);
    pkg('pkg_n', ['48601000011']);
    expect(packageStatus(deps, ctx(), 'pkg_n', { offset: 0, limit: 25 })).toMatchObject({ schedule: null, cancellable: false });
  });

  it('listPackages: rozsyłki klucza od najnowszej, filtr stanu, strony, termin i źródło', () => {
    scheduled('pkg_1', 'scheduled', { createdAt: at(-3 * 3_600_000) });
    scheduled('pkg_2', 'open', { createdAt: at(-2 * 3_600_000) });
    scheduled('pkg_3', 'scheduled', { createdAt: at(-3_600_000), integrationId: null });
    const all = listPackages(deps, ctx(), { offset: 0, limit: 25 }, NOW);
    expect(all.items.map((i) => i.id)).toEqual(['pkg_3', 'pkg_2', 'pkg_1']);
    const only = listPackages(deps, ctx(), { status: 'scheduled', offset: 0, limit: 1 }, NOW);
    expect(only).toMatchObject({ hasMore: true, items: [{
      id: 'pkg_3', status: 'scheduled', statusLabel: 'zaplanowana', recipients: 1, source: 'API',
      created: { at: at(-3_600_000) }, startAt: { at: '2026-11-20T07:00:00.000Z', local: '20.11.2026 08:00' },
    }] });
    // Rozsyłka przekazana do Multiinfo przed terminem należy do zaplanowanych z osobnym opisem stanu.
    expect(listPackages(deps, ctx(), { status: 'scheduled', offset: 1, limit: 1 }, NOW).items[0])
      .toMatchObject({ id: 'pkg_2', status: 'open', statusLabel: 'przekazana do Multiinfo, czeka na termin' });
    expect(listPackages(deps, ctx(), { status: 'scheduled', offset: 2, limit: 1 }, NOW).items[0]).toMatchObject({ id: 'pkg_1', source: 'agent Agent AI - dyspozytornia' });
  });
});
