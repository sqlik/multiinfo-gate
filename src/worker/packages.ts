import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { silentLogger, type Logger } from '../log.ts';
import { parseReport } from '../multiinfo/report.ts';
import { ProviderError } from '../multiinfo/response.ts';
import { pauseForCertificate } from './certificate.ts';
import { unzipFirstFile } from '../multiinfo/zip.ts';
import type { Job } from '../store/jobs.ts';
import type { PackageRow } from '../store/packages.ts';
import { SEND_BACKOFF_MS, type WorkerDeps } from './send.ts';
import { emitWebhook } from './webhook.ts';

/** Odstępy pytań o postęp rozsyłki; po wyczerpaniu - co kwadrans. */
export const PACKAGE_POLL_MS = [60_000, 120_000, 300_000, 600_000] as const;
export const PACKAGE_POLL_TAIL_MS = 900_000;

/** Raport generuje się po stronie Plusa - pytamy o niego co minutę. */
export const REPORT_RETRY_MS = 60_000;

/** Po tym czasie sprawdzamy ponownie, czy wstrzymane konto zostało odblokowane. */
const PAUSED_RECHECK_MS = 60_000;

/** Statusy rozsyłki w packageinfo.aspx (§7.3). */
const MI_PACKAGE = { open: 1, sending: 2, completed: 11, cancelled: 12 } as const;

/** Kod „brak rozsyłki / rozsyłka zakończona” - dla rozsyłki widzianej jako czynna znaczy: zakończona. */
const PACKAGE_GONE = -62;

const FINAL_STATUSES = new Set<PackageRow['status']>(['completed', 'cancelled', 'failed']);

/** Zakończenie rozsyłki zgłaszane odbiorcy webhooka - po raporcie albo po porażce. */
function notifyCompleted(deps: WorkerDeps, pkg: PackageRow, payload: Record<string, unknown>, now: Date): void {
  emitWebhook(deps, pkg.apiKeyId, 'package.completed', { id: pkg.id, recipients: pkg.recipientsCount, ...payload }, now);
}

function fail(deps: WorkerDeps, job: Job, pkg: PackageRow, code: number | null, error: string, now: Date, log: Logger): void {
  deps.packages.setFailed(pkg.id, code, error, now);
  deps.jobs.complete(job.id);
  notifyCompleted(deps, pkg, { status: 'failed', providerCode: code, error }, now);
  log.warn('rozsylka.nieudana', { packageId: pkg.id, accountId: pkg.accountId, code });
}

/**
 * Wspólna obsługa błędu Multiinfo dla zadań rozsyłki. Certyfikat wstrzymuje konto,
 * błąd przejściowy ponawia według harmonogramu wysyłki, trwały kończy zadanie
 * przez `onPermanent` - bo utworzenie kończy rozsyłkę, a raport tylko raport.
 */
function handleProviderFailure(
  error: unknown, job: Job, deps: WorkerDeps, pkg: PackageRow, now: Date, log: Logger,
  onPermanent: (code: number | null, message: string) => void,
): void {
  const provider = error instanceof ProviderError ? error : null;
  const message = error instanceof Error ? error.message : String(error);

  if (provider?.kind === 'certificate') {
    const reason = pauseForCertificate(deps, pkg.accountId, provider, log);
    deps.jobs.defer(job.id, new Date(now.getTime() + PAUSED_RECHECK_MS), reason);
    return;
  }

  if (provider !== null && provider.kind === 'permanent') {
    onPermanent(provider.code, provider.message);
    return;
  }

  // Awaria sieci, nieprzewidziany wyjątek albo błąd przejściowy - ponawiamy.
  const code = provider?.code ?? -71;
  const delay = SEND_BACKOFF_MS[job.attempts];
  if (delay === undefined) {
    onPermanent(code, `Wyczerpano ponowienia. Ostatni błąd: ${message}`);
    return;
  }
  log.warn('rozsylka.blad_przejsciowy', { packageId: pkg.id, jobType: job.type, code, attempt: job.attempts + 1 });
  deps.jobs.retry(job.id, new Date(now.getTime() + delay), message);
}

/** Wspólny wstęp: rozsyłka i konto muszą istnieć, konto nie może być wstrzymane ani wyłączone. */
function prepare(job: Job, deps: WorkerDeps, now: Date, log: Logger): { pkg: PackageRow; storeContent: 0 | 1 } | null {
  const pkg = deps.packages.get(String(job.payload.packageId));
  if (!pkg) {
    deps.jobs.complete(job.id);
    return null;
  }
  const account = deps.accounts.get(pkg.accountId);
  if (!account) {
    fail(deps, job, pkg, null, 'Konto nie istnieje.', now, log);
    return null;
  }
  if (account.pausedReason) {
    deps.jobs.defer(job.id, new Date(now.getTime() + PAUSED_RECHECK_MS), account.pausedReason);
    return null;
  }
  if (account.active === 0) {
    if (FINAL_STATUSES.has(pkg.status)) deps.jobs.complete(job.id);
    else fail(deps, job, pkg, null, 'Konto jest wyłączone.', now, log);
    return null;
  }
  return { pkg, storeContent: account.storeContent };
}

export async function handlePackageCreate(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  const ready = prepare(job, deps, now, log);
  if (!ready) return;
  const { pkg, storeContent } = ready;
  if (pkg.status !== 'queued') {
    deps.jobs.complete(job.id);
    return;
  }

  try {
    const miPackageId = await deps.clients.for(pkg.accountId).createPackage({
      serviceId: pkg.serviceId,
      defaultText: pkg.defaultText,
      recipients: deps.packages.recipients(pkg.id).map((r) => ({ dest: r.dest, text: r.text, clientId: r.clientId })),
      ...(pkg.orig ? { orig: pkg.orig } : {}),
      ...(pkg.costCenter ? { costCenter: pkg.costCenter } : {}),
      ...(pkg.startAt ? { startAt: new Date(pkg.startAt) } : {}),
      deliveryReport: pkg.deliveryReport === 1,
      advancedEncoding: pkg.encoding === 'ucs2',
      multipart: pkg.multipart === 1,
    });

    deps.packages.setCreated(pkg.id, miPackageId);
    // Treści to dane osobowe - konto bez przechowywania nie zostawia ich po przekazaniu.
    if (storeContent === 0) deps.packages.clearTexts(pkg.id);
    deps.jobs.complete(job.id);
    deps.jobs.enqueue('package.poll', { packageId: pkg.id }, new Date(now.getTime() + PACKAGE_POLL_MS[0]));
    log.info('rozsylka.utworzona', {
      packageId: pkg.id, accountId: pkg.accountId, miPackageId, recipients: pkg.recipientsCount, attempt: job.attempts + 1,
    });
  } catch (error) {
    handleProviderFailure(error, job, deps, pkg, now, log, (code, message) => fail(deps, job, pkg, code, message, now, log));
  }
}

function nextPoll(job: Job, now: Date): Date {
  return new Date(now.getTime() + (PACKAGE_POLL_MS[job.attempts + 1] ?? PACKAGE_POLL_TAIL_MS));
}

function complete(deps: WorkerDeps, job: Job, pkg: PackageRow, now: Date, log: Logger): void {
  deps.packages.setCompleted(pkg.id, now);
  deps.jobs.complete(job.id);
  // Raport zamawiamy zawsze: statusy wysyłki są w nim niezależnie od raportu doręczenia.
  deps.jobs.enqueue('package.report', { packageId: pkg.id }, now);
  log.info('rozsylka.zakonczona', { packageId: pkg.id, accountId: pkg.accountId });
}

export async function handlePackagePoll(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  const ready = prepare(job, deps, now, log);
  if (!ready) return;
  const { pkg } = ready;
  if (pkg.miPackageId === null || FINAL_STATUSES.has(pkg.status)) {
    deps.jobs.complete(job.id);
    return;
  }

  try {
    const info = await deps.clients.for(pkg.accountId).packageInfo(pkg.miPackageId);
    switch (info.status) {
      case MI_PACKAGE.open:
        deps.packages.setProgress(pkg.id, { remaining: info.remaining, miStatus: info.status, status: 'open' });
        break;
      case MI_PACKAGE.sending:
        deps.packages.setProgress(pkg.id, { remaining: info.remaining, miStatus: info.status, status: 'sending' });
        break;
      case MI_PACKAGE.completed:
        deps.packages.setProgress(pkg.id, { remaining: 0, miStatus: info.status, status: pkg.status });
        complete(deps, job, pkg, now, log);
        return;
      case MI_PACKAGE.cancelled:
        deps.packages.setProgress(pkg.id, { remaining: info.remaining, miStatus: info.status, status: pkg.status });
        deps.packages.setCancelled(pkg.id, now);
        deps.jobs.complete(job.id);
        notifyCompleted(deps, pkg, { status: 'cancelled' }, now);
        log.info('rozsylka.anulowana', { packageId: pkg.id, accountId: pkg.accountId });
        return;
      default:
        // Status spoza słownika: zapisujemy, co przyszło, i pytamy dalej.
        deps.packages.setProgress(pkg.id, { remaining: info.remaining, miStatus: info.status, status: pkg.status });
        log.warn('rozsylka.nieznany_status', { packageId: pkg.id, miStatus: info.status });
    }
    deps.jobs.retry(job.id, nextPoll(job, now), '');
  } catch (error) {
    if (error instanceof ProviderError && error.code === PACKAGE_GONE && (pkg.status === 'open' || pkg.status === 'sending')) {
      complete(deps, job, pkg, now, log);
      return;
    }
    handleProviderFailure(error, job, deps, pkg, now, log, (code, message) => {
      // Pytanie o postęp nie przesądza o rozsyłce - Plus mógł ją wysłać. Pytamy dalej, wolniej.
      log.warn('rozsylka.blad_odczytu', { packageId: pkg.id, code, error: message });
      deps.jobs.retry(job.id, new Date(now.getTime() + PACKAGE_POLL_TAIL_MS), message);
    });
  }
}

export async function handlePackageReport(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  const ready = prepare(job, deps, now, log);
  if (!ready) return;
  const { pkg } = ready;
  if (pkg.miPackageId === null || pkg.reportStatus === 'ready') {
    deps.jobs.complete(job.id);
    return;
  }
  if (pkg.reportStatus !== 'pending') deps.packages.setReport(pkg.id, { status: 'pending' });

  const reportFailed = (code: number | null, message: string) => {
    deps.packages.setReport(pkg.id, { status: 'failed' });
    deps.jobs.complete(job.id);
    notifyCompleted(deps, pkg, { status: pkg.status, report: 'failed', providerCode: code, error: message }, now);
    log.warn('rozsylka.raport_nieudany', { packageId: pkg.id, code, error: message });
  };

  try {
    const client = deps.clients.for(pkg.accountId);
    const info = await client.packageFullInfo(pkg.miPackageId, 'csv');
    if (info.generation === 3) {
      reportFailed(null, 'Multiinfo nie wygenerowało raportu.');
      return;
    }
    if (info.generation !== 2) {
      deps.packages.setReport(pkg.id, { status: 'pending', reportId: info.reportId });
      deps.jobs.retry(job.id, new Date(now.getTime() + REPORT_RETRY_MS), 'raport w przygotowaniu');
      return;
    }

    const archive = await client.getReport(info.reportId);
    const { data } = unzipFirstFile(archive);
    const rows = parseReport(data.toString('utf8'));
    deps.packages.applyReport(pkg.id, rows);
    const unknown = [...new Set(rows.filter((r) => r.status === 'unknown').map((r) => r.rawStatus))];
    if (unknown.length > 0) log.warn('rozsylka.raport_nieznany_status', { packageId: pkg.id, opisy: unknown });

    mkdirSync(deps.reportsDir, { recursive: true });
    const path = join(deps.reportsDir, `${pkg.id}.csv`);
    writeFileSync(path, data);

    deps.packages.setReport(pkg.id, {
      status: 'ready', reportId: info.reportId, path,
      expiresAt: new Date(now.getTime() + info.minutesLeft * 60_000).toISOString(),
    });
    deps.jobs.complete(job.id);
    notifyCompleted(deps, pkg, { status: pkg.status, report: 'ready', summary: deps.packages.recipientSummary(pkg.id) }, now);
    log.info('rozsylka.raport', { packageId: pkg.id, rows: rows.length, reportId: info.reportId });
  } catch (error) {
    handleProviderFailure(error, job, deps, pkg, now, log, reportFailed);
  }
}
