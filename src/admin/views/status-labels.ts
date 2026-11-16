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

/**
 * Etapy przebiegu: rodzaje z `message_events` zapisywane przez API, worker i anulowanie oraz etapy odbiorcy rozsyłki.
 * Wspólne dla osi czasu w panelu i przebiegu doręczenia w odczytach agenta.
 */
const STAGE_LABELS: Record<string, string> = {
  queued: 'Przyjęta przez bramkę, zapisana w kolejce',
  sent: 'Przekazana do Multiinfo',
  retry: 'Ponowienie',
  paused: 'Konto wstrzymane',
  status: 'Multiinfo',
  failed: 'Niepowodzenie',
  expired: 'Przedawniona',
  cancelled: 'Anulowana',
  cancel_partial: 'Anulowanie częściowe',
  cancel_failed: 'Anulowanie nieskuteczne',
  abandoned: 'Odpytywanie przerwane',
  webhook: 'Webhook zakolejkowany',
  final: 'Stan ostateczny',
  package_queued: 'Rozsyłka przyjęta przez bramkę',
  package_completed: 'Rozsyłka zakończona w Multiinfo',
  package_cancelled: 'Rozsyłka anulowana',
  package_failed: 'Rozsyłka nieudana',
  report: 'Stan z raportu',
};

/** Nazwa etapu przebiegu; rodzaj spoza listy zostaje bez zmian. */
export function stageLabel(kind: string): string {
  return STAGE_LABELS[kind] ?? kind;
}

const PACKAGE_LABELS: Record<PackageStatus, string> = {
  scheduled: 'zaplanowana',
  overdue: 'termin minął',
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
  if (status === 'scheduled' || status === 'queued' || status === 'open' || status === 'sending') return 'wait';
  return 'fail';
}

/** Kropka przy stanie: zielona dla doręczenia, żółta gdy jeszcze trwa, czerwona gdy przepadła. */
export function statusTone(status: GatewayStatus): 'ok' | 'wait' | 'fail' {
  if (status === 'delivered') return 'ok';
  if (status === 'queued' || status === 'sent' || status === 'throttled') return 'wait';
  return 'fail';
}
