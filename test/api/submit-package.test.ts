import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors.ts';
import { HANDOVER_LEAD_MS, START_AT_MAX_MS } from '../../src/api/schedule.ts';
import { submitPackage } from '../../src/api/submit-package.ts';
import { authFromKey } from '../../src/api/submit.ts';
import { defaultPowerAutomateConfig } from '../../src/integrations/config.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { accountInput } from '../store/helpers.ts';
import { linkDeps } from '../helpers/api-deps.ts';
import { AgentConnectionsRepo } from '../../src/store/agent-connections.ts';

const NOW = new Date('2026-11-03T10:00:00Z');
let deps: Parameters<typeof submitPackage>[0];
let auth: ReturnType<typeof authFromKey>;
let integrationId: number;
let connectionId: number;

const base = { deliveryReport: true, encoding: 'auto' as const };

beforeEach(() => {
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accounts = new AccountsRepo(db, key);
  const accountId = accounts.insert(accountInput({ storeContent: 1 }));
  const apiKeys = new ApiKeysRepo(db, key);
  const apiKeyId = apiKeys.insert({ accountId, name: 'Power Automate', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
  integrationId = new IntegrationsRepo(db, key).insert({ name: 'Dyspozytornia', kind: 'power_automate', apiKeyId, serviceId: null, orig: null, preset: 'power-automate', enabled: 1, config: defaultPowerAutomateConfig(), secrets: {}, storePayloads: 0, createdAt: NOW });
  auth = authFromKey(apiKeys.get(apiKeyId)!);
  deps = { accounts, packages: new PackagesRepo(db), jobs: new JobsRepo(db), apiKeys, ...linkDeps(db) };
  connectionId = new AgentConnectionsRepo(db).insert({ integrationId, name: 'Ewa Nowak', method: 'token', expiresAt: null, createdBy: 'admin', createdAt: NOW });
});

describe('submitPackage', () => {
  it('zapisuje rozsyłkę, kolejkuje jej utworzenie i zwraca kształt odpowiedzi 202', () => {
    const out = submitPackage(deps, auth, { ...base, recipients: [{ to: '601000001' }, { to: '48601000002', text: 'Zmiana grafiku' }], defaultText: 'Przegląd floty jutro o 8:00' }, NOW);
    expect(out).toEqual({ id: expect.stringMatching(/^pkg_/), status: 'queued', recipients: 2, encoding: 'ucs2', multipart: false });
    const row = deps.packages.get(out.id)!;
    expect(row.serviceId).toBe('24138');
    expect(row.integrationId).toBeNull();
    expect(row.requestedBy).toBeNull();
    expect(deps.packages.recipients(out.id).map((r) => r.dest)).toEqual(['48601000001', '48601000002']);
    expect(deps.jobs.depth()).toBe(1);
  });

  it('zapisuje integrację i zlecającego przy rozsyłce', () => {
    const out = submitPackage(deps, auth, { ...base, recipients: [{ to: '48601000001' }], defaultText: 'x', integrationId, requestedBy: 'jan.nowak@firma.pl' }, NOW);
    const row = deps.packages.get(out.id)!;
    expect(row.integrationId).toBe(integrationId);
    expect(row.requestedBy).toBe('jan.nowak@firma.pl');
  });

  it('zapisuje połączenie agenta przy rozsyłce, bez pola połączenie jest puste', () => {
    const a = submitPackage(deps, auth, { ...base, recipients: [{ to: '601000001' }], defaultText: 'Przegląd', integrationId, agentConnectionId: connectionId }, NOW);
    const b = submitPackage(deps, auth, { ...base, recipients: [{ to: '601000002' }], defaultText: 'Przegląd' }, NOW);
    expect(deps.packages.get(a.id)!.agentConnectionId).toBe(connectionId);
    expect(deps.packages.get(b.id)!.agentConnectionId).toBeNull();
  });

  it('limit części z wywołania niższy niż klucza odrzuca treść na 2 części z indeksem odbiorcy, bez rozsyłki', () => {
    let error: unknown;
    try {
      submitPackage(deps, auth, { ...base, recipients: [{ to: '48601000001', text: 'x'.repeat(200) }], maxParts: 1 }, NOW);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('too_many_parts');
    expect((error as ApiError).message).toMatch(/^recipients\.0: /);
    expect(deps.packages.list({ limit: 10, offset: 0 })).toEqual([]);
    expect(deps.jobs.depth()).toBe(0);
  });

  it('limit części z wywołania nie podnosi limitu klucza', () => {
    expect(() => submitPackage(deps, auth, { ...base, recipients: [{ to: '48601000001', text: 'x'.repeat(1000) }], maxParts: 9 }, NOW)).toThrow(/części/);
    expect(deps.packages.list({ limit: 10, offset: 0 })).toEqual([]);
  });

  it('treści w różnych kodowaniach: każdą liczy kodowanie całej rozsyłki, więc 160 znaków GSM obok polskiej treści przekracza 1 część', () => {
    expect(() => submitPackage(deps, auth, { ...base, recipients: [{ to: '48601000001', text: 'a'.repeat(160) }, { to: '48601000002', text: 'Zażółć' }], maxParts: 1 }, NOW))
      .toThrow(expect.objectContaining({ code: 'too_many_parts', message: expect.stringMatching(/^recipients\.0: /) }));
    expect(deps.packages.list({ limit: 10, offset: 0 })).toEqual([]);
  });

  it('treści w różnych kodowaniach: znacznik wieloczęściowości z pomiaru w kodowaniu rozsyłki', () => {
    const out = submitPackage(deps, auth, { ...base, recipients: [{ to: '48601000001', text: 'a'.repeat(100) }, { to: '48601000002', text: 'ą' }] }, NOW);
    expect(out).toMatchObject({ encoding: 'ucs2', multipart: true });
  });

  it('podana treść wspólna wyznacza kodowanie także bez odbiorców, którzy jej używają, bo trafia do Multiinfo', () => {
    const out = submitPackage(deps, auth, { ...base, recipients: [{ to: '48601000001', text: 'Zmiana grafiku' }], defaultText: 'Zażółć gęślą jaźń', maxParts: 1 }, NOW);
    expect(out).toMatchObject({ encoding: 'ucs2', multipart: false });
  });

  it('powtórzony klucz idempotencji z tą samą rozsyłką zwraca pierwotną rozsyłkę bez drugiego zapisu', () => {
    const input = { ...base, recipients: [{ to: '601000001' }], defaultText: 'Przegląd floty jutro o 8:00', idempotencyKey: 'grafik-2026-11-04' };
    const first = submitPackage(deps, auth, input, NOW);
    const second = submitPackage(deps, auth, { ...input, recipients: [{ to: '48601000001' }] }, NOW);
    expect(second).toEqual(first);
    expect(deps.packages.list({ limit: 10, offset: 0 })).toHaveLength(1);
    expect(deps.jobs.depth()).toBe(1);
  });

  it('klucz idempotencji użyty z inną rozsyłką albo przez inną integrację: 409 idempotency_conflict', () => {
    const input = { ...base, recipients: [{ to: '48601000001' }], defaultText: 'x', idempotencyKey: 'grafik-2026-11-04' };
    submitPackage(deps, auth, input, NOW);
    expect(() => submitPackage(deps, auth, { ...input, defaultText: 'y' }, NOW)).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    expect(() => submitPackage(deps, auth, { ...input, integrationId }, NOW)).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    expect(deps.packages.list({ limit: 10, offset: 0 })).toHaveLength(1);
  });

  it('błąd dodania zadania cofa zapis rozsyłki', () => {
    const failing = { ...deps, jobs: { enqueue: () => { throw new Error('dysk pełny'); } } as unknown as typeof deps.jobs };
    expect(() => submitPackage(failing, auth, { ...base, recipients: [{ to: '48601000001' }], defaultText: 'x' }, NOW)).toThrow('dysk pełny');
    expect(deps.packages.list({ limit: 10, offset: 0 })).toEqual([]);
  });

  it('termin rozpoczęcia w przeszłości to start_at_in_past', () => {
    expect(() => submitPackage(deps, auth, { ...base, recipients: [{ to: '48601000001' }], defaultText: 'x', startAt: '2026-11-03T09:00:00Z' }, NOW))
      .toThrow(expect.objectContaining({ code: 'start_at_in_past' }));
  });
});

describe('submitPackage: rozsyłka z terminem', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const input = (startAt?: string) => ({ ...base, recipients: [{ to: '48601000011' }], defaultText: 'Przegląd floty jutro o 8:00', ...(startAt === undefined ? {} : { startAt }) });

  it('rozsyłka z terminem: stan scheduled, zadanie package.create ze znacznikiem scheduled i run_at = termin - HANDOVER_LEAD_MS', () => {
    expect(HANDOVER_LEAD_MS).toBe(10 * 60_000);
    const startAt = at(3 * 3600_000);
    const out = submitPackage(deps, auth, input(startAt.toISOString()), NOW);
    const handover = new Date(startAt.getTime() - HANDOVER_LEAD_MS).toISOString();
    expect(out).toMatchObject({ status: 'scheduled', startAt: startAt.toISOString(), handoverAt: handover });
    expect(deps.packages.get(out.id)!.status).toBe('scheduled');
    expect(deps.jobs.claim(new Date(Date.parse(handover) - 1), 10)).toEqual([]);
    const [job] = deps.jobs.claim(new Date(handover), 10);
    expect(job).toMatchObject({ type: 'package.create', payload: { packageId: out.id, scheduled: true } });
  });

  it('termin za 5 min: zadanie z run_at równym przyjęciu, handoverAt równe createdAt', () => {
    const out = submitPackage(deps, auth, input(at(5 * 60_000).toISOString()), NOW);
    expect(out).toMatchObject({ status: 'scheduled', handoverAt: NOW.toISOString() });
    expect(deps.jobs.claim(NOW, 10)).toEqual([expect.objectContaining({ payload: { packageId: out.id, scheduled: true } })]);
  });

  it('termin dokładnie 30 dni naprzód przyjęty; 30 dni i 1 s: ApiError 400 start_at_too_far z tekstem ze spec 4.6', () => {
    expect(START_AT_MAX_MS).toBe(30 * 86_400_000);
    expect(submitPackage(deps, auth, input(at(START_AT_MAX_MS).toISOString()), NOW).status).toBe('scheduled');
    let error: unknown;
    try {
      submitPackage(deps, auth, input(at(START_AT_MAX_MS + 1000).toISOString()), NOW);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ httpStatus: 400, code: 'start_at_too_far', message: 'Termin rozpoczęcia rozsyłki może przypadać najwyżej 30 dni od chwili wysyłki.' });
    expect(deps.packages.list({ limit: 10, offset: 0 })).toHaveLength(1);
  });

  it('termin równy chwili przyjęcia to start_at_in_past', () => {
    expect(() => submitPackage(deps, auth, input(NOW.toISOString()), NOW)).toThrow(expect.objectContaining({ code: 'start_at_in_past' }));
  });

  it('rozsyłka bez terminu: stan queued i zadanie bez znacznika, jak dziś', () => {
    const out = submitPackage(deps, auth, input(), NOW);
    expect(out).toEqual({ id: out.id, status: 'queued', recipients: 1, encoding: 'ucs2', multipart: false });
    expect(deps.packages.get(out.id)!.status).toBe('queued');
    expect(deps.jobs.claim(NOW, 10)).toEqual([expect.objectContaining({ type: 'package.create', payload: { packageId: out.id } })]);
  });

  it('powtórzenie z kluczem idempotencji zwraca bieżący stan scheduled', () => {
    const startAt = at(3600_000).toISOString();
    const req = { ...input(startAt), idempotencyKey: 'przeglad-floty-2026-11-04' };
    const first = submitPackage(deps, auth, req, NOW);
    const again = submitPackage(deps, auth, req, at(60_000));
    expect(again).toEqual(first);
    expect(again).toMatchObject({ status: 'scheduled', startAt, handoverAt: at(50 * 60_000).toISOString() });
    deps.packages.beginHandover(first.id);
    const later = submitPackage(deps, auth, req, at(120_000));
    expect(later.status).toBe('queued');
    expect(later).toMatchObject({ startAt });
    expect(later).not.toHaveProperty('handoverAt');
    expect(deps.packages.list({ limit: 10, offset: 0 })).toHaveLength(1);
  });
});
