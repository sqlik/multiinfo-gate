import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionContext } from '../../src/agents/connections.ts';
import {
  AgentError, DRAFT_TTL_MS, guardLeft, prepareReplies, prepareSms, scheduleOf, sendDraft, senderOptions, type AgentDeps, type PrepareSmsInput,
} from '../../src/integrations/agent.ts';
import type { AgentScope } from '../../src/integrations/config.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, agentToolDeps, seedAgent } from '../helpers/agent.ts';

const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);
const TEXT = 'Przypominamy o przeglądzie klimatyzacji w czwartek o 10:00.';

let db: Database;
let key: Buffer;
let seed: ReturnType<typeof seedAgent>;
let deps: AgentDeps;
let notify: ReturnType<typeof vi.fn>;

function setup(opts: Parameters<typeof seedAgent>[2] = {}): void {
  db = openDatabase(':memory:');
  key = randomBytes(32);
  seed = seedAgent(db, key, { scopes: ['send', 'read_sent', 'read_inbound', 'reply'], ...opts });
  notify = vi.fn();
  deps = { ...agentToolDeps(db, key, { now: () => NOW }), notifier: { notify } as never };
}

beforeEach(() => setup());

function ctx(at: Date = NOW): ConnectionContext {
  const resolved = deps.connections.resolve(seed.connectionId, at);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.ctx;
}

const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const numbers = (n: number): string[] => Array.from({ length: n }, (_, i) => `48601${String(i).padStart(6, '0')}`);
const sms = (input: Partial<PrepareSmsInput> = {}, at = NOW, apps = false) =>
  prepareSms(deps, ctx(at), { to: ['48601000011'], text: TEXT, ...input }, at, { apps });

function agentError(fn: () => unknown): AgentError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  throw new Error('oczekiwano AgentError');
}

function setScopes(scopes: AgentScope[]): void {
  const row = deps.integrations.get(seed.integrationId)!;
  deps.integrations.update(seed.integrationId, {
    name: row.name, serviceId: row.serviceId, orig: row.orig, preset: row.preset, enabled: row.enabled,
    config: { ...(row.config as object), scopes }, storePayloads: row.storePayloads,
  }, NOW);
}

function inbound(over: { system?: 0 | 1; sender?: string } = {}): string {
  const id = `in_${randomBytes(6).toString('hex')}`;
  deps.inbound.insertIfNew({
    id, accountId: seed.accountId, serviceId: '24138', miId: id, sender: over.sender ?? '48601000011', dest: '24138', kind: 'sms',
    body: 'Czy serwis przyjedzie w czwartek?', bodyHash: 'h', protocolId: 0, codingScheme: 0, connectorId: null, relatedMessageId: null,
    receivedAt: AGENT_SEED_AT.toISOString(), createdAt: AGENT_SEED_AT.toISOString(), system: over.system ?? 0,
  });
  return id;
}

describe('prepareSms', () => {
  it('prepareSms niczego nie zapisuje w messages ani w kolejce', () => {
    const { preview } = sms();
    expect(count('messages')).toBe(0);
    expect(count('packages')).toBe(0);
    expect(deps.jobs.depth()).toBe(0);
    expect(deps.drafts.get(preview.draftId, seed.connectionId)?.kind).toBe('sms');
    expect(preview.expiresAt).toBe(new Date(NOW.getTime() + DRAFT_TTL_MS).toISOString());
  });

  it('numery +48 601 000 011, 0048601000011 i 601-000-011 to jeden odbiorca, duplicatesRemoved 2', () => {
    const { preview, recipients } = sms({ to: ['+48 601 000 011', '0048601000011', '601-000-011'] });
    expect(preview.recipients).toBe(1);
    expect(preview.duplicatesRemoved).toBe(2);
    // Numery po normalizacji trafiają wyłącznie do widoku, poza podglądem dla agenta.
    expect(recipients).toEqual([{ phone: '48601000011', clientId: null }]);
    expect(JSON.stringify(preview)).not.toContain('48601000011');
    expect((deps.drafts.get(preview.draftId, seed.connectionId)!.payload as { to: string[] }).to).toEqual(['48601000011']);
  });

  it('500 odbiorców: route messages; 501: route package; 5001: AgentError', () => {
    setup({ throttle: { recipients: 50_000 } });
    expect(sms({ to: numbers(500) }).preview.route).toBe('messages');
    expect(sms({ to: numbers(501) }).preview.route).toBe('package');
    expect(agentError(() => sms({ to: numbers(5001) })).code).toBe('too_many_recipients');
  });

  it('treść ponad limit części przy overflow reject: AgentError too_many_parts z liczbą części', () => {
    const e = agentError(() => sms({ text: 'a'.repeat(600) }));
    expect(e.code).toBe('too_many_parts');
    expect(e.message).toContain('4 części');
    expect(e.message).toContain('3');
  });

  it('link w treści: podgląd z kodem 0000000 i domeną z ustawień klucza', () => {
    const domainId = deps.linkDomains.create({ domain: 'l.serwis.pl', displayName: 'Serwis', homeUrl: null, bareLinks: false }, NOW);
    deps.apiKeys.setLinkSettings(seed.keyId, { mode: 'always', domainIds: [domainId], defaultDomainId: domainId, targets: ['serwis.pl'], validityDays: 30, utm: false });
    const { preview } = sms({ text: 'Umów przegląd: https://serwis.pl/przeglad' });
    expect(preview.text).toBe('Umów przegląd: https://l.serwis.pl/0000000');
    expect(preview.links).toMatchObject({
      shortened: 1, domain: 'l.serwis.pl', domains: ['l.serwis.pl'], campaign: 'Agent AI - dyspozytornia', mode: 'always', utm: false,
    });
    expect(count('short_links')).toBe(0);
  });

  it('nadawcy: bez żadnego nadpisu domyślnego jest pozycja numeru usługi, z nadpisem konta jej nie ma', () => {
    const bare = senderOptions(deps, ctx());
    expect(bare.senders).toContainEqual({ value: null, label: 'numer usługi 24138' });
    expect(bare.orig).toBeNull();
    expect(bare.services).toEqual([{ id: '24138', label: '24138' }]);
    expect(bare.serviceId).toBe('24138');
    deps.accounts.setDefaultOrig(seed.accountId, 'SERWIS');
    const withOrig = senderOptions(deps, ctx());
    expect(withOrig.senders.some((s) => s.value === null)).toBe(false);
    expect(withOrig.senders).toContainEqual({ value: 'SERWIS', label: 'SERWIS' });
    expect(withOrig.orig).toBe('SERWIS');
  });

  it('szkic przekraczający okno ochrony odpada już przy przygotowaniu z retryAfterSec', () => {
    setup({ throttle: { limit: 1 } });
    sendDraft(deps, ctx(), sms().preview.draftId, NOW);
    const e = agentError(() => sms());
    expect(e.code).toBe('throttled');
    expect(e.retryAfterSec).toBe(3600);
    expect(guardLeft(deps, ctx(), NOW)).toEqual({ calls: 0, recipients: 999, resetsAt: new Date(NOW.getTime() + 3_600_000).toISOString() });
  });

  it('szkic odrzucony przy przygotowaniu zapisuje wpis w dzienniku i zgłasza integration_throttled raz w oknie, bez zużycia okna', () => {
    setup({ throttle: { limit: 1 } });
    sendDraft(deps, ctx(), sms().preview.draftId, NOW);
    agentError(() => sms());
    agentError(() => prepareReplies(deps, ctx(), [{ inboundId: inbound(), group: 'Termin', text: 'Dziękujemy.' }], NOW));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('integration_throttled', `integration:${seed.integrationId}`, 'Agent AI - dyspozytornia: przekroczony limit 1 w 60 min', NOW);
    const refused = deps.integrationEvents.list(seed.integrationId, 10).filter((r) => r.result === 'throttled');
    expect(refused).toHaveLength(2);
    expect(refused[0]).toMatchObject({ sourceIp: 'MCP · Ewa Nowak', reason: 'podgląd: ponad 1 w 60 min', payload: null });
    expect(guardLeft(deps, ctx(), NOW).calls).toBe(0);
    expect(db.prepare('SELECT count FROM integration_throttle WHERE integration_id = ?').get(seed.integrationId)).toEqual({ count: 1 });
  });
});

describe('sendDraft', () => {
  it('sendDraft dwa razy: jedna wiadomość, drugi wynik repeated true, licznik burzy bez zmian', () => {
    const { preview } = sms();
    const first = sendDraft(deps, ctx(), preview.draftId, NOW);
    const second = sendDraft(deps, ctx(), preview.draftId, NOW);
    expect(first).toMatchObject({ kind: 'messages', repeated: false });
    expect(second).toEqual({ ...first, repeated: true });
    expect(count('messages')).toBe(1);
    expect(deps.guards.peek(seed.integrationId, 60, NOW).count).toBe(1);
  });

  it('szkic z sesji z widokami: klucz tylko w meta.confirm, sendDraft bez klucza albo z innym kluczem confirm_required, z kluczem wysyła', () => {
    const { preview, confirm } = sms({}, NOW, true);
    expect(confirm).toEqual(expect.any(String));
    expect(JSON.stringify(preview)).not.toContain(confirm!);
    expect(agentError(() => sendDraft(deps, ctx(), preview.draftId, NOW)).code).toBe('confirm_required');
    expect(agentError(() => sendDraft(deps, ctx(), preview.draftId, NOW, `${confirm}x`)).message).toBe('Wysyłkę zatwierdza przycisk w widoku bramki.');
    expect(count('messages')).toBe(0);
    expect(sendDraft(deps, ctx(), preview.draftId, NOW, confirm!)).toMatchObject({ kind: 'messages', repeated: false });
    expect(count('messages')).toBe(1);
  });

  it('szkic z sesji bez widoków: bez klucza, sendDraft wysyła bez confirm', () => {
    const { preview, confirm } = sms();
    expect(confirm).toBeNull();
    expect(sendDraft(deps, ctx(), preview.draftId, NOW)).toMatchObject({ kind: 'messages' });
  });

  it('sendDraft po 30 min i 1 s: draft_expired, nic nie wysłane', () => {
    const { preview } = sms();
    const late = new Date(NOW.getTime() + DRAFT_TTL_MS + 1000);
    const e = agentError(() => sendDraft(deps, ctx(late), preview.draftId, late));
    expect(e.code).toBe('draft_expired');
    expect(e.message).toBe('Podgląd wygasł po 30 minutach. Przygotuj SMS ponownie.');
    expect(count('messages')).toBe(0);
  });

  it('szkic innego połączenia albo nieznany: draft_unknown', () => {
    expect(agentError(() => sendDraft(deps, ctx(), 'drf_nieznany', NOW)).code).toBe('draft_unknown');
  });

  it('sendDraft po wyłączeniu integracji: unavailable; po włączeniu: wysłane', () => {
    const view = ctx();
    const { preview } = sms();
    deps.integrations.setEnabled(seed.integrationId, false, NOW);
    expect(agentError(() => sendDraft(deps, view, preview.draftId, NOW)).code).toBe('unavailable');
    expect(count('messages')).toBe(0);
    deps.integrations.setEnabled(seed.integrationId, true, NOW);
    expect(sendDraft(deps, view, preview.draftId, NOW)).toMatchObject({ kind: 'messages' });
  });

  it('sendDraft po odebraniu zakresu send: scope, nic nie wysłane', () => {
    const view = ctx();
    const { preview } = sms();
    setScopes(['read_sent']);
    expect(agentError(() => sendDraft(deps, view, preview.draftId, NOW)).code).toBe('scope');
    expect(count('messages')).toBe(0);
  });

  it('wiadomość z agenta ma integration_id agenta, agent_connection_id i requested_by z nazwą połączenia', () => {
    const out = sendDraft(deps, ctx(), sms().preview.draftId, NOW);
    if (out.kind !== 'messages') throw new Error(out.kind);
    expect(deps.messages.get(out.ids[0]!)).toMatchObject({
      integrationId: seed.integrationId, agentConnectionId: seed.connectionId, requestedBy: 'Ewa Nowak', dest: '48601000011',
    });
  });

  it('wpis dziennika integracji ma sourceIp MCP · Ewa Nowak i powód z liczbą odbiorców', () => {
    const out = sendDraft(deps, ctx(), sms({ to: ['48601000011', '48601000012'] }).preview.draftId, NOW);
    if (out.kind !== 'messages') throw new Error(out.kind);
    const [entry] = deps.integrationEvents.list(seed.integrationId, 10);
    expect(entry).toMatchObject({ result: 'sent', sourceIp: 'MCP · Ewa Nowak', reason: 'Wyślij SMS, 2 odbiorców', messageId: out.ids[0] });
  });

  it('501 odbiorców: rozsyłka z agent_connection_id i idempotencją szkicu', () => {
    const { preview } = sms({ to: numbers(501) });
    const out = sendDraft(deps, ctx(), preview.draftId, NOW);
    if (out.kind !== 'package') throw new Error(out.kind);
    expect(out.recipients).toBe(501);
    expect(deps.packages.get(out.id)).toMatchObject({
      integrationId: seed.integrationId, agentConnectionId: seed.connectionId, idempotencyKey: preview.draftId, requestedBy: 'Ewa Nowak', recipientsCount: 501,
    });
  });

  it('przekroczenie burzy przy wysyłce zgłasza integration_throttled jeden raz w oknie', () => {
    setup({ throttle: { limit: 1 } });
    const drafts = [sms(), sms(), sms()].map((p) => p.preview.draftId);
    sendDraft(deps, ctx(), drafts[0]!, NOW);
    const e = agentError(() => sendDraft(deps, ctx(), drafts[1]!, NOW));
    expect(e.code).toBe('throttled');
    expect(e.retryAfterSec).toBe(3600);
    agentError(() => sendDraft(deps, ctx(), drafts[2]!, NOW));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('integration_throttled', `integration:${seed.integrationId}`, expect.stringContaining('Agent AI - dyspozytornia'), NOW);
    expect(deps.integrationEvents.list(seed.integrationId, 10).filter((r) => r.result === 'throttled')).toHaveLength(2);
  });
});

describe('prepareReplies', () => {
  it('odpowiedź zawsze do nadawcy odebranego SMS-a, odebrany systemowy: AgentError inbound_unknown', () => {
    const id = inbound({ sender: '48601000011' });
    const { drafts } = prepareReplies(deps, ctx(), [{ inboundId: id, group: 'Termin', text: 'Dziękujemy, potwierdzamy czwartek.' }], NOW);
    expect(drafts[0]).toMatchObject({ inboundId: id, to: '48601000011', group: 'Termin', parts: 1 });
    const out = sendDraft(deps, ctx(), drafts[0]!.draftId, NOW);
    if (out.kind !== 'messages') throw new Error(out.kind);
    expect(deps.messages.get(out.ids[0]!)).toMatchObject({ dest: '48601000011', inReplyTo: id, agentConnectionId: seed.connectionId });
    expect(deps.integrationEvents.list(seed.integrationId, 10)[0]).toMatchObject({ reason: `Odpowiedź na ${id}` });

    const system = inbound({ system: 1 });
    expect(agentError(() => prepareReplies(deps, ctx(), [{ inboundId: system, group: 'Termin', text: 'x' }], NOW)).code).toBe('inbound_unknown');
  });
});

describe('wysyłka z terminem', () => {
  // NOW to 2026-11-15 10:00 w Polsce, a 2026-11-20 08:00 w Polsce to 07:00 UTC.
  const SCHEDULE = { startAt: '2026-11-20T07:00:00.000Z', handoverAt: '2026-11-20T06:50:00.000Z' };

  it('prepare_sms z startAt 2026-11-20 08:00 do jednego odbiorcy: route package, schedule w czasie polskim, zdanie o anulowaniu z chwilą przekazania', () => {
    const { preview } = sms({ startAt: '2026-11-20 08:00' });
    expect(preview).toMatchObject({ route: 'package', recipients: 1, schedule: SCHEDULE });
    expect(sms({ startAt: '2026-11-20T07:00:00Z' }).preview.schedule).toEqual(SCHEDULE);
    expect(sms().preview).toMatchObject({ route: 'messages', schedule: null });
  });

  it('startAt 2026-11-20 bez godziny, 2027-03-28 02:30, w przeszłości i dalej niż 30 dni: błąd narzędzia z wyjaśnieniem', () => {
    expect(agentError(() => sms({ startAt: '2026-11-20' }))).toMatchObject({
      code: 'invalid', message: 'Termin rozsyłki musi zawierać datę i godzinę, na przykład 2026-11-20 08:00 w czasie polskim.',
    });
    expect(agentError(() => sms({ startAt: '2027-03-28 02:30' }))).toMatchObject({
      code: 'invalid', message: 'Godzina 02:30 w dniu 28.03.2027 nie istnieje w czasie polskim z powodu zmiany czasu. Podaj inną godzinę.',
    });
    expect(agentError(() => sms({ startAt: '2026-11-15 09:59' }))).toMatchObject({ code: 'start_at_in_past' });
    expect(agentError(() => sms({ startAt: '2026-12-15 10:01' }))).toMatchObject({
      code: 'start_at_too_far', message: 'Termin rozpoczęcia rozsyłki może przypadać najwyżej 30 dni od chwili wysyłki.',
    });
    expect(sms({ startAt: '2026-12-15 10:00' }).preview.schedule).toEqual({ startAt: '2026-12-15T09:00:00.000Z', handoverAt: '2026-12-15T08:50:00.000Z' });
    expect(count('agent_drafts')).toBe(1);
  });

  it('nieczytelny startAt: błąd z przykładem daty z godziną, który bramka przyjmuje', () => {
    expect(agentError(() => sms({ startAt: '20.11.2026 8:00' }))).toMatchObject({
      code: 'invalid', message: 'Pole startAt musi być datą z godziną, na przykład 2026-11-20 08:00 w czasie polskim.',
    });
    expect(sms({ startAt: '2026-11-20 08:00' }).preview.schedule).not.toBeNull();
  });

  it('termin dokładnie 30 dni naprzód w czasie polskim przyjęty także przez zmianę czasu, minutę później odrzucony', () => {
    const autumn = new Date('2026-10-20T08:00:00Z'); // 10:00 czasu letniego, 25.10 zmiana na zimowy
    expect(scheduleOf('2026-11-19 10:00', autumn)).toMatchObject({ startAt: '2026-11-19T09:00:00.000Z' });
    expect(agentError(() => scheduleOf('2026-11-19 10:01', autumn))).toMatchObject({ code: 'start_at_too_far' });
    const spring = new Date('2027-03-10T09:00:00Z'); // 10:00 czasu zimowego, 28.03 zmiana na letni
    expect(scheduleOf('2027-04-09 10:00', spring)).toMatchObject({ startAt: '2027-04-09T08:00:00.000Z' });
    expect(scheduleOf('2027-04-09T09:00:00Z', spring)).toMatchObject({ startAt: '2027-04-09T09:00:00.000Z' });
  });

  it('send_prepared szkicu z terminem: rozsyłka scheduled z terminem i agent_connection_id, wynik z schedule', () => {
    const { preview } = sms({ startAt: '2026-11-20 08:00' });
    const out = sendDraft(deps, ctx(), preview.draftId, NOW);
    expect(out).toMatchObject({ kind: 'package', recipients: 1, repeated: false, schedule: SCHEDULE });
    const id = (out as { id: string }).id;
    expect(deps.packages.get(id)).toMatchObject({
      status: 'scheduled', startAt: SCHEDULE.startAt, integrationId: seed.integrationId, agentConnectionId: seed.connectionId, requestedBy: 'Ewa Nowak',
    });
    expect(count('messages')).toBe(0);
    expect(sendDraft(deps, ctx(), preview.draftId, NOW)).toMatchObject({ kind: 'package', id, repeated: true, schedule: SCHEDULE });
  });

  it('termin minął między podglądem a wysyłką: szkic nieaktualny, bez rozsyłki i bez powiadomienia', () => {
    const { preview } = sms({ startAt: '2026-11-15 10:05' });
    const later = new Date(NOW.getTime() + 6 * 60_000);
    expect(agentError(() => sendDraft(deps, ctx(later), preview.draftId, later))).toMatchObject({
      code: 'draft_stale', message: 'Termin rozsyłki minął od chwili podglądu. Przygotuj SMS ponownie z nowym terminem.',
    });
    expect(count('packages')).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
