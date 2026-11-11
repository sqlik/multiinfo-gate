import { MAIL_IN_PASSWORD_REF, type MailInConfig } from '../integrations/config.ts';
import { warsawTime } from '../time/warsaw.ts';
import { MailboxError, authSecret, errorKindOf, errorMessageOf, guardedConnect, scrubError, type MailboxAuth, type MailboxConnect, type MailboxSession, type MailboxSettings } from '../integrations/mail/client.ts';
import { M365_IMAP_REFUSED, imapTarget, m365MailboxAuth, type M365MailboxDeps } from '../m365/mailbox.ts';
import { systemResolver, type Resolver } from '../net/private-address.ts';
import { parseMail, type ParsedMail } from '../integrations/mail/parse.ts';
import { runMailIn, subjectNote, type MailInIntegration, type MailInOutcome, type PipelineDeps } from '../integrations/pipeline.ts';
import { silentLogger, type Logger } from '../log.ts';
import type { AdminNotifier } from '../notifications/rules.ts';
import { isMailIn } from '../store/integrations.ts';
import type { MailInRepo, MailboxErrorKind, SeenKey, SeenOutcome } from '../store/mail-in.ts';
import type { NotificationsRepo } from '../store/notifications.ts';
import type { MailContent } from './mail.ts';
import { REPORT_FIRST_DELAY_MS, reportPayload } from './mail-report.ts';

/** Maile pobierane w całości w jednym odpytaniu. */
export const MAX_PER_POLL = 50;
/** Maile oglądane po samych metadanych w jednym odpytaniu oraz wielkość jednej partii metadanych. */
export const MAX_SCAN_PER_POLL = 1000;
const META_BATCH = 200;
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
  /** Rozwiązywanie nazwy serwera przed połączeniem; bez niego `connect` idzie bez sprawdzenia sieci (testy z atrapą). */
  resolve?: Resolver;
  allowPrivateMail?: boolean;
  notifier?: AdminNotifier;
  notifications?: Pick<NotificationsRepo, 'rule' | 'smtp'>;
  log?: Logger;
  /** Konta Microsoft 365 skrzynek logujących się tokenem; bez nich takie skrzynki czekają jak przy koncie wymagającym logowania. */
  m365?: M365MailboxDeps;
}

/**
 * Odstęp po nieudanym odpytaniu: interwał razy 2^(failures-1), do 15 min, ale nigdy krócej niż
 * ustawiona częstotliwość; logowanie co najmniej 5 min. Konto Microsoft 365 wymagające logowania:
 * zwykły interwał, bo bramka nie łączy się z serwerem, a skrzynka powinna ruszyć zaraz po zalogowaniu.
 */
export function nextPollDelayMs(intervalSec: number, failures: number, kind: MailboxErrorKind | null): number {
  const base = intervalSec * 1000;
  if (kind === 'account') return base;
  const grown = Math.min(base * 2 ** Math.max(0, failures - 1), Math.max(BACKOFF_CAP_MS, base));
  return kind === 'auth' ? Math.max(grown, AUTH_RETRY_MS) : grown;
}

const KIND_WORDS: Record<MailboxErrorKind, string> = {
  auth: 'logowanie odrzucone', network: 'serwer nie odpowiada', folder: 'folder niedostępny', other: 'błąd odpytania',
  account: 'konto Microsoft 365 wymaga logowania',
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
  Promise<{ ok: true; unseen: number; folders: string[]; authservId: string | null } | { ok: false; kind: MailboxErrorKind; error: string; folders: string[] }> {
  let session: MailboxSession | null = null;
  let folders: string[] = [];
  try {
    session = await connect(settings, CONNECT_TIMEOUT_MS);
    folders = await session.folders();
    const box = await session.open(folder);
    const authservId = (await session.authservId?.()) ?? null;
    return { ok: true, unseen: box.unseen, folders, authservId };
  } catch (e) {
    // Lista folderów zostaje, gdy logowanie się udało, a zawiodła nazwa folderu: użytkownik od razu widzi właściwą.
    return { ok: false, kind: errorKindOf(e), error: scrubError(errorMessageOf(e), [authSecret(settings.auth), settings.user]), folders };
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

  private readonly deps: MailInDeps;

  constructor(deps: MailInDeps, private readonly opts: { concurrency?: number } = {}) {
    this.deps = deps.resolve ? { ...deps, connect: guardedConnect(deps.connect, deps.resolve ?? systemResolver, deps.allowPrivateMail === true) } : deps;
  }

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
    let secret = '';
    let timer: NodeJS.Timeout | null = null;
    // Po przekroczeniu limitu praca kończy bieżący mail i przerywa pętlę; spóźnione połączenie jest zamykane bez pracy.
    let aborted = false;
    try {
      const auth = await this.mailboxAuth(integration, now);
      secret = authSecret(auth);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { aborted = true; reject(new MailboxError('network', `odpytanie przekroczyło ${POLL_TIMEOUT_MS / 1000} s`)); }, POLL_TIMEOUT_MS);
      });
      const work = (async () => {
        const session = await this.deps.connect({ ...imapTarget(config.imap), auth }, CONNECT_TIMEOUT_MS);
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
      const scrubbed = scrubError(errorMessageOf(e), [secret, config.imap.user]);
      // Odmowa XOAUTH2 przy działającym tokenie: przyczyna leży w ustawieniach skrzynki, nie w koncie (spec 6.3).
      const error = kind === 'auth' && config.imap.auth.mode === 'm365' ? `${M365_IMAP_REFUSED}. Odpowiedź serwera: ${scrubbed}` : scrubbed;
      const before = mailIn.state(integration.id);
      // Jak w recordPoll: przejście między czekaniem na konto a innym błędem liczy się od pierwszej próby.
      const fresh = !before || (before.errorKind === 'account') !== (kind === 'account');
      const failures = fresh ? 1 : before.failures + 1;
      mailIn.recordPoll(integration.id, { ok: false, error, errorKind: kind, at: now, nextPollAt: new Date(now.getTime() + nextPollDelayMs(config.intervalSec, failures, kind)) });
      log.warn('skrzynka.blad', { integrationId: integration.id, kind, failures });
      this.notifyFailure(integration, kind, error, now, before?.errorKind ?? null);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Hasło z sekretów albo token dostępu konta Microsoft 365; błąd jako MailboxError, przed połączeniem. */
  private async mailboxAuth(integration: MailInIntegration, now: Date): Promise<MailboxAuth> {
    const mode = integration.config.imap.auth;
    if (mode.mode === 'm365') {
      const got = await m365MailboxAuth(this.deps.m365, mode.accountId, now);
      if (!got.ok) throw new MailboxError(got.kind, got.error);
      return got.auth;
    }
    const password = this.deps.integrations.secrets(integration.id)[MAIL_IN_PASSWORD_REF] ?? '';
    if (password === '') throw new MailboxError('auth', 'brak hasła w konfiguracji');
    return { kind: 'password', password };
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
    // Do limitu MAX_PER_POLL liczą się tylko maile pobierane w całości. Pominięcia po samych metadanych (mail przetworzony,
    // starszy niż limit wieku) nie zajmują miejsc, dlatego zaległość po przerwie nie opóźnia świeżego alarmu.
    const uids = (await session.unseen(floor)).slice(0, MAX_SCAN_PER_POLL);
    let actionError: Error | null = null;
    let highest = floor;
    let fetched = 0;
    scan: for (let i = 0; i < uids.length; i += META_BATCH) {
      const metas = (await session.meta(uids.slice(i, i + META_BATCH))).sort((a, b) => a.uid - b.uid);
      for (const meta of metas) {
        // Po przekroczeniu limitu czasu albo liczby maili reszta czeka na następne odpytanie; próg wskazuje ostatni obejrzany mail.
        if (aborted() || fetched >= MAX_PER_POLL) break scan;
        highest = Math.max(highest, meta.uid);
        const key: SeenKey = { messageId: meta.messageId, uidvalidity: box.uidValidity, uid: meta.uid };
        // Wpis bez pobierania treści: nadawca i temat z koperty, w tym samym układzie co wpisy potoku.
        const note = (result: 'skipped', reason: string) =>
          this.deps.integrationEvents.record({
            integrationId: integration.id, at: now, result, reason: `${reason} · ${subjectNote(meta.subject)}`, logLimit: config.eventLogLimit,
            ...(meta.from ? { sourceIp: meta.from } : {}),
          });
        if (mailIn.seen(integration.id, key)) {
          // Ktoś celowo oznaczył mail jako nieprzeczytany albo folder odtworzono: bez działania na mailu.
          mailIn.remember(integration.id, key, 'skipped', now);
          note('skipped', 'wiadomość już przetworzona');
          continue;
        }
        // Limit wieku (spec 6.6): stary alarm po przerwie nie wychodzi jako świeży SMS. Mail zostaje nieprzeczytany do wglądu,
        // bez SMS-a, odpowiedzi i działania. Brak daty przyjęcia nie pomija maila, bo pominięcie byłoby ciche.
        if (config.maxAgeHours !== null && meta.internalDate !== null && now.getTime() - meta.internalDate.getTime() > config.maxAgeHours * 3_600_000) {
          mailIn.remember(integration.id, key, 'skipped', now);
          mailIn.forgetMessageId(integration.id, key);
          note('skipped', `wiadomość starsza niż ${config.maxAgeHours} h`);
          continue;
        }
        if (meta.size > MAX_MAIL_BYTES) {
          mailIn.remember(integration.id, key, 'skipped', now);
          mailIn.forgetMessageId(integration.id, key);
          note('skipped', `wiadomość zbyt duża (${(meta.size / (1024 * 1024)).toFixed(1)} MB)`);
          actionError = (await this.afterAction(session, config, meta.uid)) ?? actionError;
          continue;
        }
        // Zapis przed pobraniem i wysyłką: awaria w połowie kosztuje jeden niedosłany SMS, nie dubel.
        fetched += 1;
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
          // Mail odrzucony przed potwierdzeniem nadawcy (integracja niedostępna, nadawca spoza listy albo bez SPF/DKIM)
          // nie zajmuje cudzego Message-ID. Message-ID zostaje wyłącznie po sprawdzeniu nadawcy.
          const unchecked = outcome.kind === 'unavailable'
            || (outcome.kind === 'skipped' && (outcome.reason === 'sender_not_allowed' || outcome.reason === 'auth_failed'));
          if (unchecked) mailIn.forgetMessageId(integration.id, key);
          this.notifyOutcome(integration, outcome, now);
          actionError = (await this.afterAction(session, config, meta.uid)) ?? actionError;
          this.reply(integration, outcome, mail, now);
        } catch (e) {
          await failMail(e, 'błąd przetwarzania wiadomości', false);
        }
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

  /**
   * Jedno powiadomienie na awarię: logowanie od razu, w skrzynce Microsoft 365 przy drugim odrzuceniu z rzędu,
   * reszta po `afterMinutes` trwania. `previousKind` to rodzaj błędu sprzed bieżącego odpytania.
   */
  private notifyFailure(integration: MailInIntegration, kind: MailboxErrorKind, error: string, now: Date, previousKind: MailboxErrorKind | null): void {
    const state = this.deps.mailIn.state(integration.id);
    // Konto wymagające logowania zgłasza reguła konta Microsoft 365: jedna przyczyna, jedno powiadomienie, nie po jednym na skrzynkę.
    if (kind === 'account' || !state || state.notifiedAt !== null || state.errorSince === null) return;
    // Exchange odrzuca czasem pojedyncze logowanie przy sprawnym koncie („Command Argument Error. 11”). Trwała awaria,
    // na przykład odwołany sekret aplikacji, powtarza się przy następnej próbie, czyli po AUTH_RETRY_MS.
    if (kind === 'auth' && integration.config.imap.auth.mode === 'm365' && previousKind !== 'auth') return;
    const afterMinutes = Number(this.deps.notifications?.rule('mailbox_failure').params.afterMinutes ?? DEFAULT_AFTER_MINUTES);
    const lasting = now.getTime() - Date.parse(state.errorSince) >= afterMinutes * 60_000;
    if (kind !== 'auth' && !lasting) return;
    this.deps.notifier?.notify('mailbox_failure', `mailbox:${integration.id}`,
      `Skrzynka ${integration.name}: ${KIND_WORDS[kind]} od ${hhmm(state.errorSince)} (${error})`, now, `mailbox:${integration.id}:${state.errorSince}`);
    this.deps.mailIn.markNotified(integration.id, now);
  }
}
