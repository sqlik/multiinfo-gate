import { ProviderError } from '../multiinfo/response.ts';
import { silentLogger, type Logger } from '../log.ts';
import type { Job, JobsRepo } from '../store/jobs.ts';
import type { AccountsRepo } from '../store/accounts.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { MessageEventsRepo } from '../store/message-events.ts';
import type { MessageRow, MessagesRepo } from '../store/messages.ts';
import type { PackagesRepo } from '../store/packages.ts';
import type { WebhookDeliveriesRepo } from '../store/webhook-deliveries.ts';
import type { InboundMessagesRepo } from '../store/inbound-messages.ts';
import type { Resolver } from '../net/private-address.ts';
import type { AdminNotifier } from '../notifications/rules.ts';
import type { IntegrationEventsRepo } from '../store/integration-events.ts';
import type { IntegrationGuardsRepo } from '../store/integration-guards.ts';
import type { IntegrationsRepo } from '../store/integrations.ts';
import type { NotificationsRepo } from '../store/notifications.ts';
import type { Mailer } from './mail.ts';
import type { ClientPool } from './clients.ts';
import { pauseForCertificate } from './certificate.ts';
import { emitIntegrations, isOutboundEvent, type IntegrationEmitDeps } from './integrations.ts';
import { emitWebhook, type HttpPost, type WebhookEvent } from './webhook.ts';

export interface WorkerDeps {
  accounts: AccountsRepo;
  apiKeys: ApiKeysRepo;
  messages: MessagesRepo;
  events: MessageEventsRepo;
  deliveries: WebhookDeliveriesRepo;
  packages: PackagesRepo;
  jobs: JobsRepo;
  clients: ClientPool;
  /** Magazyn odebranych - do smsInId przy odpowiedzi w wątku. */
  inbound: InboundMessagesRepo;
  /** Katalog na surowe raporty rozsyłek (CSV) - `MIG_DATA_DIR/reports`. */
  reportsDir: string;
  /** Wysyłka HTTP webhooków; testy podstawiają atrapę. */
  post?: HttpPost;
  /** Rozwiązywanie nazw celów webhooków; testy podstawiają atrapę. */
  resolve?: Resolver;
  /** MIG_WEBHOOK_ALLOW_PRIVATE: zgoda na webhooki do sieci wewnętrznej (host bramki, sieć kontenerów). */
  allowPrivateWebhooks?: boolean;
  /** Integracje wychodzące: bez tego zestawu zdarzenia idą tylko webhookiem klucza. */
  integrationEmit?: IntegrationEmitDeps;
  /** Dostawa integracji: skąd wziąć adres i konfigurację oraz gdzie zapisać wynik. */
  integrations?: IntegrationsRepo;
  integrationEvents?: IntegrationEventsRepo;
  /** Powiadomienia administratora; `flush` woła tura utrzymaniowa. */
  notifier?: AdminNotifier & { flush?(now: Date): void };
  /** Sprawdzanie nowych wydań na GitHubie; bez niego bramka nie pyta. */
  releases?: { check(now: Date): Promise<void> | void };
  /** Ustawienie SMTP i kolejka powiadomień - zadanie `mail` i sprzątanie. */
  notifications?: NotificationsRepo;
  /** Wysyłka maila; testy podstawiają atrapę. */
  mailer?: Mailer;
  /** Skaner stanu (certyfikaty, konta, odbiór, podsumowanie) - tura utrzymaniowa. */
  scanner?: { scan(now: Date): void };
  /** Strażnicy integracji - sprzątanie idempotencji w turze utrzymaniowej. */
  guards?: IntegrationGuardsRepo;
  log?: Logger;
}

/**
 * Kolejkuje webhook klucza i odnotowuje to w przebiegu wiadomości, jeśli klucz ma adres; do tego
 * dostawy do integracji wychodzących klucza. Oba tory niezależne - klucz może mieć jedno i drugie.
 */
export function notify(
  deps: WorkerDeps, message: { id: string; apiKeyId: number; inReplyTo?: string | null }, event: WebhookEvent,
  payload: Record<string, unknown>, now: Date,
): void {
  const thread = message.inReplyTo ? { inReplyTo: message.inReplyTo } : {};
  const body = { id: message.id, ...thread, ...payload };
  if (emitWebhook(deps, message.apiKeyId, event, body, now) !== null) {
    deps.events.record(message.id, now, 'webhook', event);
  }
  if (deps.integrationEmit && isOutboundEvent(event)) {
    emitIntegrations(deps.integrationEmit, message.apiKeyId, event, body, now, { messageId: message.id });
  }
}

/** Odstępy kolejnych ponowień przy błędach przejściowych. */
export const SEND_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const;

/** Po tym czasie sprawdzamy ponownie, czy wstrzymane konto zostało odblokowane. */
const PAUSED_RECHECK_MS = 60_000;

/** Pierwsze pytanie o status zadajemy po dziesięciu sekundach od wysyłki. */
const FIRST_POLL_MS = 10_000;

export async function handleSend(job: Job, deps: WorkerDeps, now: Date): Promise<void> {
  const log = deps.log ?? silentLogger;
  const messageId = String(job.payload.messageId);
  const message = deps.messages.get(messageId);
  if (!message) {
    // Wiadomość usunięta w międzyczasie - zadanie nie ma już czego dotyczyć.
    deps.jobs.complete(job.id);
    return;
  }
  if (message.status === 'cancelled') {
    // Anulowana, zanim wyszła z kolejki - nie ma czego wysyłać.
    deps.jobs.complete(job.id);
    return;
  }

  const account = deps.accounts.get(message.accountId);
  if (!account) {
    deps.messages.setStatus(messageId, { status: 'failed', error: 'Konto nie istnieje.', finalAt: now });
    deps.jobs.complete(job.id);
    log.error('wysylka.brak_konta', { messageId, accountId: message.accountId });
    return;
  }

  // Wstrzymanie sprawdzamy przed wyłączeniem, bo `pause` gasi też znacznik `active`:
  // konto z powodem wstrzymania czeka na naprawę, a nie zostało wyłączone ręcznie.
  // Oczekiwanie nie liczy się jako ponowienie - wiadomość nie zawiniła.
  if (account.pausedReason) {
    // Zdarzenie zapisujemy raz - co minutę byłby to szum, nie przebieg.
    if (job.lastError !== account.pausedReason) deps.events.record(messageId, now, 'paused', account.pausedReason);
    deps.jobs.defer(job.id, new Date(now.getTime() + PAUSED_RECHECK_MS), account.pausedReason);
    return;
  }

  if (account.active === 0) {
    deps.messages.setStatus(messageId, { status: 'failed', error: 'Konto jest wyłączone.', finalAt: now });
    deps.jobs.complete(job.id);
    log.warn('wysylka.konto_wylaczone', { messageId, accountId: account.id });
    return;
  }

  const text = String(job.payload.text ?? message.body ?? '');
  const deliveryReport = job.payload.deliveryReport !== false;
  // Odpowiedź w wątku: Multiinfo dostaje identyfikator wiadomości przychodzącej; bez niej wysyłamy zwyczajnie.
  const inReplyTo = message.inReplyTo ? deps.inbound.get(message.inReplyTo) : undefined;

  try {
    const { miIds, trace } = await deps.clients.for(message.accountId).sendLong({
      serviceId: message.serviceId,
      dest: message.dest,
      text,
      ...(inReplyTo ? { smsInId: inReplyTo.miId } : {}),
      ...(message.orig ? { orig: message.orig } : {}),
      ...(message.validTo ? { validTo: new Date(message.validTo) } : {}),
      ...(message.costCenter ? { costCenter: message.costCenter } : {}),
      deliveryReport,
      advancedEncoding: message.encoding === 'ucs2',
      deleteContent: account.storeContent === 0,
    });

    deps.messages.setSent(messageId, miIds, now);
    // Ślad zostaje przy wiadomości; treść tylko wtedy, gdy konto ją przechowuje.
    deps.messages.setTrace(messageId, account.storeContent === 1
      ? trace
      : { ...trace, params: { ...trace.params, text: `<treść, ${[...text].length} znaków>` } });

    // Anulowanie mogło przyjść, gdy sendsmslong.aspx już trwało: trasa API widziała wiadomość
    // bez identyfikatorów i zamknęła ją lokalnie, a Multiinfo tymczasem ją przyjęło.
    if (deps.messages.get(messageId)?.status === 'cancelled') {
      const withdrawn = await withdraw(deps, messageId, message.accountId, miIds, now);
      if (withdrawn) {
        deps.jobs.complete(job.id);
        deps.jobs.enqueue('poll', { messageId }, new Date(now.getTime() + FIRST_POLL_MS));
        log.info('wysylka.wycofana', { messageId, accountId: account.id, parts: miIds.length });
        return;
      }
      deps.messages.setStatus(messageId, { status: 'sent', error: null, finalAt: null });
    }

    deps.jobs.complete(job.id);
    deps.events.record(messageId, now, 'sent', `identyfikatory ${miIds.join(', ')}`);
    notify(deps, message, 'message.sent', { status: 'sent', to: message.dest, parts: miIds.length }, now);
    // Ładunek zadania odpytującego nie zawiera treści - nie ma powodu jej powielać.
    deps.jobs.enqueue('poll', { messageId }, new Date(now.getTime() + FIRST_POLL_MS));
    log.info('wysylka.przyjeta', { messageId, accountId: account.id, parts: miIds.length, attempt: job.attempts + 1 });
    return;
  } catch (error) {
    if (!(error instanceof ProviderError)) {
      // Awaria sieci albo nieprzewidziany wyjątek - traktujemy jak błąd przejściowy.
      log.warn('wysylka.wyjatek', { messageId, accountId: account.id, attempt: job.attempts + 1, error });
      scheduleRetry(job, deps, now, message, -71, error instanceof Error ? error.message : String(error));
      return;
    }

    if (error.kind === 'certificate') {
      const reason = pauseForCertificate(deps, message.accountId, error, log, now);
      // Wiadomość zostaje w kolejce: po wymianie certyfikatu pójdzie bez zmian
      // i z nienaruszonym harmonogramem ponowień.
      deps.events.record(messageId, now, 'paused', reason);
      deps.jobs.defer(job.id, new Date(now.getTime() + PAUSED_RECHECK_MS), reason);
      return;
    }

    if (error.kind === 'transient') {
      log.warn('wysylka.blad_przejsciowy', { messageId, accountId: account.id, code: error.code, attempt: job.attempts + 1 });
      scheduleRetry(job, deps, now, message, error.code, error.message);
      return;
    }

    const description = describeFailure(error, message.orig);
    deps.messages.setStatus(messageId, {
      status: 'failed', providerCode: error.code, error: description, finalAt: now,
    });
    deps.jobs.complete(job.id);
    deps.events.record(messageId, now, 'failed', `kod ${error.code}: ${description}`);
    notify(deps, message, 'message.failed', { status: 'failed', to: message.dest, providerCode: error.code, error: description }, now);
    log.warn('wysylka.odrzucona', { messageId, accountId: account.id, code: error.code });
  }
}

/**
 * Cofa w Multiinfo części wiadomości anulowanej w trakcie przekazywania. Prawda, gdy wszystkie
 * części dało się cofnąć - wiadomość zostaje anulowana. Fałsz, gdy choć jedna poszła dalej:
 * wiadomość jest wtedy przekazana i wraca do zwykłego toru, a przebieg mówi dlaczego.
 */
async function withdraw(deps: WorkerDeps, messageId: string, accountId: number, miIds: string[], now: Date): Promise<boolean> {
  const client = deps.clients.for(accountId);
  const cancelled: string[] = [];
  for (const miId of miIds) {
    try {
      await client.cancel(miId);
      cancelled.push(miId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.events.record(messageId, now, 'cancel_failed',
        `anulowanie przyszło w trakcie przekazywania; cancelsms.aspx dla ${miId} odrzucone: ${reason}`
        + (cancelled.length > 0 ? `; cofnięte części: ${cancelled.join(', ')}` : ''));
      return false;
    }
  }
  deps.events.record(messageId, now, 'cancelled',
    `anulowanie przyszło w trakcie przekazywania; cancelsms.aspx: ${cancelled.join(', ')}`);
  return true;
}

/**
 * Kod -14 znaczy tylko „błędna wartość parametru” i nie wskazuje którego. Jeśli żądanie
 * niosło nadpis, to on jest najczęstszą przyczyną: słownik w bramce mógł rozejść się
 * z listą uzgodnioną po stronie Plusa.
 */
function describeFailure(error: ProviderError, orig: string | null): string {
  if (error.code === -14 && orig) {
    return `${error.message} - sprawdź nadpis nadawcy „${orig}”; ` +
      'Multiinfo przyjmuje tylko wartości uzgodnione z Polkomtel.';
  }
  return error.message;
}

function scheduleRetry(
  job: Job, deps: WorkerDeps, now: Date, message: MessageRow, code: number, reason: string,
): void {
  const messageId = message.id;
  const delay = SEND_BACKOFF_MS[job.attempts];
  if (delay === undefined) {
    const description = `Wyczerpano ponowienia. Ostatni błąd: ${reason}`;
    deps.messages.setStatus(messageId, { status: 'failed', providerCode: code, error: description, finalAt: now });
    deps.jobs.complete(job.id);
    deps.events.record(messageId, now, 'failed', `kod ${code}: ${description}`);
    notify(deps, message, 'message.failed', { status: 'failed', to: message.dest, providerCode: code, error: description }, now);
    (deps.log ?? silentLogger).error('wysylka.wyczerpano_ponowienia', { messageId, code });
    return;
  }
  deps.events.record(messageId, now, 'retry', `kod ${code}: ${reason}; ponowienie za ${Math.round(delay / 1000)} s`);
  deps.jobs.retry(job.id, new Date(now.getTime() + delay), reason);
}
