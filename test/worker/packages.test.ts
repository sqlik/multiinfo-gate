import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/multiinfo/response.ts';
import {
  PACKAGE_POLL_MS, PACKAGE_POLL_TAIL_MS, REPORT_BUSY_LIMIT_MS, REPORT_RETRY_MS,
  handlePackageCreate, handlePackagePoll, handlePackageReport, overdueSweep,
} from '../../src/worker/packages.ts';
import { defaultPowerAutomateConfig } from '../../src/integrations/config.ts';
import { AgentConnectionsRepo } from '../../src/store/agent-connections.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { SEND_BACKOFF_MS } from '../../src/worker/send.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { CampaignsRepo } from '../../src/store/campaigns.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { WebhookDeliveriesRepo } from '../../src/store/webhook-deliveries.ts';
import { AuditRepo } from '../../src/store/audit.ts';
import { LinkDomainsRepo } from '../../src/store/link-domains.ts';
import { ShortLinksRepo } from '../../src/store/short-links.ts';
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
    deliveries: new WebhookDeliveriesRepo(db, masterKey), packages: new PackagesRepo(db), inbound: new InboundMessagesRepo(db), reportsDir,
    clients: { for: () => ({ createPackage, packageInfo, packageFullInfo, getReport }), invalidate, closeAll: vi.fn() } as never,
  };
});

afterEach(() => rmSync(join(reportsDir, '..'), { recursive: true, force: true }));

function seed(patch: Partial<{
  startAt: string | null; orig: string | null; encoding: 'gsm' | 'ucs2'; multipart: 0 | 1; campaignId: number | null; deliveryReport: 0 | 1;
  status: 'scheduled' | 'queued'; integrationId: number | null; agentConnectionId: number | null; origExplicit: 0 | 1;
}> = {}) {
  const id = 'pkg_1';
  deps.packages.insert({
    id, apiKeyId, accountId, serviceId: '24138', defaultText: 'Domyślna', orig: patch.orig ?? 'Firma Info',
    costCenter: null, startAt: patch.startAt ?? null, deliveryReport: patch.deliveryReport ?? 1, encoding: patch.encoding ?? 'gsm',
    multipart: patch.multipart ?? 0, createdAt: NOW.toISOString(), campaignId: patch.campaignId ?? null,
    status: patch.status ?? 'queued', integrationId: patch.integrationId ?? null, agentConnectionId: patch.agentConnectionId ?? null,
    origExplicit: patch.origExplicit ?? 0,
  }, [
    { dest: '48601135134', text: null, clientId: null },
    { dest: '48501052442', text: 'Indywidualna', clientId: 'faktura-114' },
  ]);
  return id;
}

function job(type: 'package.create' | 'package.poll' | 'package.report', attempts = 0, extra: Record<string, unknown> = {}) {
  const payload = { packageId: 'pkg_1', ...extra };
  const jobId = deps.jobs.enqueue(type, payload, NOW);
  return { id: jobId, type, payload, attempts, lastError: null };
}

/** Chwilowa odpowiedź packagefullinfo.aspx tuż po zakończeniu rozsyłki (2026-11-11). */
const REPORT_BUSY = () => new ProviderError(-13, 'Blad podczas wykonywania polecenia PackageInfo. Zla komenda', 'permanent');

const lastWebhook = () => JSON.parse(deps.deliveries.listRecent(1)[0]!.payload);

const DAY = 86_400_000;
const SENT_CSV = '9001;48601135134;3;20260825100500\n9002;48501052442;3;20260825100501;faktura-114\n';
const DELIVERED_CSV = '9001;48601135134;21;20260825101000\n9002;48501052442;21;20260825101001;faktura-114\n';

function refreshJob(attempts = 0, extra: Record<string, unknown> = {}) {
  const payload = { packageId: 'pkg_1', refresh: true, ...extra };
  return { id: deps.jobs.enqueue('package.report', payload, NOW), type: 'package.report' as const, payload, attempts, lastError: null };
}

/** Pobiera i kończy zadania z terminem do `at`, tak jak zrobiłaby to pętla robocza. */
function drain(at: Date): void {
  for (const j of deps.jobs.claim(at, 10)) deps.jobs.complete(j.id);
}

/** Rozsyłka z kampanią po pierwszym raporcie, w którym obaj odbiorcy mają stan „wysłana”. */
async function campaignPackageAfterFirstReport(minutesLeft = 30): Promise<void> {
  const campaignId = new CampaignsRepo(db).open(apiKeyId, 'przeglad-klimatyzacji-wiosna', NOW);
  seed({ campaignId });
  deps.packages.setCreated('pkg_1', '14');
  deps.packages.setCompleted('pkg_1', NOW);
  packageFullInfo.mockResolvedValueOnce({ reportId: '123', generation: 2, minutesLeft });
  getReport.mockResolvedValueOnce(makeZip('raport.csv', Buffer.from(SENT_CSV)));
  await handlePackageReport(job('package.report'), deps, NOW);
}

describe('handlePackageReport - drugi raport rozsyłki z kampanią', () => {
  it('po pierwszym raporcie kolejkuje odświeżenie 24 godziny po zakończeniu', async () => {
    await campaignPackageAfterFirstReport();
    expect(deps.packages.recipients('pkg_1').map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(deps.jobs.claim(new Date(NOW.getTime() + DAY - 1), 10).map((j) => j.type)).toEqual(['webhook']);
    const [refresh] = deps.jobs.claim(new Date(NOW.getTime() + DAY), 10);
    expect(refresh).toMatchObject({ type: 'package.report', payload: { packageId: 'pkg_1', refresh: true } });
  });

  it('odświeżenie czeka na wygaśnięcie pierwszego raportu w Multiinfo', async () => {
    await campaignPackageAfterFirstReport(2 * 24 * 60);
    deps.jobs.claim(new Date(NOW.getTime() + 2 * DAY), 10);
    expect(deps.jobs.claim(new Date(NOW.getTime() + 2 * DAY + REPORT_RETRY_MS), 10).map((j) => j.payload)).toEqual([
      { packageId: 'pkg_1', refresh: true },
    ]);
  });

  it('odświeżenie wpisuje stan doręczenia bez webhooka i bez kolejnego odświeżenia', async () => {
    await campaignPackageAfterFirstReport();
    drain(new Date(NOW.getTime() + DAY));
    packageFullInfo.mockResolvedValueOnce({ reportId: '124', generation: 2, minutesLeft: 30 });
    getReport.mockResolvedValueOnce(makeZip('raport.csv', Buffer.from(DELIVERED_CSV)));
    const later = new Date(NOW.getTime() + DAY);
    await handlePackageReport(refreshJob(), deps, later);
    expect(deps.packages.recipients('pkg_1').map((r) => r.status)).toEqual(['delivered', 'delivered']);
    const pkg = deps.packages.get('pkg_1')!;
    expect(pkg).toMatchObject({ reportStatus: 'ready', reportId: '124', reportExpiresAt: new Date(later.getTime() + 30 * 60_000).toISOString() });
    expect(readFileSync(join(reportsDir, 'pkg_1.csv'), 'utf8')).toBe(DELIVERED_CSV);
    expect(deps.deliveries.listRecent(10)).toHaveLength(1);
    expect(deps.jobs.depth()).toBe(0);
  });

  it('nieudane odświeżenie pozostawia pierwszy raport bez webhooka', async () => {
    await campaignPackageAfterFirstReport();
    drain(new Date(NOW.getTime() + DAY));
    packageFullInfo.mockResolvedValueOnce({ reportId: '124', generation: 3, minutesLeft: 0 });
    await handlePackageReport(refreshJob(), deps, new Date(NOW.getTime() + DAY));
    expect(packageFullInfo).toHaveBeenCalledTimes(2);
    expect(deps.packages.get('pkg_1')).toMatchObject({ reportStatus: 'ready', reportId: '123' });
    expect(deps.packages.recipients('pkg_1').map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(deps.deliveries.listRecent(10)).toHaveLength(1);
    expect(deps.jobs.depth()).toBe(0);
  });

  it('odświeżenie w przygotowaniu ponawia za minutę bez zmiany stanu raportu', async () => {
    await campaignPackageAfterFirstReport();
    drain(new Date(NOW.getTime() + DAY));
    packageFullInfo.mockResolvedValueOnce({ reportId: '124', generation: 1, minutesLeft: 0 });
    const later = new Date(NOW.getTime() + DAY);
    await handlePackageReport(refreshJob(), deps, later);
    expect(deps.packages.get('pkg_1')).toMatchObject({ reportStatus: 'ready', reportId: '123' });
    expect(deps.jobs.claim(new Date(later.getTime() + REPORT_RETRY_MS), 10).map((j) => j.payload)).toEqual([
      { packageId: 'pkg_1', refresh: true },
    ]);
  });

  it('kod -13 przy odświeżeniu ponawia, a po 10 minutach pozostawia pierwszy raport bez webhooka', async () => {
    await campaignPackageAfterFirstReport();
    drain(new Date(NOW.getTime() + DAY));
    const later = new Date(NOW.getTime() + DAY);
    packageFullInfo.mockRejectedValueOnce(REPORT_BUSY());
    await handlePackageReport(refreshJob(), deps, later);
    expect(deps.packages.get('pkg_1')).toMatchObject({ reportStatus: 'ready', reportId: '123' });
    expect(deps.jobs.claim(new Date(later.getTime() + REPORT_RETRY_MS + 1), 10).map((j) => j.payload)).toEqual([
      { packageId: 'pkg_1', refresh: true, reportBusySince: later.toISOString() },
    ]);
    drain(new Date(later.getTime() + DAY));
    packageFullInfo.mockRejectedValueOnce(REPORT_BUSY());
    const expired = new Date(later.getTime() + REPORT_BUSY_LIMIT_MS);
    await handlePackageReport(refreshJob(0, { reportBusySince: later.toISOString() }), deps, expired);
    expect(deps.packages.get('pkg_1')).toMatchObject({ reportStatus: 'ready', reportId: '123' });
    expect(deps.deliveries.listRecent(10)).toHaveLength(1);
    expect(deps.jobs.depth()).toBe(0);
  });

  it('rozsyłka z kampanią bez raportu doręczenia nie kolejkuje odświeżenia', async () => {
    const campaignId = new CampaignsRepo(db).open(apiKeyId, 'przeglad-klimatyzacji-wiosna', NOW);
    seed({ campaignId, deliveryReport: 0 });
    deps.packages.setCreated('pkg_1', '14');
    deps.packages.setCompleted('pkg_1', NOW);
    packageFullInfo.mockResolvedValueOnce({ reportId: '123', generation: 2, minutesLeft: 30 });
    getReport.mockResolvedValueOnce(makeZip('raport.csv', Buffer.from(SENT_CSV)));
    await handlePackageReport(job('package.report'), deps, NOW);
    expect(deps.jobs.claim(new Date(NOW.getTime() + 3 * DAY), 10).map((j) => j.type)).toEqual(['webhook']);
  });
});

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
    }, { onSent: expect.any(Function), onRejected: expect.any(Function) });
    const pkg = deps.packages.get('pkg_1')!;
    expect(pkg.miPackageId).toBe('14');
    expect(pkg.status).toBe('open');
    expect(pkg.defaultText).toBe('Domyślna');
    // Przed terminem Multiinfo trzyma rozsyłkę bez zmian, dlatego pierwsze pytanie o postęp przypada minutę po terminie.
    const term = Date.parse('2026-08-26T06:00:00.000Z');
    expect(deps.jobs.claim(new Date(term + PACKAGE_POLL_MS[0] - 1), 10)).toHaveLength(0);
    const [poll] = deps.jobs.claim(new Date(term + PACKAGE_POLL_MS[0] + 1), 10);
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

  it('wynik nieznany kończy rozsyłkę stanem failed bez ponowienia', async () => {
    seed();
    createPackage.mockRejectedValue(new ProviderError(-72, 'Multiinfo nie odpowiedziało w wyznaczonym czasie. Bramka nie ponawia rozsyłki', 'uncertain'));
    await handlePackageCreate(job('package.create'), deps, NOW);
    const pkg = deps.packages.get('pkg_1')!;
    expect(pkg.status).toBe('failed');
    expect(pkg.providerCode).toBe(-72);
    expect(pkg.error).toContain('Bramka nie ponawia rozsyłki');
    expect(lastWebhook()).toMatchObject({ event: 'package.completed', id: 'pkg_1', status: 'failed', providerCode: -72 });
    expect(deps.jobs.claim(new Date(NOW.getTime() + 86_400_000), 10).map((j) => j.type)).toEqual(['webhook']);
  });

  it('zapisuje w zadaniu przekazanie żądania, zanim nadejdzie odpowiedź Multiinfo', async () => {
    seed();
    const created = job('package.create');
    let payloadAtSend: Record<string, unknown> | undefined;
    createPackage.mockImplementation(async (_p: unknown, hooks: { onSent?: () => void }) => {
      hooks.onSent?.();
      payloadAtSend = JSON.parse((db.prepare('SELECT payload FROM jobs WHERE id = ?').get(created.id) as { payload: string }).payload);
      return '14';
    });
    await handlePackageCreate(created, deps, NOW);
    expect(payloadAtSend).toEqual({ packageId: 'pkg_1', sentAt: NOW.toISOString() });
  });

  it('sesja odrzucona przez serwer po przekazaniu zdejmuje znacznik, dlatego rozsyłka zostaje ponowiona', async () => {
    seed();
    const created = job('package.create');
    createPackage.mockImplementation(async (_p: unknown, hooks: { onSent?: () => void; onRejected?: () => void }) => {
      hooks.onSent?.();
      hooks.onRejected?.();
      throw new ProviderError(-71, 'Nie udało się połączyć: tlsv13 alert certificate required', 'transient');
    });
    await handlePackageCreate(created, deps, NOW);
    expect(deps.packages.get('pkg_1')!.status).toBe('queued');
    const [retry] = deps.jobs.claim(new Date(NOW.getTime() + 86_400_000), 10).filter((j) => j.type === 'package.create');
    expect(retry!.payload).toEqual({ packageId: 'pkg_1' });
  });

  it('błąd zapisu znacznika przekazania nie przerywa utworzenia rozsyłki', async () => {
    seed();
    vi.spyOn(deps.jobs, 'markSent').mockImplementation(() => { throw new Error('database is locked'); });
    createPackage.mockImplementation(async (_p: unknown, hooks: { onSent?: () => void }) => {
      hooks.onSent?.();
      return '14';
    });
    await handlePackageCreate(job('package.create'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.miPackageId).toBe('14');
    expect(deps.packages.get('pkg_1')!.status).toBe('open');
  });

  it('po awarii procesu w trakcie przekazania nie tworzy rozsyłki drugi raz', async () => {
    seed();
    const created = job('package.create');
    // Poprzedni proces przekazał żądanie i padł przed odpowiedzią; zadanie wraca z kolejki ze znacznikiem.
    await handlePackageCreate({ ...created, payload: { packageId: 'pkg_1', sentAt: NOW.toISOString() } }, deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    const pkg = deps.packages.get('pkg_1')!;
    expect(pkg.status).toBe('failed');
    expect(pkg.providerCode).toBe(-72);
    expect(pkg.error).toContain('Bramka nie ponawia rozsyłki');
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

  it('kod -13 przy pobieraniu raportu ponawia za minutę, a gotowy raport kończy rozsyłkę', async () => {
    packageFullInfo.mockRejectedValueOnce(REPORT_BUSY());
    await handlePackageReport(job('package.report'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('pending');
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 0 });
    expect(deps.jobs.claim(new Date(NOW.getTime() + REPORT_RETRY_MS - 1), 10)).toHaveLength(0);
    const [retry] = deps.jobs.claim(new Date(NOW.getTime() + REPORT_RETRY_MS + 1), 10);
    expect(retry!.payload).toEqual({ packageId: 'pkg_1', reportBusySince: NOW.toISOString() });
    packageFullInfo.mockResolvedValueOnce({ reportId: '123', generation: 2, minutesLeft: 30 });
    getReport.mockResolvedValueOnce(makeZip('raport.csv', Buffer.from(CSV)));
    await handlePackageReport(retry!, deps, new Date(NOW.getTime() + REPORT_RETRY_MS + 1));
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('ready');
    expect(deps.deliveries.listRecent(10)).toHaveLength(1);
    expect(lastWebhook()).toMatchObject({ event: 'package.completed', report: 'ready' });
  });

  it('kod -13 dłużej niż 10 minut kończy raport stanem nieudanym', async () => {
    packageFullInfo.mockRejectedValue(REPORT_BUSY());
    const since = { reportBusySince: NOW.toISOString() };
    await handlePackageReport(job('package.report', 9, since), deps, new Date(NOW.getTime() + REPORT_BUSY_LIMIT_MS - 1));
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('pending');
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 0 });
    await handlePackageReport(job('package.report', 10, since), deps, new Date(NOW.getTime() + REPORT_BUSY_LIMIT_MS));
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('failed');
    expect(lastWebhook()).toMatchObject({ event: 'package.completed', status: 'completed', report: 'failed', providerCode: -13 });
  });

  it('oczekiwanie na kod -13 nie zużywa ponowień, dlatego późniejszy błąd sieci jest ponawiany', async () => {
    let at = NOW;
    let current: Parameters<typeof handlePackageReport>[0] = job('package.report');
    for (let i = 0; i < SEND_BACKOFF_MS.length; i++) {
      packageFullInfo.mockRejectedValueOnce(REPORT_BUSY());
      await handlePackageReport(current, deps, at);
      at = new Date(at.getTime() + REPORT_RETRY_MS + 1);
      [current] = deps.jobs.claim(at, 10) as [typeof current];
    }
    expect(current.attempts).toBe(0);
    packageFullInfo.mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await handlePackageReport(current, deps, at);
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('pending');
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 0 });
    expect(deps.jobs.depth()).toBe(1);
  });

  it('raport w przygotowaniu nie zużywa ponowień błędu sieci', async () => {
    packageFullInfo.mockResolvedValueOnce({ reportId: '123', generation: 1, minutesLeft: 0 });
    await handlePackageReport(job('package.report'), deps, NOW);
    const [next] = deps.jobs.claim(new Date(NOW.getTime() + REPORT_RETRY_MS + 1), 10);
    expect(next!.attempts).toBe(0);
  });

  it('kod -13 przy pobieraniu pliku raportu kończy raport od razu, jak inny kod trwały', async () => {
    packageFullInfo.mockResolvedValueOnce({ reportId: '123', generation: 2, minutesLeft: 30 });
    getReport.mockRejectedValueOnce(new ProviderError(-13, 'Zla komenda', 'permanent'));
    await handlePackageReport(job('package.report'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('failed');
    expect(lastWebhook()).toMatchObject({ report: 'failed', providerCode: -13 });
  });

  it('odpowiedź inna niż -13 zdejmuje znacznik, dlatego późniejsze -13 otwiera nowe 10 minut', async () => {
    packageFullInfo.mockRejectedValueOnce(REPORT_BUSY());
    await handlePackageReport(job('package.report'), deps, NOW);
    let at = new Date(NOW.getTime() + REPORT_RETRY_MS + 1);
    let [current] = deps.jobs.claim(at, 10);
    packageFullInfo.mockResolvedValueOnce({ reportId: '123', generation: 1, minutesLeft: 0 });
    await handlePackageReport(current!, deps, at);
    at = new Date(NOW.getTime() + REPORT_BUSY_LIMIT_MS + 60_000);
    [current] = deps.jobs.claim(at, 10);
    expect(current!.payload).toEqual({ packageId: 'pkg_1' });
    packageFullInfo.mockRejectedValueOnce(REPORT_BUSY());
    await handlePackageReport(current!, deps, at);
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('pending');
    expect(deps.deliveries.counts(new Date(0))).toEqual({ pending: 0, failed: 0 });
  });

  it('inny kod trwały przy pobieraniu raportu od razu kończy raport stanem nieudanym', async () => {
    packageFullInfo.mockRejectedValueOnce(new ProviderError(-1, 'Nieznany błąd', 'permanent'));
    await handlePackageReport(job('package.report'), deps, NOW);
    expect(deps.packages.get('pkg_1')!.reportStatus).toBe('failed');
    expect(lastWebhook()).toMatchObject({ report: 'failed', providerCode: -1 });
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

describe('handlePackageCreate - rozsyłka zaplanowana', () => {
  const MIN = 60_000;
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    notify = vi.fn();
    deps.notifier = { notify };
    deps.integrations = new IntegrationsRepo(db, masterKey);
    deps.integrationEvents = new IntegrationEventsRepo(db, masterKey);
  });

  function scheduled(startAt: Date, extra: { integrationId?: number; agentConnectionId?: number; orig?: string; origExplicit?: 0 | 1 } = {}) {
    seed({ startAt: startAt.toISOString(), status: 'scheduled', ...extra });
    return job('package.create', 0, { scheduled: true });
  }
  const integration = (enabled: 0 | 1) => deps.integrations!.insert({
    name: 'Dyspozytornia', kind: 'power_automate', apiKeyId, serviceId: null, orig: null, preset: 'power-automate',
    enabled, config: defaultPowerAutomateConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
  });
  const sentFields = () => createPackage.mock.calls[0]![0] as Record<string, unknown>;

  it('przekazanie: stan queued w chwili żądania, potem open; Multiinfo otrzymuje termin rozsyłki', async () => {
    const start = at(10 * MIN);
    let statusAtRequest: string | undefined;
    createPackage.mockImplementation(async () => {
      statusAtRequest = deps.packages.get('pkg_1')!.status;
      return '28197391';
    });
    await handlePackageCreate(scheduled(start), deps, NOW);
    expect(statusAtRequest).toBe('queued');
    expect(sentFields().startAt).toEqual(start);
    expect(deps.packages.get('pkg_1')).toMatchObject({ status: 'open', miPackageId: '28197391' });
    expect(deps.jobs.claim(new Date(start.getTime() + PACKAGE_POLL_MS[0] - 1), 10)).toEqual([]);
    expect(deps.jobs.claim(new Date(start.getTime() + PACKAGE_POLL_MS[0]), 10)).toEqual([expect.objectContaining({ type: 'package.poll' })]);
  });

  it('bramka nie działała 30 min po terminie: przekazanie bez terminu po stronie Multiinfo', async () => {
    createPackage.mockResolvedValue('14');
    await handlePackageCreate(scheduled(at(-30 * MIN)), deps, NOW);
    expect(sentFields()).not.toHaveProperty('startAt');
    expect(deps.packages.get('pkg_1')!.status).toBe('open');
    expect(deps.jobs.claim(new Date(NOW.getTime() + PACKAGE_POLL_MS[0]), 10)).toEqual([expect.objectContaining({ type: 'package.poll' })]);
  });

  it('termin za 30 s w chwili przekazania: bez terminu po stronie Multiinfo', async () => {
    createPackage.mockResolvedValue('14');
    await handlePackageCreate(scheduled(at(30_000)), deps, NOW);
    expect(sentFields()).not.toHaveProperty('startAt');
  });

  it('termin dokładnie 60 s po przekazaniu: termin trafia do Multiinfo', async () => {
    createPackage.mockResolvedValue('14');
    await handlePackageCreate(scheduled(at(MIN)), deps, NOW);
    expect(sentFields().startAt).toEqual(at(MIN));
  });

  it('bramka nie działała 90 min: overdue, jedno powiadomienie package_overdue, zadanie usunięte, zero żądań package.aspx', async () => {
    await handlePackageCreate(scheduled(new Date('2026-08-25T08:30:00Z')), deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.packages.get('pkg_1')!.status).toBe('overdue');
    expect(deps.jobs.depth()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('package_overdue', 'package:pkg_1',
      'Bramka nie przekazała rozsyłki pkg_1 do 2 odbiorców w ciągu 60 minut od terminu 25.08.2026 10:30. Rozsyłka czeka na decyzję administratora w panelu bramki.', NOW);
    expect(overdueSweep(deps, at(MIN))).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('konto wstrzymane: zadanie odłożone, stan scheduled; 61 min po terminie przegląd spóźnionych przenosi w overdue', async () => {
    deps.accounts.pause(accountId, 'Certyfikat odrzucony (-85)');
    const start = at(10 * MIN);
    await handlePackageCreate(scheduled(start), deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.packages.get('pkg_1')!.status).toBe('scheduled');
    const [deferred] = deps.jobs.claim(at(MIN), 10);
    expect(deferred).toMatchObject({ type: 'package.create', attempts: 0, lastError: 'Certyfikat odrzucony (-85)' });
    deps.jobs.retry(deferred!.id, at(MIN), '');
    expect(overdueSweep(deps, new Date(start.getTime() + 60 * MIN))).toBe(0);
    expect(overdueSweep(deps, new Date(start.getTime() + 61 * MIN))).toBe(1);
    expect(deps.packages.get('pkg_1')!.status).toBe('overdue');
    expect(deps.jobs.depth()).toBe(0);
    expect(notify).toHaveBeenCalledWith('package_overdue', 'package:pkg_1', expect.stringContaining('od terminu 25.08.2026 12:10.'), expect.any(Date));
  });

  it('konto wyłączone w panelu wstrzymuje przekazanie jak konto wstrzymane', async () => {
    db.prepare('UPDATE accounts SET active = 0').run();
    await handlePackageCreate(scheduled(at(10 * MIN)), deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.packages.get('pkg_1')!.status).toBe('scheduled');
    expect(deps.jobs.claim(at(MIN), 10)).toEqual([expect.objectContaining({ type: 'package.create', attempts: 0 })]);
  });

  it('integracja zlecająca wyłączona na 5 min: rozsyłka czeka i zostaje przekazana po włączeniu', async () => {
    const integrationId = integration(0);
    const start = at(10 * MIN);
    await handlePackageCreate(scheduled(start, { integrationId }), deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.packages.get('pkg_1')!.status).toBe('scheduled');
    db.prepare('UPDATE integrations SET enabled = 1 WHERE id = ?').run(integrationId);
    const [deferred] = deps.jobs.claim(at(5 * MIN), 10);
    createPackage.mockResolvedValue('14');
    await handlePackageCreate(deferred!, deps, at(5 * MIN));
    expect(createPackage).toHaveBeenCalledTimes(1);
    expect(sentFields().startAt).toEqual(start);
    expect(deps.packages.get('pkg_1')!.status).toBe('open');
  });

  it('klucz odwołany: cancelled z powodem, webhook package.completed cancelled, wpis w dzienniku integracji', async () => {
    const integrationId = integration(1);
    db.prepare('UPDATE api_keys SET revoked_at = ?').run(at(-MIN).toISOString());
    await handlePackageCreate(scheduled(at(10 * MIN), { integrationId }), deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    const reason = 'Klucz API rozsyłki został odwołany przed przekazaniem do Multiinfo';
    expect(deps.packages.get('pkg_1')).toMatchObject({ status: 'cancelled', error: reason, completedAt: NOW.toISOString() });
    expect(lastWebhook()).toMatchObject({ event: 'package.completed', id: 'pkg_1', recipients: 2, status: 'cancelled' });
    expect(deps.integrationEvents!.list(integrationId, 10)).toEqual([expect.objectContaining({ result: 'error', reason, packageId: 'pkg_1' })]);
    expect(deps.jobs.claim(at(86_400_000), 10).map((j) => j.type)).toEqual(['webhook']);
  });

  it('anulowanie w chwili przekazania: krótkie linki wyłączone, wpis w dzienniku panelu ze źródłem „bramka” i powodem', async () => {
    const shortLinks = new ShortLinksRepo(db);
    const audit = new AuditRepo(db);
    const campaigns = new CampaignsRepo(db);
    deps.links = { campaigns, shortLinks };
    deps.audit = audit;
    const campaignId = campaigns.open(apiKeyId, 'przeglad-klimatyzacji', NOW);
    const created = scheduled(at(10 * MIN));
    const domainId = new LinkDomainsRepo(db).create({ domain: 'l.firma.pl', displayName: 'Firma', homeUrl: null, bareLinks: false }, NOW);
    shortLinks.insert({
      code: 'aB3xK9q', domainId, apiKeyId, campaignId, target: 'https://firma.pl/przeglad', utm: 0, recipientKey: 'pkg_1#1',
      messageId: null, packageId: 'pkg_1', seq: 1, dest: '48601135134', clientId: null, expiresAt: at(30 * 86_400_000).toISOString(),
      purgeAfter: at(60 * 86_400_000).toISOString(), createdAt: NOW.toISOString(),
    });
    db.prepare('UPDATE api_keys SET revoked_at = ?').run(NOW.toISOString());
    await handlePackageCreate(created, deps, NOW);
    expect(shortLinks.get('aB3xK9q')!.disabledAt).toBe(NOW.toISOString());
    expect(audit.list(10, 0)).toEqual([expect.objectContaining({
      actor: 'bramka', action: 'rozsylka.anulowanie', target: 'rozsylka:pkg_1',
      meta: expect.objectContaining({ powod: 'Klucz API rozsyłki został odwołany przed przekazaniem do Multiinfo' }),
    })]);
  });

  it('anulowanie w chwili przekazania na koncie bez przechowywania treści: treści usunięte', async () => {
    db.prepare('UPDATE accounts SET store_content = 0').run();
    const created = scheduled(at(10 * MIN));
    db.prepare('UPDATE api_keys SET revoked_at = ?').run(NOW.toISOString());
    await handlePackageCreate(created, deps, NOW);
    expect(deps.packages.get('pkg_1')!.defaultText).toBeNull();
    expect(deps.packages.recipients('pkg_1').map((r) => r.text)).toEqual([null, null]);
  });

  it('„Wyślij teraz”: klucz odwołany po decyzji administratora - failed z powodem, bez żądania do Multiinfo', async () => {
    seed({ startAt: at(-120 * MIN).toISOString(), status: 'queued' });
    const created = job('package.create', 0, { sendNow: true });
    db.prepare('UPDATE api_keys SET revoked_at = ?').run(NOW.toISOString());
    await handlePackageCreate(created, deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.packages.get('pkg_1')).toMatchObject({ status: 'failed', error: 'Klucz API rozsyłki został odwołany przed przekazaniem do Multiinfo' });
    expect(lastWebhook()).toMatchObject({ event: 'package.completed', id: 'pkg_1', status: 'failed' });
  });

  it('„Wyślij teraz”: klucz nadal obejmuje rozsyłkę - przekazanie bez terminu po stronie Multiinfo', async () => {
    createPackage.mockResolvedValue('14');
    seed({ startAt: at(-120 * MIN).toISOString(), status: 'queued' });
    await handlePackageCreate(job('package.create', 0, { sendNow: true }), deps, NOW);
    expect(sentFields()).not.toHaveProperty('startAt');
    expect(deps.packages.get('pkg_1')!.status).toBe('open');
  });

  it('klucz po terminie ważności: cancelled jak przy odwołaniu', async () => {
    db.prepare('UPDATE api_keys SET expires_at = ?').run(at(-1000).toISOString());
    await handlePackageCreate(scheduled(at(10 * MIN)), deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.packages.get('pkg_1')).toMatchObject({
      status: 'cancelled', error: 'Klucz API rozsyłki utracił ważność przed przekazaniem do Multiinfo',
    });
    expect(lastWebhook()).toMatchObject({ event: 'package.completed', status: 'cancelled' });
  });

  it('klucz nie obejmuje już usługi rozsyłki: cancelled z powodem, bez żądania', async () => {
    db.prepare('DELETE FROM api_key_services').run();
    await handlePackageCreate(scheduled(at(10 * MIN)), deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.packages.get('pkg_1')).toMatchObject({
      status: 'cancelled', error: 'Klucz API rozsyłki nie obejmuje już usługi 24138',
    });
  });

  describe('nadpis nadawcy w chwili przekazania', () => {
    beforeEach(() => {
      db.prepare("INSERT INTO account_origs (account_id, orig) VALUES (?, 'SERWIS')").run(accountId);
      db.prepare("INSERT INTO api_key_origs (api_key_id, account_id, orig) VALUES (?, ?, 'SERWIS')").run(apiKeyId, accountId);
    });

    it('jawny nadpis odebrany kluczowi po zaplanowaniu: cancelled z powodem, bez żądania', async () => {
      db.prepare('DELETE FROM api_key_origs').run();
      await handlePackageCreate(scheduled(at(10 * MIN), { orig: 'SERWIS', origExplicit: 1 }), deps, NOW);
      expect(createPackage).not.toHaveBeenCalled();
      expect(deps.packages.get('pkg_1')).toMatchObject({
        status: 'cancelled', error: 'Klucz API rozsyłki nie obejmuje już nadpisu SERWIS',
      });
    });

    it('jawny nadpis usunięty ze słownika konta: cancelled z powodem', async () => {
      db.prepare("DELETE FROM account_origs WHERE orig = 'SERWIS'").run();
      await handlePackageCreate(scheduled(at(10 * MIN), { orig: 'SERWIS', origExplicit: 1 }), deps, NOW);
      expect(createPackage).not.toHaveBeenCalled();
      expect(deps.packages.get('pkg_1')!.status).toBe('cancelled');
    });

    it('jawny nadpis nadal w kluczu: przekazanie', async () => {
      createPackage.mockResolvedValue('14');
      await handlePackageCreate(scheduled(at(10 * MIN), { orig: 'SERWIS', origExplicit: 1 }), deps, NOW);
      expect(createPackage).toHaveBeenCalledTimes(1);
      expect(deps.packages.get('pkg_1')!.status).toBe('open');
    });

    it('nadpis domyślny spoza listy klucza: przekazanie bez sprawdzania, jak przy przyjęciu', async () => {
      createPackage.mockResolvedValue('14');
      await handlePackageCreate(scheduled(at(10 * MIN), { orig: 'Dawny Nadpis', origExplicit: 0 }), deps, NOW);
      expect(createPackage).toHaveBeenCalledTimes(1);
      expect(deps.packages.get('pkg_1')!.status).toBe('open');
    });
  });

  it('zadanie ze znacznikiem scheduled po zatrzymaniu procesu między przejściem w queued a żądaniem: sprawdzenia jak przy przekazaniu', async () => {
    const created = scheduled(at(10 * MIN));
    deps.packages.beginHandover('pkg_1');
    db.prepare('UPDATE api_keys SET revoked_at = ?').run(NOW.toISOString());
    await handlePackageCreate(created, deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.packages.get('pkg_1')).toMatchObject({ status: 'cancelled', error: 'Klucz API rozsyłki został odwołany przed przekazaniem do Multiinfo' });
  });

  it('połączenie agenta odwołane: przekazanie bez zmian', async () => {
    const integrationId = integration(1);
    const connections = new AgentConnectionsRepo(db);
    const agentConnectionId = connections.insert({ integrationId, name: 'Ewa Nowak', method: 'token', expiresAt: null, createdBy: 'admin', createdAt: NOW });
    connections.revoke(agentConnectionId, 'admin', NOW);
    createPackage.mockResolvedValue('14');
    await handlePackageCreate(scheduled(at(10 * MIN), { integrationId, agentConnectionId }), deps, NOW);
    expect(createPackage).toHaveBeenCalledTimes(1);
    expect(deps.packages.get('pkg_1')!.status).toBe('open');
  });

  it('błąd sieci przed dotarciem do Multiinfo: stan scheduled, zadanie ponowione, anulowanie przed ponowieniem skuteczne', async () => {
    createPackage.mockRejectedValue(new ProviderError(-71, 'Nie udało się połączyć: ECONNRESET', 'transient'));
    await handlePackageCreate(scheduled(at(10 * MIN)), deps, NOW);
    expect(deps.packages.get('pkg_1')!.status).toBe('scheduled');
    const [again] = deps.jobs.claim(at(SEND_BACKOFF_MS[0]), 10);
    expect(again).toMatchObject({ type: 'package.create', attempts: 1, payload: { packageId: 'pkg_1', scheduled: true } });
    expect(deps.packages.cancelPending('pkg_1', at(SEND_BACKOFF_MS[0]), null)).toBe(true);
    await handlePackageCreate(again!, deps, at(SEND_BACKOFF_MS[0]));
    expect(createPackage).toHaveBeenCalledTimes(1);
    expect(deps.jobs.depth()).toBe(0);
  });

  it('błąd sieci po przekazaniu żądania: wynik nieznany kończy rozsyłkę, stan nie wraca do scheduled', async () => {
    createPackage.mockImplementation(async (_p: unknown, hooks: { onSent?: () => void }) => {
      hooks.onSent?.();
      throw new ProviderError(-71, 'Połączenie przerwane: ECONNRESET', 'transient');
    });
    await handlePackageCreate(scheduled(at(10 * MIN)), deps, NOW);
    expect(deps.packages.get('pkg_1')!.status).not.toBe('scheduled');
  });

  it('znacznik sentAt po awarii procesu: stan nie wraca do scheduled, kod -72 jak dziś', async () => {
    const created = scheduled(at(10 * MIN));
    deps.packages.beginHandover('pkg_1');
    await handlePackageCreate({ ...created, payload: { ...created.payload, sentAt: NOW.toISOString() } }, deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.packages.get('pkg_1')).toMatchObject({ status: 'failed', providerCode: -72 });
  });

  it('certyfikat odrzucony przy przekazaniu: stan scheduled, zadanie odłożone', async () => {
    createPackage.mockRejectedValue(new ProviderError(-85, 'CN', 'certificate'));
    await handlePackageCreate(scheduled(at(10 * MIN)), deps, NOW);
    expect(deps.accounts.get(accountId)!.pausedReason).toMatch(/-85/);
    expect(deps.packages.get('pkg_1')!.status).toBe('scheduled');
    expect(deps.jobs.claim(at(61_000), 10)).toEqual([expect.objectContaining({ type: 'package.create', attempts: 0 })]);
  });

  it('anulowanie między odczytem rozsyłki a beginHandover: zero żądań package.aspx', async () => {
    const created = scheduled(at(10 * MIN));
    const original = deps.packages.beginHandover.bind(deps.packages);
    vi.spyOn(deps.packages, 'beginHandover').mockImplementation((id: string) => {
      deps.packages.cancelPending(id, NOW, null);
      return original(id);
    });
    await handlePackageCreate(created, deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.packages.get('pkg_1')!.status).toBe('cancelled');
    expect(deps.jobs.depth()).toBe(0);
  });

  it('rozsyłka anulowana albo po terminie przed uruchomieniem zadania: zadanie zakończone bez żądania', async () => {
    const created = scheduled(at(10 * MIN));
    deps.packages.cancelPending('pkg_1', NOW, null);
    await handlePackageCreate(created, deps, NOW);
    expect(createPackage).not.toHaveBeenCalled();
    expect(deps.jobs.depth()).toBe(0);
  });

  it('overdue, potem sendNow i nowe zadanie: dokładnie jedno żądanie package.aspx', async () => {
    scheduled(new Date('2026-08-25T08:00:00Z'));
    expect(overdueSweep(deps, NOW)).toBe(1);
    expect(deps.jobs.depth()).toBe(0);
    expect(deps.packages.sendNow('pkg_1')).toBe(true);
    deps.jobs.enqueue('package.create', { packageId: 'pkg_1' }, NOW);
    createPackage.mockResolvedValue('14');
    for (const j of deps.jobs.claim(NOW, 10)) await handlePackageCreate(j, deps, NOW);
    expect(createPackage).toHaveBeenCalledTimes(1);
    expect(sentFields()).not.toHaveProperty('startAt');
    expect(deps.packages.get('pkg_1')!.status).toBe('open');
  });

  it('rozsyłka sprzed 1.13 w stanie open z terminem: odpytywanie bez zmian', async () => {
    seed({ startAt: at(86_400_000).toISOString() });
    deps.packages.setCreated('pkg_1', '14');
    packageInfo.mockResolvedValue({ miPackageId: '14', saved: 2, remaining: 2, status: 2 });
    await handlePackagePoll(job('package.poll'), deps, NOW);
    expect(packageInfo).toHaveBeenCalledWith('14');
    expect(deps.packages.get('pkg_1')).toMatchObject({ status: 'sending', remainingCount: 2 });
  });
});
