export const NOTIFICATION_EVENTS = ['integration_error', 'integration_throttled', 'webhook_undelivered', 'certificate_expiring', 'account_rejecting', 'inbound_failure', 'mailbox_failure', 'daily_summary', 'release_available', 'm365_disconnected', 'mail_undeliverable'] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export interface RuleDefaults { enabled: boolean; maxPerHour: number; groupHours: number; params: Record<string, unknown> }

/** Wartości z tabeli reguł specu. „1 na integrację/konto” realizuje subjectKey w kolejce, nie ta liczba. */
export const RULE_DEFAULTS: Record<NotificationEvent, RuleDefaults> = {
  integration_error: { enabled: true, maxPerHour: 5, groupHours: 1, params: {} },
  integration_throttled: { enabled: true, maxPerHour: 5, groupHours: 0, params: {} },
  webhook_undelivered: { enabled: true, maxPerHour: 5, groupHours: 1, params: {} },
  certificate_expiring: { enabled: true, maxPerHour: 1, groupHours: 0, params: { days: [30, 14, 7, 1] } },
  account_rejecting: { enabled: true, maxPerHour: 1, groupHours: 0, params: {} },
  inbound_failure: { enabled: true, maxPerHour: 1, groupHours: 0, params: { afterMinutes: 15 } },
  mailbox_failure: { enabled: true, maxPerHour: 5, groupHours: 0, params: { afterMinutes: 15 } },
  daily_summary: { enabled: false, maxPerHour: 1, groupHours: 0, params: { hour: 8 } },
  release_available: { enabled: true, maxPerHour: 1, groupHours: 0, params: {} },
  m365_disconnected: { enabled: true, maxPerHour: 5, groupHours: 0, params: {} },
  mail_undeliverable: { enabled: true, maxPerHour: 1, groupHours: 0, params: {} },
};

/** Zdarzenia zgłaszane wyłącznie SMS-em: powiadomienie mailem o niewysłanym mailu nie może dotrzeć. */
export const SMS_ONLY_EVENTS: NotificationEvent[] = ['mail_undeliverable'];

/** Zdarzenia, których reguły powstają z włączonym SMS-em; pozostałe administrator włącza sam. */
export const SMS_DEFAULT_ON: NotificationEvent[] = ['m365_disconnected', 'mail_undeliverable'];

const LABELS: Record<NotificationEvent, [string, string]> = {
  integration_error: ['Błąd integracji', 'pusta treść, brak numeru, błąd szablonu, odrzucone uwierzytelnienie, błąd ładunku'],
  integration_throttled: ['Limit burzy przekroczony', 'integracja odrzuca nadmiar zdarzeń w oknie czasu'],
  webhook_undelivered: ['Webhook niedostarczony', 'dostawa do aplikacji nieudana po wszystkich ponowieniach'],
  certificate_expiring: ['Certyfikat konta wygasa', 'według progów dni z parametrów'],
  account_rejecting: ['Konto Multiinfo odrzuca wysyłkę', 'certyfikat, uwierzytelnienie, wstrzymanie'],
  inbound_failure: ['Awaria odbioru', 'odpytywanie usługi kończy się błędem dłużej niż podany czas'],
  mailbox_failure: ['Awaria skrzynki pocztowej', 'logowanie do IMAP nieudane albo serwer poczty niedostępny dłużej niż podany czas'],
  daily_summary: ['Podsumowanie dzienne', 'SMS-y, błędy, stan integracji i kont z ostatniej doby'],
  release_available: ['Nowe wydanie bramki', 'w serwisie GitHub dostępne jest nowsze wydanie niż zainstalowane, jeden mail na wydanie'],
  m365_disconnected: ['Konto Microsoft 365 wymaga logowania', 'Microsoft odrzucił token konta, na przykład po zmianie hasła albo odwołaniu sesji'],
  mail_undeliverable: ['Mail z powiadomieniem niewysłany', 'mail do administratora nie został wysłany mimo wszystkich ponowień'],
};
export const eventLabel = (e: NotificationEvent): string => LABELS[e][0];
export const eventDescription = (e: NotificationEvent): string => LABELS[e][1];

/**
 * Tyle powiadamiania, ile widzą trasy i worker: zdarzenie, temat (integracja, konto), jedna
 * linia opisu. Reszta (reguły, grupowanie, limity, SMTP) siedzi za tym interfejsem.
 */
export interface AdminNotifier {
  notify(event: NotificationEvent, subjectKey: string | null, summary: string, now: Date, dedupKey?: string): void;
}
