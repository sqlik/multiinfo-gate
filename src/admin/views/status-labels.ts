import type { GatewayStatus } from '../../multiinfo/status.ts';
import type { PackageStatus, ReportStatus } from '../../store/packages.ts';

/** Nazwy stanów widoczne dla człowieka. Wewnętrzne identyfikatory nie wychodzą do panelu. */
const LABELS: Record<GatewayStatus, string> = {
  queued: 'w kolejce',
  sent: 'w drodze',
  delivered: 'doręczona',
  failed: 'błąd',
  expired: 'przedawniona',
  cancelled: 'anulowana',
  blocked: 'zablokowana',
  throttled: 'wstrzymana limitem',
  unknown: 'nieznany',
};

export function statusLabel(status: GatewayStatus): string {
  return LABELS[status] ?? status;
}

const PACKAGE_LABELS: Record<PackageStatus, string> = {
  queued: 'w kolejce',
  open: 'otwarta',
  sending: 'w wysyłce',
  completed: 'zakończona',
  cancelled: 'anulowana',
  failed: 'błąd',
};

const REPORT_LABELS: Record<ReportStatus, string> = {
  none: '-',
  pending: 'w przygotowaniu',
  ready: 'gotowy',
  failed: 'błąd raportu',
};

export function packageStatusLabel(status: PackageStatus): string {
  return PACKAGE_LABELS[status] ?? status;
}

export function reportStatusLabel(status: ReportStatus): string {
  return REPORT_LABELS[status] ?? status;
}

export function packageStatusTone(status: PackageStatus): 'ok' | 'wait' | 'fail' {
  if (status === 'completed') return 'ok';
  if (status === 'queued' || status === 'open' || status === 'sending') return 'wait';
  return 'fail';
}

/** Kropka przy stanie: zielona dla doręczenia, żółta gdy jeszcze trwa, czerwona gdy przepadła. */
export function statusTone(status: GatewayStatus): 'ok' | 'wait' | 'fail' {
  if (status === 'delivered') return 'ok';
  if (status === 'queued' || status === 'sent' || status === 'throttled') return 'wait';
  return 'fail';
}
