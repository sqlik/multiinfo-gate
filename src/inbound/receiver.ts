import { createHash, randomUUID } from 'node:crypto';
import { silentLogger, type Logger } from '../log.ts';
import { ProviderError, type InboundSms } from '../multiinfo/response.ts';
import type { AccountsRepo } from '../store/accounts.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { InboundMessagesRepo } from '../store/inbound-messages.ts';
import type { InboundServicesRepo, InboundTarget } from '../store/inbound-services.ts';
import type { JobsRepo } from '../store/jobs.ts';
import type { MessagesRepo } from '../store/messages.ts';
import type { WebhookDeliveriesRepo } from '../store/webhook-deliveries.ts';
import { normalizePhone } from '../text/phone.ts';
import { warsawCompactToIso } from '../time/warsaw.ts';
import type { ClientPool } from '../worker/clients.ts';
import { emitWebhook } from '../worker/webhook.ts';

export interface ReceiverDeps {
  accounts: AccountsRepo;
  apiKeys: ApiKeysRepo;
  inbound: InboundMessagesRepo;
  services: InboundServicesRepo;
  messages: MessagesRepo;
  deliveries: WebhookDeliveriesRepo;
  jobs: JobsRepo;
  clients: ClientPool;
  /** MIG_INBOUND_TIMEOUT_MS: ile Plus może trzymać getsms.aspx. */
  timeoutMs: number;
  /** MIG_INBOUND_IDLE_MS: przerwa po pustej odpowiedzi. */
  idleMs: number;
  now?: () => Date;
  log?: Logger;
  /** Czekanie przerywalne sygnałem; testy podstawiają natychmiastowe. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Okno, w którym szukamy wysłanej wiadomości, na którą abonent odpowiada. */
export const RELATED_WINDOW_MS = 7 * 86_400_000;

/** Wycofywanie po błędach przejściowych; ostatni próg powtarzany do skutku. */
export const INBOUND_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const;

/** Co ile odbiornik sprawdza, które usługi mają subskrybentów. */
export const REFRESH_INTERVAL_MS = 10_000;

export type PollOutcome =
  | { kind: 'message'; id: string; duplicate: boolean }
  | { kind: 'empty' }
  | { kind: 'stopped'; error: string }
  | { kind: 'error'; error: string };

/** Kody, po których nie ma sensu pytać dalej bez zmiany konfiguracji: usługa nie istnieje albo jest nieaktywna. */
const STOPPING_CODES = new Set([-23, -24]);

const shortId = () => `in_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Numer nadawcy w postaci bramki; numer krótki albo nietypowy zostaje taki, jak podał Plus. */
export function normalizeSender(raw: string, countryCode: string): string {
  try {
    return normalizePhone(raw, countryCode);
  } catch {
    return raw.trim();
  }
}

export class Receiver {
  constructor(private readonly deps: ReceiverDeps) {}

  /**
   * Jedno pytanie do Multiinfo o jedną wiadomość. Kolejność jest celowa: zapis w bazie
   * razem z dostawami, dopiero potem potwierdzenie. Wiadomość niepotwierdzona wraca po
   * ok. 9 minutach i odbija się o klucz unikalny - nie gubimy jej ani nie powielamy.
   */
  async pollOnce(target: InboundTarget, signal?: AbortSignal): Promise<PollOutcome> {
    const log = this.deps.log ?? silentLogger;
    const now = (this.deps.now ?? (() => new Date()))();
    const client = this.deps.clients.for(target.accountId);

    let sms: InboundSms | null;
    try {
      sms = await client.getSms(target.serviceId, this.deps.timeoutMs, signal);
    } catch (error) {
      // Przerwanie przy zatrzymaniu bramki to nie awaria usługi - bez śladu przy usłudze.
      if (signal?.aborted) return { kind: 'error', error: 'przerwane' };
      const code = error instanceof ProviderError ? error.code : -71;
      const reason = `${code}: ${error instanceof Error ? error.message : String(error)}`;
      this.deps.services.setError(target, reason);
      if (STOPPING_CODES.has(code)) {
        log.error('odbior.zatrzymany', { ...target, code, reason });
        return { kind: 'stopped', error: reason };
      }
      log.warn('odbior.blad', { ...target, code, reason });
      return { kind: 'error', error: reason };
    }

    this.deps.services.markPolled(target, now);
    this.deps.services.setError(target, null);
    if (sms === null) return { kind: 'empty' };

    let stored: { id: string; duplicate: boolean };
    try {
      stored = this.store(target, sms, now);
    } catch (error) {
      // Nie potwierdzamy: wiadomość wróci z Multiinfo, a przyczyna jest w dzienniku.
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.services.setError(target, `zapis nieudany: ${reason}`);
      log.error('odbior.wyjatek', { ...target, miId: sms.miId, error });
      return { kind: 'error', error: reason };
    }

    try {
      await client.confirmSms(sms.miId);
    } catch (error) {
      // Zapisana, więc nie groźne: wróci po 9 minutach jako duplikat i wtedy ją potwierdzimy.
      log.warn('odbior.potwierdzenie_nieudane', { ...target, miId: sms.miId, error });
    }
    return { kind: 'message', ...stored };
  }

  /** Zapis wiadomości i dostaw w jednej transakcji. Duplikat nie zostawia śladu poza dziennikiem. */
  private store(target: InboundTarget, sms: InboundSms, now: Date): { id: string; duplicate: boolean } {
    const log = this.deps.log ?? silentLogger;
    const account = this.deps.accounts.get(target.accountId);
    if (!account) throw new Error(`Konto ${target.accountId} nie istnieje`);

    const id = shortId();
    const sender = normalizeSender(sms.sender, account.defaultCountryCode);
    const receivedAt = warsawCompactToIso(sms.receivedAt);
    const related = this.deps.messages.lastTo(
      target.accountId, target.serviceId, sender, new Date(now.getTime() - RELATED_WINDOW_MS),
    );
    const keepContent = account.storeContent === 1;

    return this.deps.inbound.transaction(() => {
      const inserted = this.deps.inbound.insertIfNew({
        id, accountId: target.accountId, serviceId: target.serviceId, miId: sms.miId, sender, dest: sms.dest,
        kind: sms.kind, body: keepContent ? sms.content : null, bodyHash: sha256(sms.content),
        protocolId: sms.protocolId, codingScheme: sms.codingScheme, connectorId: sms.connectorId || null,
        relatedMessageId: related?.id ?? null, receivedAt, createdAt: now.toISOString(),
      });
      if (!inserted) {
        log.info('odbior.duplikat', { ...target, miId: sms.miId });
        return { id, duplicate: true };
      }

      const payload = {
        id, serviceId: target.serviceId, from: sender, to: sms.dest, kind: sms.kind,
        ...(sms.kind === 'text' ? { text: sms.content } : { hex: sms.content }),
        receivedAt, relatedMessageId: related?.id ?? null,
      };
      for (const key of this.deps.apiKeys.inboundSubscribers(target.accountId, target.serviceId, now)) {
        emitWebhook(this.deps, key.id, 'message.received', payload, now, { inboundId: id, scrubAfter: !keepContent });
      }
      this.deps.services.markReceived(target, now);
      // Numer nadawcy to identyfikator, nie treść - treść do dziennika nie trafia.
      log.info('odbior.wiadomosc', { ...target, id, miId: sms.miId, from: sender, kind: sms.kind, related: related?.id ?? null });
      return { id, duplicate: false };
    });
  }
}
