import { silentLogger } from '../log.ts';
import type { Job } from '../store/jobs.ts';
import { handleSend, notify, type WorkerDeps } from './send.ts';
import { handlePoll } from './poll.ts';
import { handleWebhook } from './webhook.ts';
import { handlePackageCreate, handlePackagePoll, handlePackageReport } from './packages.ts';

/**
 * Wyjątek spoza obsługi zadania (błąd bazy, nieczytelny sekret, błąd w kodzie) ponawiamy
 * z rosnącym odstępem, ale skończoną liczbę razy - inaczej jedno zepsute zadanie
 * krzyczałoby w dzienniku co minutę do końca świata.
 */
export const MAX_UNEXPECTED_ATTEMPTS = 8;
const UNEXPECTED_BACKOFF_BASE_MS = 60_000;
export const UNEXPECTED_BACKOFF_CAP_MS = 30 * 60_000;

/** Ile zadań jednej partii wykonuje się jednocześnie. Zadania różnych wiadomości są niezależne. */
const DEFAULT_CONCURRENCY = 10;

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly opts: { intervalMs?: number; batch?: number; concurrency?: number; now?: () => Date } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? 1000;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Jedna tura: pobiera partię zadań i wykonuje je równolegle, po kilka naraz. Każde
   * zadanie dotyczy innej wiadomości, rozsyłki albo dostawy, więc nie konkurują o dane;
   * dzięki temu wolna odpowiedź Multiinfo albo odbiorcy webhooka nie wstrzymuje reszty.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = (this.opts.now ?? (() => new Date()))();
      const jobs = this.deps.jobs.claim(now, this.opts.batch ?? 10);
      const width = Math.max(1, this.opts.concurrency ?? DEFAULT_CONCURRENCY);
      const queue = [...jobs];
      const lane = async () => {
        for (let job = queue.shift(); job !== undefined; job = queue.shift()) await this.run(job, now);
      };
      await Promise.all(Array.from({ length: Math.min(width, queue.length) }, lane));
    } finally {
      this.running = false;
    }
  }

  private async run(job: Job, now: Date): Promise<void> {
    try {
      if (job.type === 'send') await handleSend(job, this.deps, now);
      else if (job.type === 'poll') await handlePoll(job, this.deps, now);
      else if (job.type === 'webhook') await handleWebhook(job, this.deps, now);
      else if (job.type === 'package.create') await handlePackageCreate(job, this.deps, now);
      else if (job.type === 'package.poll') await handlePackagePoll(job, this.deps, now);
      else if (job.type === 'package.report') await handlePackageReport(job, this.deps, now);
      else this.deps.jobs.fail(job.id, `Nieznany typ zadania: ${job.type}`);
    } catch (error) {
      // Wyjątek poza obsługą zadania nie może zatrzymać całej pętli.
      const log = this.deps.log ?? silentLogger;
      const reason = error instanceof Error ? error.message : String(error);
      const attempt = job.attempts + 1;
      if (attempt < MAX_UNEXPECTED_ATTEMPTS) {
        const delay = Math.min(UNEXPECTED_BACKOFF_BASE_MS * 2 ** job.attempts, UNEXPECTED_BACKOFF_CAP_MS);
        log.error('worker.wyjatek', { jobId: job.id, type: job.type, attempt, error });
        this.deps.jobs.retry(job.id, new Date(now.getTime() + delay), reason);
        return;
      }
      log.error('worker.zadanie_porzucone', { jobId: job.id, type: job.type, attempt, error });
      this.deps.jobs.fail(job.id, reason);
      this.abandon(job, reason, now);
    }
  }

  /**
   * Ślad po porzuconym zadaniu przy wiadomości, której dotyczyło. Wysyłka, która nie
   * doszła do skutku, kończy wiadomość niepowodzeniem; przy odpytywaniu stanu nie
   * zgadujemy - zostaje ostatni znany, a przebieg mówi, że pytania ustały.
   */
  private abandon(job: Job, reason: string, now: Date): void {
    const messageId = typeof job.payload.messageId === 'string' ? job.payload.messageId : null;
    if (messageId === null) return;
    try {
      const detail = `zadanie ${job.type} porzucone po ${MAX_UNEXPECTED_ATTEMPTS} nieudanych próbach: ${reason}`;
      if (job.type !== 'send') {
        this.deps.events.record(messageId, now, 'abandoned', detail);
        return;
      }
      const description = `Wysyłka nie doszła do skutku. ${detail}`;
      this.deps.messages.setStatus(messageId, { status: 'failed', error: description, finalAt: now });
      this.deps.events.record(messageId, now, 'failed', description);
      // Odczyt wiadomości mógł być tym, co padało - webhook tylko wtedy, gdy się uda.
      const message = this.deps.messages.get(messageId);
      if (message) notify(this.deps, message, 'message.failed', { status: 'failed', to: message.dest, error: description }, now);
    } catch (error) {
      (this.deps.log ?? silentLogger).error('worker.porzucenie_bez_sladu', { jobId: job.id, messageId, error });
    }
  }
}
