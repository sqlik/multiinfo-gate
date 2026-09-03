import type { QueueRow, SmtpSettings } from '../store/notifications.ts';
import type { ReleaseInfo } from '../store/settings.ts';
import { GATE_VERSION } from '../version.ts';
import { warsawDay, warsawStamp, warsawTime } from '../time/warsaw.ts';
import { eventLabel, type NotificationEvent } from './rules.ts';

export interface Mail { subject: string; text: string }

/** Ile pozycji trafia do maila zgrupowanego; reszta jako liczba. */
export const GROUP_LINES = 100;

/** Ekran panelu właściwy dla zdarzenia - odnośnik w mailu, gdy administrator podał adres panelu. */
const PANEL_PATH: Record<NotificationEvent, string> = {
  integration_error: '/integracje', integration_throttled: '/integracje', webhook_undelivered: '/integracje',
  certificate_expiring: '/konta', account_rejecting: '/konta', inbound_failure: '/odebrane', daily_summary: '/przeglad',
  release_available: '/przeglad',
};

type Settings = Pick<SmtpSettings, 'instanceName' | 'panelUrl'>;

const subjectOf = (s: Settings, rest: string): string => `[Multiinfo Gate ${s.instanceName}] ${rest}`;

function footer(s: Settings, event: NotificationEvent): string[] {
  const lines: string[] = [''];
  if (s.panelUrl) lines.push(`Panel: ${s.panelUrl.replace(/\/$/, '')}${PANEL_PATH[event]}`);
  lines.push(`Wiadomość wysłana automatycznie przez Multiinfo Gate (instancja ${s.instanceName}).`);
  return lines;
}

/**
 * Treść to zwykły tekst po polsku. Do maila trafia nazwa integracji albo konta, rodzaj błędu, czas
 * i identyfikator wiadomości - nigdy treść SMS-a, ładunek ani pełny numer. O to dba wołający,
 * składając `summary`; tu tylko układ.
 */
export function composeSingle(s: Settings, event: NotificationEvent, row: Pick<QueueRow, 'at' | 'summary'>, suppressed: number): Mail {
  const lines = [eventLabel(event), '', `Czas: ${warsawStamp(row.at)}`, row.summary];
  if (suppressed > 0) lines.push('', `Pominięto ${suppressed} podobnych powiadomień w ostatniej godzinie (limit reguły).`);
  return { subject: subjectOf(s, eventLabel(event)), text: [...lines, ...footer(s, event)].join('\n') };
}

export function composeGroup(s: Settings, event: NotificationEvent, rows: Array<Pick<QueueRow, 'at' | 'summary'>>, suppressed: number): Mail {
  const shown = rows.slice(0, GROUP_LINES);
  const lines = [`${eventLabel(event)}: ${rows.length}`, ''];
  for (const r of shown) lines.push(`- ${warsawStamp(r.at)}  ${r.summary}`);
  if (rows.length > shown.length) lines.push(`...i ${rows.length - shown.length} więcej`);
  if (suppressed > 0) lines.push('', `Pominięto ${suppressed} podobnych powiadomień (limit reguły).`);
  return { subject: subjectOf(s, `${eventLabel(event)}: ${rows.length}`), text: [...lines, ...footer(s, event)].join('\n') };
}

export interface DailyData {
  day: string;
  messages: { total: number; delivered: number; failed: number; cancelled: number; transit: number };
  inbound: number;
  integrationsTroubled: number;
  deliveries: { pending: number; failed: number };
  accounts: Array<{ name: string; paused: string | null; certificateDaysLeft: number }>;
  /** Nowsze wydanie bramki, jeżeli jest do pokazania. */
  release?: ReleaseInfo | null;
}

export function composeDaily(s: Settings, d: DailyData): Mail {
  const lines = [
    `Podsumowanie dzienne - ${d.day}`, '',
    'SMS-y (ostatnia doba):',
    `- przyjęte: ${d.messages.total}`,
    `- dostarczone: ${d.messages.delivered}`,
    `- nieudane: ${d.messages.failed}`,
    `- anulowane: ${d.messages.cancelled}`,
    `- w toku: ${d.messages.transit}`,
    `Odebrane: ${d.inbound}`, '',
    `Integracje z błędami: ${d.integrationsTroubled}`,
    `Webhooki: w toku ${d.deliveries.pending}, nieudane ${d.deliveries.failed}`, '',
    'Konta:',
  ];
  for (const a of d.accounts) {
    const state = a.paused ? `wstrzymane (${a.paused})` : 'czynne';
    lines.push(`- ${a.name}: ${state}, certyfikat ważny jeszcze ${a.certificateDaysLeft} dni`);
  }
  if (d.release) lines.push('', `Dostępne wydanie ${d.release.version}, zainstalowane ${GATE_VERSION}. Co nowego: ${d.release.url}`);
  return { subject: subjectOf(s, `Podsumowanie dzienne ${d.day}`), text: [...lines, ...footer(s, 'daily_summary')].join('\n') };
}

/** Mail testowy z ekranu „Powiadomienia”. */
export function composeTest(s: Settings, now: Date): Mail {
  return {
    subject: subjectOf(s, 'Mail testowy'),
    text: [`Mail testowy z Multiinfo Gate (instancja ${s.instanceName}).`, `Wysłany ${warsawDay(now.toISOString())} o ${warsawTime(now.toISOString())}.`,
      'Jeśli go czytasz, ustawienia SMTP są poprawne.', ...footer(s, 'daily_summary')].join('\n'),
  };
}
