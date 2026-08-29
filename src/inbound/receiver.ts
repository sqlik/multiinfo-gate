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

export interface InboundHealth {
  /** Usługi z choć jednym subskrybentem (cele). */
  services: number;
  /** Pętle działające w tej chwili. */
  listening: number;
  errors: Array<{ account: string; serviceId: string; error: string }>;
}

interface Loop { target: InboundTarget; controller: AbortController; done: Promise<void> }

const keyOf = (t: InboundTarget) => `${t.accountId}:${t.serviceId}`;

/** Czekanie, które kończy się wcześniej po sygnale - żeby stop() nie czekał na koniec przerwy. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Oddanie tury pętli zdarzeń. Pytanie, które kończy się natychmiast (atrapa w testach, błąd
 * zwracany bez sieci), nie może zamienić pętli odbiornika w ciąg samych mikrozadań.
 */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

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
  private readonly loops = new Map<string, Loop>();
  /** Cele zatrzymane kodem -23/-24; wracają tylko po refresh({ retryStopped: true }). */
  private readonly stopped = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly deps: ReceiverDeps) {}

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const loop of this.loops.values()) loop.controller.abort();
    await Promise.all([...this.loops.values()].map((l) => l.done));
    this.loops.clear();
    this.stopping = false;
  }

  /**
   * Uzgadnia pętle z subskrypcjami: zapala dla nowych celów, gasi dla tych, które straciły
   * subskrybentów (konto wstrzymane, klucz odwołany albo wyłączony). Cel zatrzymany błędem
   * konfiguracji Multiinfo wraca tylko na jawne życzenie - po zmianie w panelu.
   */
  refresh(opts: { retryStopped?: boolean } = {}): void {
    if (this.stopping) return;
    const now = (this.deps.now ?? (() => new Date()))();
    if (opts.retryStopped) this.stopped.clear();
    const wanted = new Map(this.deps.services.activeTargets(now).map((t) => [keyOf(t), t]));
    for (const [key, loop] of this.loops) {
      if (!wanted.has(key)) {
        loop.controller.abort();
        this.loops.delete(key);
      }
    }
    for (const [key, target] of wanted) {
      if (this.loops.has(key) || this.stopped.has(key)) continue;
      const controller = new AbortController();
      const loop: Loop = { target, controller, done: Promise.resolve() };
      loop.done = this.run(target, controller.signal).finally(() => {
        if (this.loops.get(key) === loop) this.loops.delete(key);
      });
      this.loops.set(key, loop);
    }
  }

  listening(): InboundTarget[] {
    return [...this.loops.values()].map((l) => l.target);
  }

  health(): InboundHealth {
    const now = (this.deps.now ?? (() => new Date()))();
    return {
      services: this.deps.services.activeTargets(now).length,
      listening: this.loops.size,
      errors: this.deps.services.errors().map((e) => ({ account: e.accountName, serviceId: e.serviceId, error: e.error })),
    };
  }

  /** Pętla jednej usługi: pyta, aż zostanie zgaszona albo zatrzymana błędem konfiguracji. */
  private async run(target: InboundTarget, signal: AbortSignal): Promise<void> {
    const log = this.deps.log ?? silentLogger;
    const sleep = this.deps.sleep ?? abortableSleep;
    log.info('odbior.start', { ...target });
    let failures = 0;
    while (!signal.aborted) {
      const outcome = await this.pollOnce(target, signal);
      await nextTurn();
      if (signal.aborted) break;
      if (outcome.kind === 'stopped') {
        this.stopped.add(keyOf(target));
        break;
      }
      if (outcome.kind === 'error') {
        const delay = INBOUND_BACKOFF_MS[Math.min(failures, INBOUND_BACKOFF_MS.length - 1)]!;
        failures += 1;
        await sleep(delay, signal);
        continue;
      }
      failures = 0;
      if (outcome.kind === 'empty' && this.deps.idleMs > 0) await sleep(this.deps.idleMs, signal);
    }
    log.info('odbior.stop', { ...target });
  }

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
