import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMail, MAIL_BACKOFF_MS } from '../../src/worker/mail.ts';
import type { WorkerDeps } from '../../src/worker/send.ts';
import { openDatabase } from '../../src/store/db.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
let jobs: JobsRepo;
let notifications: NotificationsRepo;
let mailer: ReturnType<typeof vi.fn>;
let deps: WorkerDeps;

beforeEach(() => {
  const db = openDatabase(':memory:');
  jobs = new JobsRepo(db);
  notifications = new NotificationsRepo(db, randomBytes(32));
  mailer = vi.fn();
  deps = { jobs, notifications, mailer } as unknown as WorkerDeps;
});

const smtp = () => notifications.saveSmtp({ host: 'smtp.example', port: 465, security: 'tls', user: 'gate', password: 'tajne', fromAddress: 'gate@example', fromName: 'Multiinfo Gate', recipients: ['a@example', 'b@example'], instanceName: 'mi', panelUrl: null }, NOW);
const job = (attempts = 0) => {
  const id = jobs.enqueue('mail', { subject: 'Temat', text: 'Treść' }, NOW);
  return { id, type: 'mail' as const, payload: { subject: 'Temat', text: 'Treść' }, attempts, lastError: null };
};

describe('handleMail', () => {
  it('woła mailer z ustawieniami, hasłem i treścią, po czym kończy zadanie', async () => {
    smtp();
    mailer.mockResolvedValue(undefined);
    await handleMail(job(), deps, NOW);
    expect(mailer).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example', port: 465, security: 'tls', user: 'gate', password: 'tajne', recipients: ['a@example', 'b@example'] }),
      { subject: 'Temat', text: 'Treść' },
    );
    expect(jobs.depth()).toBe(0);
  });
  it('błąd mailera ponawia po 1, 5 i 15 minutach, potem porzuca', async () => {
    smtp();
    mailer.mockRejectedValue(new Error('535 Authentication failed'));
    const j = job();
    await handleMail(j, deps, NOW);
    expect(jobs.claim(NOW, 10)).toEqual([]);
    expect(jobs.claim(new Date(NOW.getTime() + MAIL_BACKOFF_MS[0]), 10).map((x) => x.id)).toEqual([j.id]);
    await handleMail({ ...j, attempts: MAIL_BACKOFF_MS.length }, deps, NOW);
    expect(jobs.depth()).toBe(0);
    expect(mailer).toHaveBeenCalledTimes(2);
  });
  it('adresat z ładunku zadania zastępuje adresatów administratora, nagłówki wątku idą dalej', async () => {
    smtp();
    mailer.mockResolvedValue(undefined);
    const id = jobs.enqueue('mail', { subject: 'Re: Awaria', text: 'SMS wysłany', to: ['tomek@przyklad.test'], inReplyTo: '<m1@x>', references: '<m1@x>' }, NOW);
    await handleMail(jobs.claim(NOW, 1)[0]!, deps, NOW);
    expect(mailer.mock.calls[0]![1]).toEqual({ subject: 'Re: Awaria', text: 'SMS wysłany', to: ['tomek@przyklad.test'], inReplyTo: '<m1@x>', references: '<m1@x>' });
    expect(jobs.depth()).toBe(0);
    expect(id).toBeGreaterThan(0);
  });
  it('adresat jako napis albo pusta lista: napis idzie jako jeden adresat, pusta lista znaczy administratora', async () => {
    smtp();
    mailer.mockResolvedValue(undefined);
    jobs.enqueue('mail', { subject: 'a', text: 'b', to: 'x@przyklad.test' }, NOW);
    await handleMail(jobs.claim(NOW, 1)[0]!, deps, NOW);
    expect(mailer.mock.calls[0]![1]).toEqual({ subject: 'a', text: 'b', to: ['x@przyklad.test'] });
    jobs.enqueue('mail', { subject: 'a', text: 'b', to: [] }, NOW);
    await handleMail(jobs.claim(NOW, 1)[0]!, deps, NOW);
    expect(mailer.mock.calls[1]![1]).toEqual({ subject: 'a', text: 'b' });
  });
  it('bez SMTP porzuca zadanie bez wywołania mailera', async () => {
    await handleMail(job(), deps, NOW);
    expect(mailer).not.toHaveBeenCalled();
    expect(jobs.depth()).toBe(0);
  });
});
