import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/multiinfo/response.ts';
import {
  PACKAGE_POLL_MS, PACKAGE_POLL_TAIL_MS, REPORT_RETRY_MS,
  handlePackageCreate, handlePackagePoll, handlePackageReport,
} from '../../src/worker/packages.ts';
import { SEND_BACKOFF_MS } from '../../src/worker/send.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { WebhookDeliveriesRepo } from '../../src/store/webhook-deliveries.ts';
import { makeZip } from '../helpers/zip.ts';

const masterKey = randomBytes(32);
const NOW = new Date('2026-08-25T10:00:00Z');

let db: ReturnType<typeof openDatabase>;
let deps: Parameters<typeof handlePackageCreate>[1];
let accountId: number;
let apiKeyId: number;
let reportsDir: string;
let createPackage: ReturnType<typeof vi.fn>;
let packageInfo: ReturnType<typeof vi.fn>;
let packageFullInfo: ReturnType<typeof vi.fn>;
let getReport: ReturnType<typeof vi.fn>;
let invalidate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  accountId = accounts.insert({
    name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'firma_api', password: 'tajne', certPem: 'C', keyPem: 'K', caPem: null,
    certCn: 'firma_api', certIssuerCn: 'CA', certFingerprintSha1: 'AA',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info', storeContent: 1, serviceIds: ['24138'],
  });
  const apiKeys = new ApiKeysRepo(db, masterKey);
  apiKeyId = apiKeys.insert({
    accountId, name: 'rozsylki', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, webhookUrl: 'https://crm.example/hook', webhookSecret: 'sekret', serviceIds: ['24138'],
  });
  reportsDir = join(mkdtempSync(join(tmpdir(), 'mig-reports-')), 'reports');
  createPackage = vi.fn();
  packageInfo = vi.fn();
  packageFullInfo = vi.fn();
  getReport = vi.fn();
  invalidate = vi.fn();
  deps = {
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
    deliveries: new WebhookDeliveriesRepo(db), packages: new PackagesRepo(db), inbound: new InboundMessagesRepo(db), reportsDir,
    clients: { for: () => ({ createPackage, packageInfo, packageFullInfo, getReport }), invalidate, closeAll: vi.fn() } as never,
  };
});

afterEach(() => rmSync(join(reportsDir, '..'), { recursive: true, force: true }));

function seed(patch: Partial<{ startAt: string | null; orig: string | null; encoding: 'gsm' | 'ucs2'; multipart: 0 | 1 }> = {}) {
  const id = 'pkg_1';
  deps.packages.insert({
    id, apiKeyId, accountId, serviceId: '24138', defaultText: 'Domyślna', orig: patch.orig ?? 'Firma Info',
    costCenter: null, startAt: patch.startAt ?? null, deliveryReport: 1, encoding: patch.encoding ?? 'gsm',
    multipart: patch.multipart ?? 0, createdAt: NOW.toISOString(),
  }, [
    { dest: '48601135134', text: null, clientId: null },
    { dest: '48501052442', text: 'Indywidualna', clientId: 'faktura-114' },
  ]);
  return id;
}

function job(type: 'package.create' | 'package.poll' | 'package.report', attempts = 0) {
  const jobId = deps.jobs.enqueue(type, { packageId: 'pkg_1' }, NOW);
  return { id: jobId, type, payload: { packageId: 'pkg_1' }, attempts, lastError: null };
}

const lastWebhook = () => JSON.parse(deps.deliveries.listRecent(1)[0]!.payload);

describe('handlePackageCreate', () => {
  it('przekazuje odbiorców i parametry, zapisuje identyfikator i planuje pytanie o postęp', async () => {
    seed({ startAt: '2026-08-26T06:00:00.000Z', encoding: 'ucs2', multipart: 1 });
    createPackage.mockResolvedValue('14');
    await handlePackageCreate(job('package.create'), deps, NOW);
    expect(createPackage).toHaveBeenCalledWith({
      serviceId: '24138', defaultText: 'Domyślna', orig: 'Firma Info', startAt: new Date('2026-08-26T06:00:00.000Z'),
      deliveryReport: true, advancedEncoding: true, multipart: true,
      recipients: [
        { dest: '48601135134', text: null, clientId: null },
        { dest: '48501052442', text: 'Indywidualna', clientId: 'faktura-114' },
      ],
    });
    const pkg = deps.packages.get('pkg_1')!;
    expect(pkg.miPackageId).toBe('14');
    expect(pkg.status).toBe('open');
    expect(pkg.defaultText).toBe('Domyślna');
    expect(deps.jobs.claim(new Date(NOW.getTime() + PACKAGE_POLL_MS[0] - 1), 10)).toHaveLength(0);
    const [poll] = deps.jobs.claim(new Date(NOW.getTime() + PACKAGE_POLL_MS[0] + 1), 10);
    expect(poll!.type).toBe('package.poll');
    expect(poll!.payload).toEqual({ packageId: 'pkg_1' });
  });

  it('czyści treści po utworzeniu, gdy konto ich nie przechowuje', async () => {
    db.prepare('UPDATE accounts SET store_content = 0').run();
    seed();
    createPackage.mockResolvedValue('14');
    await handlePackageCreate(job('package.create'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.defaultText).toBeNull();
    expect(deps.packages.recipients('pkg_1').every((r) => r.text === null)).toBe(true);
  });

  it('przy błędzie trwałym kończy rozsyłkę i kolejkuje webhook package.completed', async () => {
    seed();
    createPackage.mockRejectedValue(new ProviderError(-63, 'Zbyt wielu odbiorców', 'permanent'));
    await handlePackageCreate(job('package.create'), deps, NOW);
    const pkg = deps.packages.get('pkg_1')!;
    expect(pkg.status).toBe('failed');
    expect(pkg.providerCode).toBe(-63);
    expect(pkg.error).toBe('Zbyt wielu odbiorców');
    expect(pkg.completedAt).toBe(NOW.toISOString());
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 1, failed: 0 });
    expect(lastWebhook()).toMatchObject({ event: 'package.completed', id: 'pkg_1', status: 'failed', providerCode: -63, recipients: 2 });
    expect(deps.jobs.claim(new Date(NOW.getTime() + 86_400_000), 10).map((j) => j.type)).toEqual(['webhook']);
  });

  it('ponawia błąd przejściowy według harmonogramu wysyłki i poddaje się po wyczerpaniu', async () => {
    seed();
    createPackage.mockRejectedValue(new ProviderError(-15, 'Brak bazy', 'transient'));
    await handlePackageCreate(job('package.create'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.status).toBe('queued');
    expect(deps.jobs.claim(new Date(NOW.getTime() + SEND_BACKOFF_MS[0] - 1), 10)).toHaveLength(0);
    const [again] = deps.jobs.claim(new Date(NOW.getTime() + SEND_BACKOFF_MS[0] + 1), 10);
    expect(again!.attempts).toBe(1);
    await handlePackageCreate({ ...again!, attempts: SEND_BACKOFF_MS.length }, deps, NOW);
    expect(deps.packages.get('pkg_1')!.status).toBe('failed');
    expect(deps.packages.get('pkg_1')!.error).toContain('Wyczerpano ponowienia');
  });

  it('wstrzymuje konto po błędzie certyfikatu i odkłada zadanie bez zużywania ponowień', async () => {
    seed();
    createPackage.mockRejectedValue(new ProviderError(-85, 'CN', 'certificate'));
    await handlePackageCreate(job('package.create'), deps, NOW);
    expect(deps.accounts.get(accountId)!.pausedReason).toMatch(/-85/);
    expect(invalidate).toHaveBeenCalledWith(accountId);
    expect(deps.packages.get('pkg_1')!.status).toBe('queued');
    const [deferred] = deps.jobs.claim(new Date(NOW.getTime() + 61_000), 10);
    expect(deferred!.attempts).toBe(0);
    // Konto wstrzymane - kolejna tura nie woła Multiinfo.
    await handlePackageCreate(deferred!, deps, NOW);
    expect(createPackage).toHaveBeenCalledTimes(1);
  });

  it('nie tworzy ponownie rozsyłki, która już wyszła', async () => {
    seed();
    deps.packages.setCreated('pkg_1', '14');
    await handlePackageCreate(job('package.create'), deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.jobs.depth()).toBe(0);
  });
});

describe('handlePackagePoll', () => {
  beforeEach(() => {
    seed();
    deps.packages.setCreated('pkg_1', '14');
  });

  it('przy statusie 2 zapisuje postęp i pyta dalej według harmonogramu', async () => {
    packageInfo.mockResolvedValue({ miPackageId: '14', saved: 2, remaining: 1, status: 2 });
    await handlePackagePoll(job('package.poll'), deps, NOW);
    expect(packageInfo).toHaveBeenCalledWith('14');
    const pkg = deps.packages.get('pkg_1')!;
    expect(pkg.status).toBe('sending');
    expect(pkg.remainingCount).toBe(1);
    expect(pkg.miStatus).toBe(2);
    expect(deps.jobs.claim(new Date(NOW.getTime() + PACKAGE_POLL_MS[1] - 1), 10)).toHaveLength(0);
    expect(deps.jobs.claim(new Date(NOW.getTime() + PACKAGE_POLL_MS[1] + 1), 10)).toHaveLength(1);
  });

  it('po wyczerpaniu harmonogramu pyta co kwadrans', async () => {
    packageInfo.mockResolvedValue({ miPackageId: '14', saved: 2, remaining: 2, status: 1 });
    await handlePackagePoll(job('package.poll', 10), deps, NOW);
    expect(deps.packages.get('pkg_1')!.status).toBe('open');
    expect(deps.jobs.claim(new Date(NOW.getTime() + PACKAGE_POLL_TAIL_MS - 1), 10)).toHaveLength(0);
    expect(deps.jobs.claim(new Date(NOW.getTime() + PACKAGE_POLL_TAIL_MS + 1), 10)).toHaveLength(1);
  });

  it('przy statusie 11 kończy rozsyłkę i zamawia raport', async () => {
    packageInfo.mockResolvedValue({ miPackageId: '14', saved: 2, remaining: 0, status: 11 });
    await handlePackagePoll(job('package.poll'), deps, NOW);
    const pkg = deps.packages.get('pkg_1')!;
    expect(pkg.status).toBe('completed');
    expect(pkg.completedAt).toBe(NOW.toISOString());
    expect(pkg.remainingCount).toBe(0);
    const jobs = deps.jobs.claim(NOW, 10);
    expect(jobs.map((j) => j.type)).toEqual(['package.report']);
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 0 });
  });

  it('przy -62 po rozpoczęciu wysyłki traktuje rozsyłkę jako zakończoną', async () => {
    deps.packages.setProgress('pkg_1', { remaining: 1, miStatus: 2, status: 'sending' });
    packageInfo.mockRejectedValue(new ProviderError(-62, 'Brak rozsyłki o podanym numerze', 'permanent'));
    await handlePackagePoll(job('package.poll'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.status).toBe('completed');
    expect(deps.jobs.claim(NOW, 10).map((j) => j.type)).toEqual(['package.report']);
  });

  it('przy statusie 12 oznacza anulowanie i kolejkuje webhook', async () => {
    packageInfo.mockResolvedValue({ miPackageId: '14', saved: 2, remaining: 2, status: 12 });
    await handlePackagePoll(job('package.poll'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.status).toBe('cancelled');
    expect(lastWebhook()).toMatchObject({ event: 'package.completed', status: 'cancelled' });
    expect(deps.jobs.claim(new Date(NOW.getTime() + 86_400_000), 10).map((j) => j.type)).toEqual(['webhook']);
  });

  it('przy innym błędzie trwałym nie przesądza o rozsyłce i pyta dalej wolniej', async () => {
    packageInfo.mockRejectedValue(new ProviderError(-14, 'Błędna wartość parametru', 'permanent'));
    await handlePackagePoll(job('package.poll'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.status).toBe('open');
    expect(deps.jobs.claim(new Date(NOW.getTime() + PACKAGE_POLL_TAIL_MS + 1), 10)).toHaveLength(1);
  });

  it('kończy zadanie dla rozsyłki już zamkniętej', async () => {
    deps.packages.setCompleted('pkg_1', NOW);
    await handlePackagePoll(job('package.poll'), deps, NOW);
    expect(packageInfo).not.toHaveBeenCalled();
    expect(deps.jobs.depth()).toBe(0);
  });
});

describe('handlePackageReport', () => {
  const CSV = '9001;48601135134;21;20260825120000\n9002;48501052442;11;20260825120001;faktura-114\n';

  beforeEach(() => {
    seed();
    deps.packages.setCreated('pkg_1', '14');
    deps.packages.setCompleted('pkg_1', NOW);
  });

  it('przy gotowym raporcie rozpakowuje ZIP, wpisuje statusy, zapisuje plik i kolejkuje webhook', async () => {
    packageFullInfo.mockResolvedValue({ reportId: '123', generation: 2, minutesLeft: 30 });
    getReport.mockResolvedValue(makeZip('raport.csv', Buffer.from(CSV)));
    await handlePackageReport(job('package.report'), deps, NOW);
    expect(packageFullInfo).toHaveBeenCalledWith('14', 'csv');
    expect(getReport).toHaveBeenCalledWith('123');
    const pkg = deps.packages.get('pkg_1')!;
    expect(pkg.reportStatus).toBe('ready');
    expect(pkg.reportId).toBe('123');
    expect(pkg.reportPath).toBe(join(reportsDir, 'pkg_1.csv'));
    expect(pkg.reportExpiresAt).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
    expect(existsSync(join(reportsDir, 'pkg_1.csv'))).toBe(true);
    expect(readFileSync(join(reportsDir, 'pkg_1.csv'), 'utf8')).toBe(CSV);
    const rec = deps.packages.recipients('pkg_1');
    expect(rec.map((r) => r.status)).toEqual(['delivered', 'failed']);
    expect(rec.map((r) => r.miId)).toEqual(['9001', '9002']);
    expect(lastWebhook()).toMatchObject({
      event: 'package.completed', id: 'pkg_1', status: 'completed', report: 'ready', recipients: 2,
      summary: { delivered: 1, failed: 1, other: 0 },
    });
    expect(deps.jobs.claim(new Date(NOW.getTime() + 86_400_000), 10).map((j) => j.type)).toEqual(['webhook']);
  });

  it('przy raporcie w przygotowaniu ponawia za minutę bez pobierania', async () => {
    packageFullInfo.mockResolvedValue({ reportId: '123', generation: 1, minutesLeft: 0 });
    await handlePackageReport(job('package.report'), deps, NOW);
    expect(getReport).not.toHaveBeenCalled();
    const pkg = deps.packages.get('pkg_1')!;
    expect(pkg.reportStatus).toBe('pending');
    expect(pkg.reportId).toBe('123');
    expect(deps.jobs.claim(new Date(NOW.getTime() + REPORT_RETRY_MS - 1), 10)).toHaveLength(0);
    expect(deps.jobs.claim(new Date(NOW.getTime() + REPORT_RETRY_MS + 1), 10)).toHaveLength(1);
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 0 });
  });

  it('przy błędzie generowania oznacza raport jako nieudany i kolejkuje webhook', async () => {
    packageFullInfo.mockResolvedValue({ reportId: '123', generation: 3, minutesLeft: 0 });
    await handlePackageReport(job('package.report'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('failed');
    expect(deps.packages.get('pkg_1')!.status).toBe('completed');
    expect(lastWebhook()).toMatchObject({ event: 'package.completed', status: 'completed', report: 'failed' });
    expect(existsSync(join(reportsDir, 'pkg_1.csv'))).toBe(false);
  });

  it('po wyczerpaniu ponowień błędu przejściowego oznacza raport jako nieudany', async () => {
    packageFullInfo.mockRejectedValue(new ProviderError(-15, 'Brak bazy', 'transient'));
    await handlePackageReport(job('package.report'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('pending');
    expect(deps.jobs.claim(new Date(NOW.getTime() + SEND_BACKOFF_MS[0] + 1), 10)).toHaveLength(1);
    await handlePackageReport(job('package.report', SEND_BACKOFF_MS.length), deps, NOW);
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('failed');
  });

  it('uszkodzoną odpowiedź traktuje jak błąd przejściowy', async () => {
    packageFullInfo.mockResolvedValue({ reportId: '123', generation: 2, minutesLeft: 30 });
    getReport.mockResolvedValue(Buffer.from('to nie jest zip'));
    await handlePackageReport(job('package.report'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('pending');
    expect(deps.jobs.claim(new Date(NOW.getTime() + SEND_BACKOFF_MS[0] + 1), 10)[0]!.lastError).toMatch(/archiwum/);
  });

  it('nie pobiera raportu ponownie, gdy jest już gotowy', async () => {
    deps.packages.setReport('pkg_1', { status: 'ready', reportId: '123' });
    await handlePackageReport(job('package.report'), deps, NOW);
    expect(packageFullInfo).not.toHaveBeenCalled();
    expect(deps.jobs.depth()).toBe(0);
  });
});
