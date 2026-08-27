import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
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
  return { repo, apiKeyId };
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
