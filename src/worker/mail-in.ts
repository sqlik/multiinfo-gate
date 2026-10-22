import { MAIL_IN_PASSWORD_REF, type MailInConfig } from '../integrations/config.ts';
import { warsawTime } from '../time/warsaw.ts';
import { MailboxError, errorKindOf, errorMessageOf, scrubError, type MailboxConnect, type MailboxSession, type MailboxSettings } from '../integrations/mail/client.ts';
import { parseMail, type ParsedMail } from '../integrations/mail/parse.ts';
import { runMailIn, type MailInIntegration, type MailInOutcome, type PipelineDeps } from '../integrations/pipeline.ts';
import { silentLogger, type Logger } from '../log.ts';
import type { AdminNotifier } from '../notifications/rules.ts';
import { isMailIn } from '../store/integrations.ts';
import type { MailInRepo, MailboxErrorKind, SeenKey, SeenOutcome } from '../store/mail-in.ts';
import type { NotificationsRepo } from '../store/notifications.ts';
import type { MailContent } from './mail.ts';
import { REPORT_FIRST_DELAY_MS, reportPayload } from './mail-report.ts';

export const MAX_PER_POLL = 50;
export const MAX_MAIL_BYTES = 2 * 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 15_000;
export const POLL_TIMEOUT_MS = 60_000;
/** Błąd logowania nie ponawia się częściej, żeby bramka nie zablokowała konta pocztowego kolejnymi próbami. */
export const AUTH_RETRY_MS = 300_000;
export const BACKOFF_CAP_MS = 900_000;
export const MAILBOX_CONCURRENCY = 5;
const DEFAULT_AFTER_MINUTES = 15;

export interface MailInDeps extends PipelineDeps {
  mailIn: MailInRepo;
  connect: MailboxConnect;
  notifier?: AdminNotifier;
  notifications?: Pick<NotificationsRepo, 'rule' | 'smtp'>;
  log?: Logger;
}

/**
 * Odstęp po nieudanym odpytaniu: interwał razy 2^(failures-1), do 15 min, ale nigdy krócej niż
 * ustawiona częstotliwość; logowanie co najmniej 5 min.
 */
export function nextPollDelayMs(intervalSec: number, failures: number, kind: MailboxErrorKind | null): number {
  const base = intervalSec * 1000;
  const grown = Math.min(base * 2 ** Math.max(0, failures - 1), Math.max(BACKOFF_CAP_MS, base));
  return kind === 'auth' ? Math.max(grown, AUTH_RETRY_MS) : grown;
}

const KIND_WORDS: Record<MailboxErrorKind, string> = {
  auth: 'logowanie odrzucone', network: 'serwer nie odpowiada', folder: 'folder niedostępny', other: 'błąd odpytania',
};


/**
 * Treść odpowiedzi do nadawcy o nieudanej wysyłce albo null, gdy odpowiedź nie przysługuje.
 * Wysyłka udana dostaje raport z zadania `mail.report` minutę później (ze statusem doręczenia).
 * Bez odpowiedzi na mail automatyczny (RFC 3834) i przy `unavailable`, bo ten wynik powstaje przed
 * sprawdzeniem nadawcy, a do obcych bramka nie odpisuje nigdy.
 */
export function replyFor(outcome: MailInOutcome, mail: ParsedMail, config: MailInConfig): MailContent | null {
  if (mail.auto) return null;
  let text: string;
  switch (outcome.kind) {
    case 'error':
      // Po „więcej niż” stoi dopełniacz: „1 części”, „3 części”.
      text = `SMS nie został wysłany: ${outcome.code === 'too_many_parts' ? `treść wymaga więcej niż ${config.maxParts} części.`
        : outcome.code === 'no_recipient' ? 'nie udało się ustalić odbiorcy.'
          : outcome.code === 'empty_text' ? 'treść maila po usunięciu podpisu i cytatów jest pusta.'
            : outcome.detail}`;
      break;
    case 'throttled':
      text = `SMS nie został wysłany: przekroczono limit integracji (${config.throttle.limit} w ${config.throttle.windowMinutes} min).`;
      break;
    default:
      return null;
  }
  const subject = /^re:/i.test(mail.subject.trim()) ? mail.subject.trim() : `Re: ${mail.subject.trim() === '' ? '(bez tematu)' : mail.subject}`;
  return {
    subject, text, to: [mail.from],
    ...(mail.messageId ? { inReplyTo: mail.messageId, references: mail.messageId } : {}),
    autoReply: true,
  };
}

/** „Sprawdź połączenie”: logowanie, otwarcie folderu, lista folderów; nic nie przetwarza, nic nie zapisuje. */
export async function checkMailbox(connect: MailboxConnect, settings: MailboxSettings, folder: string):
  Promise<{ ok: true; unseen: number; folders: string[] } | { ok: false; kind: MailboxErrorKind; error: string; folders: string[] }> {
  let session: MailboxSession | null = null;
  let folders: string[] = [];
  try {
    session = await connect(settings, CONNECT_TIMEOUT_MS);
    folders = await session.folders();
    const box = await session.open(folder);
    return { ok: true, unseen: box.unseen, folders };
  } catch (e) {
    // Lista folderów zostaje, gdy logowanie się udało, a zawiodła nazwa folderu: użytkownik od razu widzi właściwą.
    return { ok: false, kind: errorKindOf(e), error: scrubError(errorMessageOf(e), [settings.password, settings.user]), folders };
  } finally {
    await session?.close();
  }
}

const seenOutcomeOf = (outcome: MailInOutcome): SeenOutcome =>
  outcome.kind === 'sent' ? 'sent' : outcome.kind === 'throttled' ? 'throttled' : outcome.kind === 'skipped' ? 'skipped' : 'failed';

const hhmm = (iso: string): string => warsawTime(iso).slice(0, 5);

/** Odpytywanie skrzynek: które są na czas, do pięciu naraz, każda najwyżej raz w danej chwili. */
export class MailInPoller {
  private readonly active = new Set<number>();

  constructor(private readonly deps: MailInDeps, private readonly opts: { concurrency?: number } = {}) {}

  async tick(now: Date): Promise<void> {
    const startedAt = Date.now();
    this.deps.mailIn.ensureAll(now);
    const queue = this.deps.mailIn.due(now).filter((id) => !this.active.has(id));
    // Limit liczy trwające odpytania z poprzednich tur: nowa tura dostaje tylko wolne miejsca.
    const width = Math.max(1, this.opts.concurrency ?? MAILBOX_CONCURRENCY) - this.active.size;
    if (width <= 0) return;
    const lane = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (this.active.has(id)) continue;
        const row = this.deps.integrations.get(id);
        if (!row || !isMailIn(row) || row.enabled === 0) continue;
        this.active.add(id);
        try {
          // Kolejne skrzynki w torze dostają bieżący czas, żeby harmonogram nie dryfował przy krótkich odpytaniach.
          await this.poll(row, new Date(now.getTime() + Math.floor((Date.now() - startedAt) / 1000) * 1000));
        } finally {
          this.active.delete(id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, queue.length) }, lane));
  }

  async poll(integration: MailInIntegration, now: Date): Promise<void> {
    const { mailIn } = this.deps;
    const log = this.deps.log ?? silentLogger;
    const config = integration.config;
    mailIn.ensureState(integration.id, now);
    const password = this.deps.integrations.secrets(integration.id)[MAIL_IN_PASSWORD_REF] ?? '';
    let timer: NodeJS.Timeout | null = null;
    // Po przekroczeniu limitu praca kończy bieżący mail i przerywa pętlę; spóźnione połączenie jest zamykane bez pracy.
    let aborted = false;
    try {
      if (password === '') throw new MailboxError('auth', 'brak hasła w konfiguracji');
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { aborted = true; reject(new MailboxError('network', `odpytanie przekroczyło ${POLL_TIMEOUT_MS / 1000} s`)); }, POLL_TIMEOUT_MS);
      });
      const work = (async () => {
        const session = await this.deps.connect({ ...config.imap, password }, CONNECT_TIMEOUT_MS);
        try {
          if (aborted) throw new MailboxError('network', 'połączenie nawiązane po przekroczeniu limitu');
          return await this.process(session, integration, now, () => aborted);
        } finally {
          await session.close().catch(() => undefined);
        }
      })();
      work.catch(() => undefined);
      const result = await Promise.race([work, timeout]);
      if (result.actionError !== null) throw result.actionError;
      mailIn.recordPoll(integration.id, { ok: true, uidvalidity: result.uidValidity, unseen: result.unseen, at: now, nextPollAt: new Date(now.getTime() + config.intervalSec * 1000) });
    } catch (e) {
      const kind = errorKindOf(e);
      const error = scrubError(errorMessageOf(e), [password, config.imap.user]);
      const failures = (mailIn.state(integration.id)?.failures ?? 0) + 1;
      mailIn.recordPoll(integration.id, { ok: false, error, errorKind: kind, at: now, nextPollAt: new Date(now.getTime() + nextPollDelayMs(config.intervalSec, failures, kind)) });
      log.warn('skrzynka.blad', { integrationId: integration.id, kind, failures });
      this.notifyFailure(integration, kind, error, now);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Otwarcie folderu, próg „od teraz”, maile od najstarszego, potok, działanie na mailu, odpowiedź.
   * Zwraca błąd działania na mailu (np. odrzucone MOVE), który nie przerywa przetwarzania, ale ląduje w stanie.
   */
  private async process(session: MailboxSession, integration: MailInIntegration, now: Date, aborted: () => boolean = () => false): Promise<{ uidValidity: number; unseen: number; actionError: Error | null }> {
    const { mailIn } = this.deps;
    const config = integration.config;
    const box = await session.open(config.folder);
    const result = { uidValidity: box.uidValidity, unseen: box.unseen, actionError: null as Error | null };
    const state = mailIn.state(integration.id)!;
    const validityChanged = state.uidvalidity !== null && state.uidvalidity !== box.uidValidity;
    const first = state.lastOkAt === null || state.uidvalidity === null;
    if ((first || validityChanged) && state.backlog === 0) {
      // Zasada „od teraz”: tylko maile, które przyjdą po tej chwili; zaległe zostają nietknięte.
      mailIn.setFloor(integration.id, box.uidNext - 1, box.uidValidity);
      return result;
    }
    // Zaległe na życzenie albo folder odtworzony przy włączonych zaległych: od początku.
    const floor = state.backlog === 1 || validityChanged ? 0 : state.uidFloor;
    const uids = (await session.unseen(floor)).slice(0, MAX_PER_POLL);
    const metas = (await session.meta(uids)).sort((a, b) => a.uid - b.uid);
    let actionError: Error | null = null;
    let highest = floor;
    for (const meta of metas) {
      // Po przekroczeniu limitu reszta czeka na następne odpytanie; próg wskazuje ostatni obejrzany mail.
      if (aborted()) break;
      highest = Math.max(highest, meta.uid);
      const key: SeenKey = { messageId: meta.messageId, uidvalidity: box.uidValidity, uid: meta.uid };
      const note = (result: 'skipped', reason: string) =>
        this.deps.integrationEvents.record({ integrationId: integration.id, at: now, result, reason, logLimit: config.eventLogLimit });
      if (mailIn.seen(integration.id, key)) {
        // Ktoś celowo oznaczył mail jako nieprzeczytany albo folder odtworzono: bez działania na mailu.
        mailIn.remember(integration.id, key, 'skipped', now);
        note('skipped', 'wiadomość już przetworzona');
        continue;
      }
      if (meta.size > MAX_MAIL_BYTES) {
        mailIn.remember(integration.id, key, 'skipped', now);
        note('skipped', `wiadomość zbyt duża (${(meta.size / (1024 * 1024)).toFixed(1)} MB)`);
        actionError = (await this.afterAction(session, config, meta.uid)) ?? actionError;
        continue;
      }
      // Zapis przed pobraniem i wysyłką: awaria w połowie kosztuje jeden niedosłany SMS, nie dubel.
      mailIn.remember(integration.id, key, 'skipped', now);
      // Jeden zepsuty mail nie zatrzymuje partii ani nie znika po cichu: wpis błędu, wynik failed, działanie jak dla odrzuconego.
      const failMail = async (e: unknown, label: string, forgetMessageId: boolean): Promise<void> => {
        if (e instanceof MailboxError && e.kind !== 'other') throw e;
        mailIn.setOutcome(integration.id, key, 'failed');
        // Nadawca maila, którego nie dało się odczytać, nie został sprawdzony: jego Message-ID nie może blokować późniejszego prawdziwego maila.
        // Po sprawdzeniu nadawcy identyfikator zostaje, bo SMS mógł już pójść i powtórka tego maila nie może dać dubla.
        if (forgetMessageId) mailIn.forgetMessageId(integration.id, key);
        const message = scrubError(errorMessageOf(e), [config.imap.user]);
        this.deps.integrationEvents.record({ integrationId: integration.id, at: now, result: 'error', reason: `${label}: ${message}`, logLimit: config.eventLogLimit });
        try {
          this.deps.notifier?.notify('integration_error', `integration:${integration.id}`, `${integration.name}: ${label}: ${message}`, now);
        } catch {
          // Powiadomienie to dodatek; jego awaria nie może zatrzymać partii.
        }
        actionError = (await this.afterAction(session, config, meta.uid)) ?? actionError;
      };
      let mail: ParsedMail;
      try {
        mail = await parseMail(await session.source(meta.uid), now);
      } catch (e) {
        await failMail(e, 'nieczytelna wiadomość', true);
        continue;
      }
      try {
        const outcome = await runMailIn(this.deps, integration, mail, now);
        mailIn.setOutcome(integration.id, key, seenOutcomeOf(outcome));
        // Mail odrzucony przed potwierdzeniem nadawcy (spoza listy albo bez SPF/DKIM) nie zajmuje cudzego Message-ID.
        if (outcome.kind === 'skipped' && (outcome.reason === 'sender_not_allowed' || outcome.reason === 'auth_failed')) mailIn.forgetMessageId(integration.id, key);
        this.notifyOutcome(integration, outcome, now);
        actionError = (await this.afterAction(session, config, meta.uid)) ?? actionError;
        this.reply(integration, outcome, mail, now);
      } catch (e) {
        await failMail(e, 'błąd przetwarzania wiadomości', false);
      }
    }
    // Próg przesuwa się na najwyższy obejrzany UID: mail oznaczony ponownie jako nieprzeczytany
    // nie wraca co odpytanie, a tabela przetworzonych chroni po restarcie i po zmianie UIDVALIDITY.
    mailIn.setFloor(integration.id, Math.max(highest, floor), box.uidValidity);
    if (state.backlog === 1) mailIn.setBacklog(integration.id, 0);
    result.actionError = actionError;
    return result;
  }

  /** Działanie po przetworzeniu (spec 9); błąd nie przerywa odpytania, wraca jako błąd stanu rodzaju `folder`. */
  private async afterAction(session: MailboxSession, config: MailInConfig, uid: number): Promise<Error | null> {
    try {
      if (config.after.action === 'delete') {
        await session.remove(uid);
        return null;
      }
      await session.markSeen(uid);
      if (config.after.action === 'move') await session.move(uid, config.after.folder);
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new MailboxError('folder', config.after.action === 'move' ? `przeniesienie do folderu ${config.after.folder} nie powiodło się: ${message}` : `działanie na mailu nie powiodło się: ${message}`);
    }
  }

  private notifyOutcome(integration: MailInIntegration, outcome: MailInOutcome, now: Date): void {
    const subject = `integration:${integration.id}`;
    if (outcome.kind === 'sent' && outcome.invalid.length > 0) {
      const n = outcome.invalid.length;
      this.deps.notifier?.notify('integration_error', subject, `${integration.name}: pominięto ${n} nieprawidłow${n === 1 ? 'y numer' : 'e numery'}: ${outcome.invalid.join(', ')}`, now);
    } else if (outcome.kind === 'error') {
      const summary = outcome.code === 'invalid_phone' ? 'nieprawidłowy numer odbiorcy w mailu' : outcome.detail;
      this.deps.notifier?.notify('integration_error', subject, `${integration.name}: ${summary}`, now);
    } else if (outcome.kind === 'unavailable') {
      this.deps.notifier?.notify('integration_error', subject, `${integration.name}: ${outcome.detail}`, now);
    } else if (outcome.kind === 'throttled' && outcome.notify) {
      this.deps.notifier?.notify('integration_throttled', subject, `${integration.name}: przekroczony limit ${integration.config.throttle.limit} w ${integration.config.throttle.windowMinutes} min`, now);
    }
  }

  /** Odpowiedź do nadawcy: raport minutę po udanej wysyłce, mail od ręki o nieudanej. */
  private reply(integration: MailInIntegration, outcome: MailInOutcome, mail: ParsedMail, now: Date): void {
    if (!integration.config.reply.enabled || !this.deps.notifications?.smtp()) return;
    if (outcome.kind === 'sent') {
      if (!mail.auto) this.deps.jobs.enqueue('mail.report', { ...reportPayload(outcome, mail, integration.id, now) }, new Date(now.getTime() + REPORT_FIRST_DELAY_MS));
      return;
    }
    const content = replyFor(outcome, mail, integration.config);
    if (content) this.deps.jobs.enqueue('mail', { ...content }, now);
  }

  /** Jedno powiadomienie na awarię: logowanie od razu, reszta po `afterMinutes` trwania. */
  private notifyFailure(integration: MailInIntegration, kind: MailboxErrorKind, error: string, now: Date): void {
    const state = this.deps.mailIn.state(integration.id);
    if (!state || state.notifiedAt !== null || state.errorSince === null) return;
    const afterMinutes = Number(this.deps.notifications?.rule('mailbox_failure').params.afterMinutes ?? DEFAULT_AFTER_MINUTES);
    const lasting = now.getTime() - Date.parse(state.errorSince) >= afterMinutes * 60_000;
    if (kind !== 'auth' && !lasting) return;
    this.deps.notifier?.notify('mailbox_failure', `mailbox:${integration.id}`,
      `Skrzynka ${integration.name}: ${KIND_WORDS[kind]} od ${hhmm(state.errorSince)} (${error})`, now, `mailbox:${integration.id}:${state.errorSince}`);
    this.deps.mailIn.markNotified(integration.id, now);
  }
}
