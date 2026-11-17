import type { AuditRepo } from '../store/audit.ts';
import type { PackageRow, PackageStatus } from '../store/packages.ts';
import type { ShortLinksRepo } from '../store/short-links.ts';
import { emitWebhook } from '../worker/webhook.ts';
import { ApiError } from './errors.ts';
import type { ApiDeps } from './server.ts';

/**
 * Zależności anulowania wspólne dla API, panelu, agenta i workera. Worker otrzymuje skracacz i dziennik panelu
 * w zestawach opcjonalnych, dlatego oba pola są tu opcjonalne. API i panel przekazują je zawsze.
 */
export type CancelPackageDeps = Pick<ApiDeps, 'packages' | 'jobs' | 'apiKeys' | 'accounts' | 'deliveries'> & {
  shortLinks?: Pick<ShortLinksRepo, 'disablePackage'>;
  audit?: Pick<AuditRepo, 'record'>;
};

/** Źródło anulowania do dziennika panelu: klucz, administrator, agent albo bramka z powodem. */
export interface CancelSource {
  actor: string;
  ip?: string | null;
  /** Powód zapisany w rozsyłce, gdy anuluje ją bramka; anulowanie na żądanie nie zapisuje powodu. */
  reason?: string;
}

const PASSED = 'Rozsyłka została już przekazana do Multiinfo, które nie pozwala jej anulować.';

/** Opis stanu, w którym rozsyłki nie można anulować; komunikat `409 package_not_cancellable`. */
export function notCancellableMessage(status: PackageStatus): string {
  if (status === 'completed') return 'Rozsyłka została już zakończona, dlatego nie można jej anulować.';
  if (status === 'failed') return 'Rozsyłka zakończyła się błędem, dlatego nie można jej anulować.';
  // Stan `queued` chroni żądanie w toku, także gdy zadanie przekazania czeka na wstrzymane konto.
  if (status === 'queued') return 'Bramka przekazuje rozsyłkę do Multiinfo, dlatego nie można jej już anulować.';
  return PASSED;
}

/**
 * Anulowanie rozsyłki przechowywanej przez bramkę (`scheduled`, `overdue`). Rozsyłka już anulowana daje ten sam
 * wynik bez zmian. Przejście, usunięcie zadania przekazania, wyłączenie krótkich linków i usunięcie treści
 * na koncie bez przechowywania wykonuje jedna transakcja. Webhook `package.completed` i wpis w dzienniku panelu
 * powstają po niej, wyłącznie gdy przejście się powiodło.
 */
export function cancelPackage(deps: CancelPackageDeps, pkg: PackageRow, now: Date, by: CancelSource): { id: string; status: 'cancelled' } {
  if (pkg.status === 'cancelled') return { id: pkg.id, status: 'cancelled' };
  if (pkg.status !== 'scheduled' && pkg.status !== 'overdue') {
    throw new ApiError(409, 'package_not_cancellable', notCancellableMessage(pkg.status));
  }

  const done = deps.packages.transaction(() => {
    if (!deps.packages.cancelPending(pkg.id, now, by.reason ?? null)) return false;
    deps.jobs.removeFor('package.create', pkg.id);
    // Krótkie linki anulowanej rozsyłki prowadzą od tej chwili do strony „Link wygasł”, jak przy anulowaniu wiadomości.
    deps.shortLinks?.disablePackage(pkg.id, now);
    // Treści to dane osobowe: konto bez przechowywania nie zostawia ich po anulowaniu, tak jak po przekazaniu.
    if (deps.accounts.get(pkg.accountId)?.storeContent !== 1) deps.packages.clearTexts(pkg.id);
    return true;
  });

  if (!done) {
    // Stan zmienił się po odczycie, na przykład bramka przekazała rozsyłkę w tej samej chwili.
    const current = deps.packages.get(pkg.id);
    if (current?.status === 'cancelled') return { id: pkg.id, status: 'cancelled' };
    throw new ApiError(409, 'package_not_cancellable', notCancellableMessage(current?.status ?? pkg.status));
  }

  emitWebhook(deps, pkg.apiKeyId, 'package.completed', { id: pkg.id, recipients: pkg.recipientsCount, status: 'cancelled' }, now);
  deps.audit?.record({
    actor: by.actor, action: 'rozsylka.anulowanie', target: `rozsylka:${pkg.id}`,
    meta: { stan: pkg.status, odbiorcy: pkg.recipientsCount, termin: pkg.startAt, ...(by.reason === undefined ? {} : { powod: by.reason }) },
    ...(by.ip ? { ip: by.ip } : {}),
  });
  return { id: pkg.id, status: 'cancelled' };
}
