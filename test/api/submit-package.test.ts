import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors.ts';
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

const NOW = new Date('2026-11-03T10:00:00Z');
let deps: Parameters<typeof submitPackage>[0];
let auth: ReturnType<typeof authFromKey>;
let integrationId: number;

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
  deps = { accounts, packages: new PackagesRepo(db), jobs: new JobsRepo(db) };
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
