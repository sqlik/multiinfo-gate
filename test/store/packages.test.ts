import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { PENDING_STATUSES, PackagesRepo } from '../../src/store/packages.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { defaultPowerAutomateConfig } from '../../src/integrations/config.ts';
import { accountInput, testKey } from './helpers.ts';

const NOW = new Date('2026-08-25T10:00:00Z');

function setup() {
  const db = openDatabase(':memory:');
  const key = testKey();
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const apiKeyId = new ApiKeysRepo(db, key).insert({
    accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  const repo = new PackagesRepo(db);
  repo.insert({
    id: 'pkg_1', apiKeyId, accountId, serviceId: '24138', defaultText: 'Domyślna', orig: null,
    costCenter: null, startAt: null, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: NOW.toISOString(),
  }, [
    { dest: '48601135134', text: null, clientId: null },
    { dest: '48501052442', text: 'Indywidualna', clientId: 'faktura-114' },
  ]);
  return { repo, apiKeyId, accountId, db };
}

describe('PackagesRepo', () => {
  it('zapisuje rozsyłkę z odbiorcami i liczy ich', () => {
    const { repo } = setup();
    const row = repo.get('pkg_1')!;
    expect(row.status).toBe('queued');
    expect(row.recipientsCount).toBe(2);
    const rec = repo.recipients('pkg_1');
    expect(rec.map((r) => r.seq)).toEqual([1, 2]);
    expect(rec[1]!.clientId).toBe('faktura-114');
  });

  it('przechodzi przez utworzenie, postęp i zakończenie', () => {
    const { repo } = setup();
    repo.setCreated('pkg_1', '14');
    expect(repo.get('pkg_1')!.miPackageId).toBe('14');
    expect(repo.get('pkg_1')!.status).toBe('open');
    repo.setProgress('pkg_1', { remaining: 1, miStatus: 2, status: 'sending' });
    expect(repo.get('pkg_1')!.remainingCount).toBe(1);
    repo.setCompleted('pkg_1', NOW);
    expect(repo.get('pkg_1')!.status).toBe('completed');
    expect(repo.get('pkg_1')!.completedAt).toBe(NOW.toISOString());
  });

  it('odnotowuje anulowanie i błąd z kodem operatora', () => {
    const { repo } = setup();
    repo.setCancelled('pkg_1', NOW);
    expect(repo.get('pkg_1')!.status).toBe('cancelled');
    repo.setFailed('pkg_1', -63, 'Zbyt wielu odbiorców', NOW);
    const row = repo.get('pkg_1')!;
    expect(row.status).toBe('failed');
    expect(row.providerCode).toBe(-63);
    expect(row.error).toBe('Zbyt wielu odbiorców');
    expect(row.completedAt).toBe(NOW.toISOString());
  });

  it('setReport nie kasuje wcześniej zapisanych pól raportu', () => {
    const { repo } = setup();
    repo.setReport('pkg_1', { status: 'pending', reportId: '123' });
    repo.setReport('pkg_1', { status: 'ready', path: '/dane/reports/pkg_1.csv', expiresAt: '2026-08-25T11:00:00.000Z' });
    const row = repo.get('pkg_1')!;
    expect(row.reportStatus).toBe('ready');
    expect(row.reportId).toBe('123');
    expect(row.reportPath).toBe('/dane/reports/pkg_1.csv');
    expect(row.reportExpiresAt).toBe('2026-08-25T11:00:00.000Z');
  });

  it('wpisuje wynik raportu do odbiorców po numerze i identyfikatorze klienta', () => {
    const { repo } = setup();
    repo.applyReport('pkg_1', [
      { miId: '9001', dest: '48601135134', miStatus: 21, status: 'delivered', rawStatus: '21', changedAt: '2026-08-25 12:00:00', clientId: null },
      { miId: '9002', dest: '48501052442', miStatus: 11, status: 'failed', rawStatus: '11', changedAt: '2026-08-25 12:00:01', clientId: 'faktura-114' },
    ]);
    const rec = repo.recipients('pkg_1');
    expect(rec[0]!.miId).toBe('9001');
    expect(rec[0]!.status).toBe('delivered');
    expect(rec[0]!.statusChangedAt).toBe('2026-08-25 12:00:00');
    expect(rec[1]!.status).toBe('failed');
    expect(repo.recipientSummary('pkg_1')).toEqual({ delivered: 1, failed: 1, other: 0 });
  });

  it('wiersz raportu z obcym identyfikatorem klienta nie nadpisuje odbiorcy', () => {
    const { repo } = setup();
    repo.applyReport('pkg_1', [
      { miId: '9002', dest: '48501052442', miStatus: 11, status: 'failed', rawStatus: '11', changedAt: '2026-08-25 12:00:01', clientId: 'inna' },
    ]);
    expect(repo.recipients('pkg_1')[1]!.miId).toBeNull();
    expect(repo.recipientSummary('pkg_1')).toEqual({ delivered: 0, failed: 0, other: 2 });
  });

  it('wiersz bez identyfikatora klienta nie nadpisuje odbiorcy z identyfikatorem o tym samym numerze', () => {
    // Prawdziwy raport z 2026-08-26: ten sam numer dwa razy, raz z clientId, raz bez - każdy z własnym Id.
    const { repo, apiKeyId } = setup();
    repo.insert({
      id: 'pkg_2', apiKeyId, accountId: 1, serviceId: '24138', defaultText: 'Domyślna', orig: null,
      costCenter: null, startAt: null, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: NOW.toISOString(),
    }, [
      { dest: '48601000001', text: 'Indywidualna', clientId: 'test-2' },
      { dest: '48601000001', text: null, clientId: null },
    ]);
    repo.applyReport('pkg_2', [
      { miId: '2142633385', dest: '48601000001', miStatus: 21, status: 'delivered', rawStatus: 'Doręczono', changedAt: '2026-08-26 17:39:26', clientId: 'test-2' },
      { miId: '2142633386', dest: '48601000001', miStatus: 21, status: 'delivered', rawStatus: 'Doręczono', changedAt: '2026-08-26 17:39:26', clientId: null },
    ]);
    expect(repo.recipients('pkg_2').map((r) => r.miId)).toEqual(['2142633385', '2142633386']);
  });

  it('raport bez kolumny identyfikatora klienta dopasowuje odbiorców z identyfikatorem po numerze', () => {
    const { repo } = setup();
    repo.applyReport('pkg_1', [
      { miId: '9002', dest: '48501052442', miStatus: 21, status: 'delivered', rawStatus: '21', changedAt: '2026-08-25 12:00:01', clientId: null },
    ]);
    expect(repo.recipients('pkg_1')[1]!.miId).toBe('9002');
  });

  it('czyści treści po utworzeniu, gdy konto ich nie przechowuje', () => {
    const { repo } = setup();
    repo.clearTexts('pkg_1');
    expect(repo.get('pkg_1')!.defaultText).toBeNull();
    expect(repo.recipients('pkg_1').every((r) => r.text === null)).toBe(true);
  });

  it('listuje rozsyłki klucza od najnowszej', () => {
    const { repo, apiKeyId } = setup();
    expect(repo.list({ apiKeyId, limit: 10, offset: 0 }).map((p) => p.id)).toEqual(['pkg_1']);
    expect(repo.list({ apiKeyId: apiKeyId + 1, limit: 10, offset: 0 })).toEqual([]);
    expect(repo.list({ limit: 10, offset: 0 })).toHaveLength(1);
  });
});

describe('PackagesRepo.countSince', () => {
  it('liczy rozsyłki z okna i ich odbiorców we wszystkich stanach', () => {
    const { repo, apiKeyId, accountId } = setup();
    const add = (id: string, createdAt: Date, dests: string[]) => repo.insert({
      id, apiKeyId, accountId, serviceId: '24138', defaultText: 'Przegląd serwisowy', orig: null,
      costCenter: null, startAt: null, deliveryReport: 0, encoding: 'gsm', multipart: 0, createdAt: createdAt.toISOString(),
    }, dests.map((dest) => ({ dest, text: null, clientId: null })));
    add('pkg_2', new Date(NOW.getTime() - 25 * 3600_000), ['48601000001', '48601000002']);
    add('pkg_3', NOW, ['48601000003']);
    repo.setFailed('pkg_3', -63, 'Zbyt wielu odbiorców', NOW);
    expect(repo.countSince(new Date(NOW.getTime() - 24 * 3600_000))).toEqual({ packages: 2, recipients: 3 });
  });

  it('bez rozsyłek w oknie zwraca zera', () => {
    const repo = new PackagesRepo(openDatabase(':memory:'));
    expect(repo.countSince(NOW)).toEqual({ packages: 0, recipients: 0 });
  });
});

describe('PackagesRepo: odczyty agenta', () => {
  it('recipientsTo i lastRecipientBefore szukają odbiorców rozsyłek klucza po numerze i czasie', () => {
    const { repo, apiKeyId } = setup();
    expect(repo.recipientsTo(apiKeyId, '48501052442', '2026-08-25T00:00:00.000Z', '2026-08-26T00:00:00.000Z'))
      .toMatchObject([{ packageId: 'pkg_1', seq: 2, clientId: 'faktura-114' }]);
    expect(repo.recipientsTo(apiKeyId, '48501052442', '2026-08-25T10:00:00.001Z', '2026-08-26T00:00:00.000Z')).toEqual([]);
    expect(repo.recipientsTo(apiKeyId + 1, '48501052442', '2026-08-25T00:00:00.000Z', '2026-08-26T00:00:00.000Z')).toEqual([]);
    expect(repo.lastRecipientBefore(apiKeyId, '48601135134', new Date('2026-08-25T11:00:00Z'), new Date('2026-08-18T11:00:00Z')))
      .toEqual({ packageId: 'pkg_1', createdAt: NOW.toISOString() });
    expect(repo.lastRecipientBefore(apiKeyId, '48601135134', NOW, new Date('2026-08-18T11:00:00Z'))).toBeUndefined();
  });

  it('recipients z przesunięciem podaje kolejną porcję odbiorców', () => {
    const { repo } = setup();
    expect(repo.recipients('pkg_1', 1, 1).map((r) => r.seq)).toEqual([2]);
  });

  it('reportBreakdown: stany, przyczyny i doręczenia w godzinach według daty stanu', () => {
    const { repo } = setup();
    repo.applyReport('pkg_1', [
      { miId: '1', dest: '48601135134', miStatus: 21, status: 'delivered', rawStatus: 'Doręczono', changedAt: '2026-08-25 12:05:00', clientId: null },
      { miId: '2', dest: '48501052442', miStatus: 20, status: 'blocked', rawStatus: '20', changedAt: '2026-08-25 12:06:00', clientId: 'faktura-114' },
    ]);
    expect(repo.reportBreakdown('pkg_1')).toEqual({
      byStatus: { delivered: 1, blocked: 1 },
      reasons: [{ miStatus: 20, description: 'Numer odbiorcy znajduje się na czarnej liście', count: 1 }],
      deliveredByHour: [{ hour: '2026-08-25 12:00', count: 1 }],
    });
  });
});

describe('PackagesRepo: rozsyłka z terminem', () => {
  const T = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
  function add(ctx: ReturnType<typeof setup>, id: string, status: 'scheduled' | 'queued', startAt: string | null, extra: { integrationId?: number; apiKeyId?: number } = {}) {
    ctx.repo.insert({
      id, apiKeyId: extra.apiKeyId ?? ctx.apiKeyId, accountId: ctx.accountId, serviceId: '24138', defaultText: 'Przegląd floty', orig: null,
      costCenter: null, startAt, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: NOW.toISOString(), status,
      integrationId: extra.integrationId ?? null,
    }, [{ dest: '48601000011', text: null, clientId: null }]);
  }

  it('zapisuje rozsyłkę w stanie podanym przy zapisie', () => {
    const ctx = setup();
    add(ctx, 'pkg_s', 'scheduled', T(60));
    expect(ctx.repo.get('pkg_s')!.status).toBe('scheduled');
  });

  it('beginHandover: pierwsze wywołanie true, drugie false', () => {
    const ctx = setup();
    add(ctx, 'pkg_s', 'scheduled', T(60));
    expect(ctx.repo.beginHandover('pkg_s')).toBe(true);
    expect(ctx.repo.get('pkg_s')!.status).toBe('queued');
    expect(ctx.repo.beginHandover('pkg_s')).toBe(false);
  });

  it('cancelPending po beginHandover: false; beginHandover po cancelPending: false', () => {
    const ctx = setup();
    add(ctx, 'pkg_a', 'scheduled', T(60));
    add(ctx, 'pkg_b', 'scheduled', T(60));
    expect(ctx.repo.beginHandover('pkg_a')).toBe(true);
    expect(ctx.repo.cancelPending('pkg_a', NOW, null)).toBe(false);
    expect(ctx.repo.get('pkg_a')!.status).toBe('queued');
    expect(ctx.repo.cancelPending('pkg_b', NOW, 'Klucz API został odwołany')).toBe(true);
    expect(ctx.repo.beginHandover('pkg_b')).toBe(false);
    expect(ctx.repo.get('pkg_b')).toMatchObject({ status: 'cancelled', completedAt: NOW.toISOString(), error: 'Klucz API został odwołany' });
  });

  it('cancelPending anuluje także rozsyłkę po terminie, ale nie rozsyłkę bez terminu w kolejce', () => {
    const ctx = setup();
    add(ctx, 'pkg_o', 'scheduled', T(-120));
    ctx.repo.markOverdue(new Date(T(-60)));
    expect(ctx.repo.cancelPending('pkg_o', NOW, null)).toBe(true);
    expect(ctx.repo.get('pkg_o')).toMatchObject({ status: 'cancelled', error: null });
    expect(ctx.repo.cancelPending('pkg_1', NOW, null)).toBe(false);
    expect(ctx.repo.get('pkg_1')!.status).toBe('queued');
  });

  it('returnToScheduled cofa przekazanie, które nie dotarło do Multiinfo', () => {
    const ctx = setup();
    add(ctx, 'pkg_s', 'scheduled', T(60));
    ctx.repo.beginHandover('pkg_s');
    expect(ctx.repo.returnToScheduled('pkg_s')).toBe(true);
    expect(ctx.repo.get('pkg_s')!.status).toBe('scheduled');
  });

  it('returnToScheduled nie cofa rozsyłki z mi_package_id', () => {
    const ctx = setup();
    add(ctx, 'pkg_s', 'scheduled', T(60));
    ctx.repo.beginHandover('pkg_s');
    ctx.db.prepare("UPDATE packages SET mi_package_id = '28197391' WHERE id = 'pkg_s'").run();
    expect(ctx.repo.returnToScheduled('pkg_s')).toBe(false);
    expect(ctx.repo.get('pkg_s')!.status).toBe('queued');
    expect(ctx.repo.returnToScheduled('pkg_1')).toBe(false);
  });

  it('markOverdue: wyłącznie scheduled z terminem starszym niż granica, zwraca przeniesione wiersze', () => {
    const ctx = setup();
    add(ctx, 'pkg_old', 'scheduled', T(-61));
    add(ctx, 'pkg_edge', 'scheduled', T(-60));
    add(ctx, 'pkg_future', 'scheduled', T(30));
    add(ctx, 'pkg_queued', 'queued', T(-120));
    const moved = ctx.repo.markOverdue(new Date(T(-60)));
    expect(moved.map((p) => [p.id, p.status])).toEqual([['pkg_old', 'overdue']]);
    expect(ctx.repo.get('pkg_edge')!.status).toBe('scheduled');
    expect(ctx.repo.get('pkg_future')!.status).toBe('scheduled');
    expect(ctx.repo.get('pkg_queued')!.status).toBe('queued');
    expect(ctx.repo.markOverdue(new Date(T(-60)))).toEqual([]);
  });

  it('sendNow: overdue → queued; z scheduled false', () => {
    const ctx = setup();
    add(ctx, 'pkg_o', 'scheduled', T(-120));
    add(ctx, 'pkg_s', 'scheduled', T(60));
    ctx.repo.markOverdue(new Date(T(-60)));
    expect(ctx.repo.sendNow('pkg_o')).toBe(true);
    expect(ctx.repo.get('pkg_o')!.status).toBe('queued');
    expect(ctx.repo.sendNow('pkg_o')).toBe(false);
    expect(ctx.repo.sendNow('pkg_s')).toBe(false);
    expect(ctx.repo.get('pkg_s')!.status).toBe('scheduled');
  });

  it('list z filtrem statuses i kluczem', () => {
    const ctx = setup();
    const otherKey = new ApiKeysRepo(ctx.db, testKey()).insert({
      accountId: ctx.accountId, name: 'k2', keyHash: 'h2', keyPrefix: 'p2', defaultServiceId: '24138', defaultOrig: null,
      maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
    });
    add(ctx, 'pkg_s', 'scheduled', T(60));
    add(ctx, 'pkg_o', 'scheduled', T(-120));
    add(ctx, 'pkg_x', 'scheduled', T(60), { apiKeyId: otherKey });
    ctx.repo.markOverdue(new Date(T(-60)));
    const ids = (statuses: Array<'scheduled' | 'overdue' | 'queued'>, apiKeyId?: number) =>
      ctx.repo.list({ statuses, ...(apiKeyId === undefined ? {} : { apiKeyId }), limit: 10, offset: 0 }).map((p) => p.id).sort();
    expect(ids(['scheduled'])).toEqual(['pkg_s', 'pkg_x']);
    expect(ids(['scheduled', 'overdue'], ctx.apiKeyId)).toEqual(['pkg_o', 'pkg_s']);
    expect(ids(['queued'], ctx.apiKeyId)).toEqual(['pkg_1']);
    expect(ctx.repo.list({ statuses: [], limit: 10, offset: 0 })).toHaveLength(4);
  });

  it('countByStatus liczy rozsyłki w stanie', () => {
    const ctx = setup();
    add(ctx, 'pkg_s1', 'scheduled', T(60));
    add(ctx, 'pkg_s2', 'scheduled', T(-120));
    ctx.repo.markOverdue(new Date(T(-60)));
    expect(ctx.repo.countByStatus('scheduled')).toBe(1);
    expect(ctx.repo.countByStatus('overdue')).toBe(1);
    expect(ctx.repo.countByStatus('queued')).toBe(1);
  });

  it('pendingOfIntegration zwraca rozsyłki integracji w stanach scheduled i overdue', () => {
    const ctx = setup();
    const integrationId = new IntegrationsRepo(ctx.db, testKey()).insert({
      name: 'Dyspozytornia', kind: 'power_automate', apiKeyId: ctx.apiKeyId, serviceId: null, orig: null, preset: 'power-automate',
      enabled: 1, config: defaultPowerAutomateConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    add(ctx, 'pkg_s', 'scheduled', T(60), { integrationId });
    add(ctx, 'pkg_o', 'scheduled', T(-120), { integrationId });
    add(ctx, 'pkg_q', 'queued', null, { integrationId });
    add(ctx, 'pkg_other', 'scheduled', T(60));
    ctx.repo.markOverdue(new Date(T(-60)));
    expect(ctx.repo.pendingOfIntegration(integrationId).map((p) => p.id).sort()).toEqual(['pkg_o', 'pkg_s']);
  });

  it('PENDING_STATUSES obejmuje scheduled i overdue', () => {
    expect([...PENDING_STATUSES].sort()).toEqual(['overdue', 'scheduled']);
  });
});
