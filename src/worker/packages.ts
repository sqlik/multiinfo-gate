import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cancelPackage } from '../api/cancel-package.ts';
import { ApiError } from '../api/errors.ts';
import { authFromKey } from '../api/submit.ts';
import { keyOrigs } from '../api/orig.ts';
import { MI_START_MARGIN_MS, OVERDUE_AFTER_MS } from '../api/schedule.ts';
import { silentLogger, type Logger } from '../log.ts';
import { parseReport } from '../multiinfo/report.ts';
import { PACKAGE_NOT_RETRIED } from '../multiinfo/client.ts';
import { ProviderError } from '../multiinfo/response.ts';
import { pauseForCertificate } from './certificate.ts';
import { unzipFirstFile } from '../multiinfo/zip.ts';
import type { Job } from '../store/jobs.ts';
import type { AccountRow } from '../store/accounts.ts';
import type { PackageRow } from '../store/packages.ts';
import { warsawShort } from '../time/warsaw.ts';
import { SEND_BACKOFF_MS, type WorkerDeps } from './send.ts';
import { emitWebhook } from './webhook.ts';

/** Odstępy pytań o postęp rozsyłki; po wyczerpaniu - co kwadrans. */
export const PACKAGE_POLL_MS = [60_000, 120_000, 300_000, 600_000] as const;
export const PACKAGE_POLL_TAIL_MS = 900_000;

/** Raport generuje się po stronie Plusa - pytamy o niego co minutę. */
export const REPORT_RETRY_MS = 60_000;

/**
 * packagefullinfo.aspx zwraca chwilowo kod -13 „Zla komenda” tuż po zakończeniu rozsyłki, a kolejne zapytanie
 * zwraca gotowy raport (2026-11-11). Do tego limitu bramka traktuje ten kod jak raport w przygotowaniu.
 */
export const REPORT_BUSY_CODE = -13;
export const REPORT_BUSY_LIMIT_MS = 10 * 60_000;

/**
 * Rozsyłka z krótkimi linkami pobiera raport drugi raz po dobie, ponieważ potwierdzenia doręczenia
 * przychodzą także po pierwszym raporcie, a kafelek „Doręczone” kampanii liczy się z raportu.
 */
const REPORT_REFRESH_MS = 24 * 60 * 60_000;

/** Po tym czasie sprawdzamy ponownie, czy wstrzymane konto zostało odblokowane. */
const PAUSED_RECHECK_MS = 60_000;

/** Kod bramki dla rozsyłki, której utworzenia Multiinfo nie potwierdziło. */
const UNCERTAIN_CODE = -72;

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
 * Wynik `pending` oznacza, że zadanie zostało w kolejce, a `done`, że `onPermanent` je zakończyło.
 */
function handleProviderFailure(
  error: unknown, job: Job, deps: WorkerDeps, pkg: PackageRow, now: Date, log: Logger,
  onPermanent: (code: number | null, message: string) => void,
): 'pending' | 'done' {
  const provider = error instanceof ProviderError ? error : null;
  const message = error instanceof Error ? error.message : String(error);

  if (provider?.kind === 'certificate') {
    const reason = pauseForCertificate(deps, pkg.accountId, provider, log, now);
    deps.jobs.defer(job.id, new Date(now.getTime() + PAUSED_RECHECK_MS), reason);
    return 'pending';
  }

  // Wynik nieznany kończy jak błąd trwały: ponowienie mogłoby utworzyć rozsyłkę drugi raz.
  if (provider !== null && (provider.kind === 'permanent' || provider.kind === 'uncertain')) {
    onPermanent(provider.code, provider.message);
    return 'done';
  }

  // Awaria sieci, nieprzewidziany wyjątek albo błąd przejściowy - ponawiamy.
  const code = provider?.code ?? -71;
  const delay = SEND_BACKOFF_MS[job.attempts];
  if (delay === undefined) {
    onPermanent(code, `Wyczerpano ponowienia. Ostatni błąd: ${message}`);
    return 'done';
  }
  log.warn('rozsylka.blad_przejsciowy', { packageId: pkg.id, jobType: job.type, code, attempt: job.attempts + 1 });
  deps.jobs.retry(job.id, new Date(now.getTime() + delay), message);
  return 'pending';
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

const odbiorcow = (n: number): string => `${n} ${n === 1 ? 'odbiorcy' : 'odbiorców'}`;

/**
 * Przegląd spóźnionych: rozsyłki `scheduled`, których bramka nie przekazała w ciągu `OVERDUE_AFTER_MS` od terminu,
 * przechodzą w `overdue` i czekają na decyzję administratora. Zadanie przekazania znika, dlatego po decyzji
 * nie istnieją dwa zadania tej samej rozsyłki.
 */
export function overdueSweep(deps: WorkerDeps, now: Date): number {
  const log = deps.log ?? silentLogger;
  const moved = deps.packages.markOverdue(new Date(now.getTime() - OVERDUE_AFTER_MS));
  for (const pkg of moved) {
    deps.jobs.removeFor('package.create', pkg.id);
    const term = pkg.startAt === null ? '' : ` od terminu ${warsawShort(pkg.startAt)}`;
    deps.notifier?.notify('package_overdue', `package:${pkg.id}`,
      `Bramka nie przekazała rozsyłki ${pkg.id} do ${odbiorcow(pkg.recipientsCount)} w ciągu 60 minut${term}. Rozsyłka czeka na decyzję administratora w panelu bramki.`, now);
    log.warn('rozsylka.po_terminie', { packageId: pkg.id, accountId: pkg.accountId, startAt: pkg.startAt });
  }
  return moved.length;
}

/**
 * Powód anulowania zaplanowanej rozsyłki w chwili przekazania; `null`, gdy klucz i konto nadal ją obejmują.
 * Usługę i nadpis podany jawnie klucz musi obejmować tak jak przy przyjęciu, ponieważ administrator mógł je
 * odebrać po zaplanowaniu. Nadpis domyślny bramka pomija, jak `resolveOrig`. Panel sprawdza to samo przed
 * „Wyślij teraz”, a worker ponownie w chwili przekazania.
 */
export function cancelReason(deps: Pick<WorkerDeps, 'accounts' | 'apiKeys'>, pkg: PackageRow, now: Date): string | null {
  const account = deps.accounts.get(pkg.accountId);
  if (!account) return 'Konto Multiinfo rozsyłki zostało usunięte przed jej przekazaniem';
  const key = deps.apiKeys.get(pkg.apiKeyId);
  if (!key) return 'Klucz API rozsyłki został usunięty przed przekazaniem do Multiinfo';
  if (key.revokedAt !== null) return 'Klucz API rozsyłki został odwołany przed przekazaniem do Multiinfo';
  if (key.expiresAt !== null && Date.parse(key.expiresAt) <= now.getTime()) return 'Klucz API rozsyłki utracił ważność przed przekazaniem do Multiinfo';
  if (!key.allowedServiceIds.includes(pkg.serviceId)) return `Klucz API rozsyłki nie obejmuje już usługi ${pkg.serviceId}`;
  if (pkg.origExplicit === 1 && pkg.orig !== null && !keyOrigs(authFromKey(key), account, deps.accounts).allowed.includes(pkg.orig)) {
    return `Klucz API rozsyłki nie obejmuje już nadpisu ${pkg.orig}`;
  }
  return null;
}

/**
 * Przeszkoda, która wstrzymuje przekazanie bez anulowania: konto wstrzymane albo wyłączone, integracja zlecająca
 * wyłączona. Odwołanie połączenia agenta nie wstrzymuje, ponieważ wysyłkę zatwierdził człowiek.
 */
function waitReason(deps: WorkerDeps, pkg: PackageRow, account: AccountRow): string | null {
  if (account.pausedReason) return account.pausedReason;
  if (account.active === 0) return 'Konto jest wyłączone.';
  if (pkg.integrationId !== null && deps.integrations?.get(pkg.integrationId)?.enabled === 0) return 'Integracja zlecająca rozsyłkę jest wyłączona.';
  return null;
}

/**
 * Anulowanie w chwili przekazania drogą wspólną z API i panelem: webhook, krótkie linki, treści i dziennik panelu.
 * Rozsyłka anulowana albo przekazana w międzyczasie kończy tylko zadanie.
 */
function cancelBeforeHandover(deps: WorkerDeps, job: Job, pkg: PackageRow, reason: string, now: Date, log: Logger): void {
  const cancelled = deps.packages.get(pkg.id)?.status !== 'cancelled' && cancelledHere(deps, pkg, reason, now);
  if (cancelled) {
    const integration = pkg.integrationId === null ? undefined : deps.integrations?.get(pkg.integrationId);
    if (integration) {
      deps.integrationEvents?.record({
        integrationId: integration.id, at: now, result: 'error', reason, packageId: pkg.id, payload: null, logLimit: integration.config.eventLogLimit,
      });
    }
    log.warn('rozsylka.anulowana_przed_przekazaniem', { packageId: pkg.id, accountId: pkg.accountId, reason });
  }
  deps.jobs.complete(job.id);
}

/** Czy to wywołanie anulowało rozsyłkę; stan zmieniony w międzyczasie przez przekazanie nie jest błędem zadania. */
function cancelledHere(deps: WorkerDeps, pkg: PackageRow, reason: string, now: Date): boolean {
  try {
    cancelPackage({ ...deps, ...(deps.links ? { shortLinks: deps.links.shortLinks } : {}) }, pkg, now, { actor: 'bramka', reason });
    return true;
  } catch (e) {
    if (e instanceof ApiError) return false;
    throw e;
  }
}

/**
 * Sprawdzenia zaplanowanej rozsyłki w kolejności: anulowanie, spóźnienie, przeszkoda, przejście w `queued`.
 * Zwraca konto, gdy rozsyłka przeszła w `queued` i bramka może wysłać żądanie.
 */
function beginScheduledHandover(job: Job, deps: WorkerDeps, pkg: PackageRow, now: Date, log: Logger): AccountRow | null {
  const reason = cancelReason(deps, pkg, now);
  if (reason !== null) {
    cancelBeforeHandover(deps, job, pkg, reason, now, log);
    return null;
  }
  if (pkg.startAt !== null && now.getTime() - Date.parse(pkg.startAt) > OVERDUE_AFTER_MS) {
    overdueSweep(deps, now);
    deps.jobs.complete(job.id);
    return null;
  }
  const account = deps.accounts.get(pkg.accountId)!;
  const wait = waitReason(deps, pkg, account);
  if (wait !== null) {
    deps.jobs.defer(job.id, new Date(now.getTime() + PAUSED_RECHECK_MS), wait);
    return null;
  }
  // Anulowanie mogło nastąpić po odczycie rozsyłki; wtedy przejście się nie powiedzie i żądanie nie wychodzi.
  if (!deps.packages.beginHandover(pkg.id)) {
    deps.jobs.complete(job.id);
    return null;
  }
  return account;
}

export async function handlePackageCreate(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  const scheduled = job.payload.scheduled === true;
  if (scheduled) {
    let pkg = deps.packages.get(String(job.payload.packageId));
    // Rozsyłka po terminie, anulowana albo przekazana: zadanie nie ma już nic do zrobienia.
    if (!pkg || (pkg.status !== 'scheduled' && pkg.status !== 'queued')) {
      deps.jobs.complete(job.id);
      return;
    }
    // Proces zatrzymał się po przejściu w `queued`, ale przed żądaniem: rozsyłka wraca do `scheduled` i przechodzi
    // wszystkie sprawdzenia. Ze znacznikiem przekazania idzie drogą jak dziś, czyli kończy się kodem -72.
    if (pkg.status === 'queued' && typeof job.payload.sentAt !== 'string' && deps.packages.returnToScheduled(pkg.id)) {
      pkg = { ...pkg, status: 'scheduled' };
    }
    if (pkg.status === 'scheduled') {
      const account = beginScheduledHandover(job, deps, pkg, now, log);
      if (account) await createAtMultiinfo(job, deps, { ...pkg, status: 'queued' }, account.storeContent, now, log, true);
      return;
    }
  }
  const ready = prepare(job, deps, now, log);
  if (!ready) return;
  const { pkg, storeContent } = ready;
  if (pkg.status !== 'queued') {
    deps.jobs.complete(job.id);
    return;
  }
  // Poprzedni proces przekazał żądanie i zatrzymał się przed odpowiedzią. Multiinfo mogło
  // utworzyć rozsyłkę, a nie pozwala tego sprawdzić, dlatego bramka jej nie ponawia.
  if (typeof job.payload.sentAt === 'string') {
    fail(deps, job, pkg, UNCERTAIN_CODE, `Bramka zatrzymała się po przekazaniu rozsyłki do Multiinfo, zanim nadeszła odpowiedź. ${PACKAGE_NOT_RETRIED}`, now, log);
    return;
  }
  // „Wyślij teraz” przekazuje rozsyłkę przechowywaną przez bramkę, dlatego klucz musi ją nadal obejmować,
  // tak jak przy przekazaniu z terminem. Zadanie mogło czekać na wstrzymane konto, gdy administrator odwołał klucz.
  if (job.payload.sendNow === true) {
    const reason = cancelReason(deps, pkg, now);
    if (reason !== null) {
      fail(deps, job, pkg, null, reason, now, log);
      return;
    }
  }
  await createAtMultiinfo(job, deps, pkg, storeContent, now, log, scheduled);
}

/**
 * Żądanie `package.aspx`. Termin trafia do Multiinfo, gdy przypada co najmniej `MI_START_MARGIN_MS` później;
 * bliższy albo miniony termin oznacza wysyłkę natychmiastową. Pierwsze pytanie o postęp przypada minutę po terminie,
 * ponieważ do terminu Multiinfo trzyma rozsyłkę bez zmian. Zaplanowana rozsyłka, której żądanie nie dotarło
 * do Multiinfo, a zadanie zostało w kolejce, wraca do `scheduled`.
 */
async function createAtMultiinfo(
  job: Job, deps: WorkerDeps, pkg: PackageRow, storeContent: 0 | 1, now: Date, log: Logger, scheduled: boolean,
): Promise<void> {
  // Znacznik w zadaniu chroni przed powtórzeniem po awarii procesu. Jego brak nie może jednak
  // przerwać wysyłki, a wyjątek ze zdarzenia gniazda zatrzymałby cały proces. Dlatego błąd
  // zapisu trafia tylko do dziennika.
  let sent = false;
  const onSent = () => {
    sent = true;
    try {
      deps.jobs.markSent(job.id, now);
    } catch (error) {
      log.error('rozsylka.znacznik_przekazania', { packageId: pkg.id, error: error instanceof Error ? error.message : String(error) });
    }
  };
  // Serwer odrzucił sesję TLS, zanim obsłużył żądanie: rozsyłka nie powstała i może zostać ponowiona.
  const onRejected = () => {
    sent = false;
    try {
      deps.jobs.clearSent(job.id);
    } catch (error) {
      log.error('rozsylka.znacznik_przekazania', { packageId: pkg.id, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const startAt = pkg.startAt !== null && Date.parse(pkg.startAt) - now.getTime() >= MI_START_MARGIN_MS ? new Date(pkg.startAt) : undefined;

  try {
    const miPackageId = await deps.clients.for(pkg.accountId).createPackage({
      serviceId: pkg.serviceId,
      defaultText: pkg.defaultText,
      recipients: deps.packages.recipients(pkg.id).map((r) => ({ dest: r.dest, text: r.text, clientId: r.clientId })),
      ...(pkg.orig ? { orig: pkg.orig } : {}),
      ...(pkg.costCenter ? { costCenter: pkg.costCenter } : {}),
      ...(startAt ? { startAt } : {}),
      deliveryReport: pkg.deliveryReport === 1,
      advancedEncoding: pkg.encoding === 'ucs2',
      multipart: pkg.multipart === 1,
    }, { onSent, onRejected });

    deps.packages.setCreated(pkg.id, miPackageId);
    // Treści to dane osobowe - konto bez przechowywania nie zostawia ich po przekazaniu.
    if (storeContent === 0) deps.packages.clearTexts(pkg.id);
    deps.jobs.complete(job.id);
    deps.jobs.enqueue('package.poll', { packageId: pkg.id }, new Date(Math.max(now.getTime(), startAt?.getTime() ?? 0) + PACKAGE_POLL_MS[0]));
    log.info('rozsylka.utworzona', {
      packageId: pkg.id, accountId: pkg.accountId, miPackageId, recipients: pkg.recipientsCount, attempt: job.attempts + 1,
    });
  } catch (error) {
    const outcome = handleProviderFailure(error, job, deps, pkg, now, log, (code, message) => fail(deps, job, pkg, code, message, now, log));
    if (scheduled && outcome === 'pending' && !sent && deps.packages.returnToScheduled(pkg.id)) {
      log.info('rozsylka.przekazanie_odlozone', { packageId: pkg.id, attempt: job.attempts + 1 });
    }
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

/**
 * Drugi raport rozsyłki z kampanią i raportem doręczenia: dobę po zakończeniu, ale nie wcześniej niż po
 * wygaśnięciu pierwszego raportu, żeby Multiinfo przygotowało nowy raport zamiast zwrócić poprzedni.
 */
function scheduleRefresh(deps: WorkerDeps, pkg: PackageRow, reportExpiresAt: Date, now: Date): void {
  if (pkg.campaignId === null || pkg.deliveryReport !== 1) return;
  const completedAt = pkg.completedAt === null ? now.getTime() : Date.parse(pkg.completedAt);
  const at = Math.max(completedAt + REPORT_REFRESH_MS, reportExpiresAt.getTime() + REPORT_RETRY_MS);
  deps.jobs.enqueue('package.report', { packageId: pkg.id, refresh: true }, new Date(at));
}

export async function handlePackageReport(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  const ready = prepare(job, deps, now, log);
  if (!ready) return;
  const { pkg } = ready;
  // Odświeżenie pobiera raport mimo gotowego pierwszego i nie zmienia jego stanu do chwili pobrania nowego.
  const refresh = job.payload.refresh === true;
  if (pkg.miPackageId === null || (!refresh && pkg.reportStatus === 'ready')) {
    deps.jobs.complete(job.id);
    return;
  }
  if (!refresh && pkg.reportStatus !== 'pending') deps.packages.setReport(pkg.id, { status: 'pending' });

  const reportFailed = refresh
    ? (code: number | null, message: string) => {
      // Pierwszy raport pozostaje ważny, a klient otrzymał już webhook zakończenia rozsyłki.
      deps.jobs.complete(job.id);
      log.warn('rozsylka.raport_odswiezenie_nieudane', { packageId: pkg.id, code, error: message });
    }
    : (code: number | null, message: string) => {
      deps.packages.setReport(pkg.id, { status: 'failed' });
      deps.jobs.complete(job.id);
      notifyCompleted(deps, pkg, { status: pkg.status, report: 'failed', providerCode: code, error: message }, now);
      log.warn('rozsylka.raport_nieudany', { packageId: pkg.id, code, error: message });
    };

  // Kod -13 oznacza chwilową niedostępność tylko w odpowiedzi packagefullinfo.aspx, a nie przy pobieraniu pliku raportu.
  let asking = true;
  try {
    const client = deps.clients.for(pkg.accountId);
    const info = await client.packageFullInfo(pkg.miPackageId, 'csv');
    asking = false;
    // Odpowiedź inna niż -13 kończy serię, dlatego następne -13 liczy 10 minut od nowa.
    if (typeof job.payload.reportBusySince === 'string') deps.jobs.clearReportBusy(job.id);
    if (info.generation === 3) {
      reportFailed(null, 'Multiinfo nie wygenerowało raportu.');
      return;
    }
    if (info.generation !== 2) {
      if (!refresh) deps.packages.setReport(pkg.id, { status: 'pending', reportId: info.reportId });
      // Czekanie na raport nie jest błędem zadania i nie zużywa ponowień błędów sieci.
      deps.jobs.defer(job.id, new Date(now.getTime() + REPORT_RETRY_MS), 'raport w przygotowaniu');
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
    if (refresh) {
      // Ten sam identyfikator oznacza, że Multiinfo zwróciło pierwszy raport zamiast nowego.
      if (info.reportId === pkg.reportId) log.warn('rozsylka.raport_odswiezenie_ten_sam', { packageId: pkg.id, reportId: info.reportId });
      log.info('rozsylka.raport_odswiezony', { packageId: pkg.id, rows: rows.length, reportId: info.reportId });
      return;
    }
    notifyCompleted(deps, pkg, { status: pkg.status, report: 'ready', summary: deps.packages.recipientSummary(pkg.id) }, now);
    scheduleRefresh(deps, pkg, new Date(now.getTime() + info.minutesLeft * 60_000), now);
    log.info('rozsylka.raport', { packageId: pkg.id, rows: rows.length, reportId: info.reportId });
  } catch (error) {
    if (asking && error instanceof ProviderError && error.code === REPORT_BUSY_CODE) {
      const since = typeof job.payload.reportBusySince === 'string' ? Date.parse(job.payload.reportBusySince) : now.getTime();
      if (now.getTime() - since < REPORT_BUSY_LIMIT_MS) {
        deps.jobs.markReportBusy(job.id, now);
        deps.jobs.defer(job.id, new Date(now.getTime() + REPORT_RETRY_MS), `raport w przygotowaniu (kod ${REPORT_BUSY_CODE})`);
        log.warn('rozsylka.raport_chwilowy_blad', { packageId: pkg.id, code: REPORT_BUSY_CODE, refresh });
        return;
      }
    }
    handleProviderFailure(error, job, deps, pkg, now, log, reportFailed);
  }
}
