import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { JobsRepo } from '../../src/store/jobs.ts';

const at = (offsetMs: number) => new Date(Date.parse('2026-08-25T10:00:00Z') + offsetMs);

describe('JobsRepo', () => {
  it('wydaje zadanie, którego czas już minął', () => {
    const repo = new JobsRepo(openDatabase(':memory:'));
    repo.enqueue('send', { messageId: 'msg_1' }, at(0));
    const claimed = repo.claim(at(1000), 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.type).toBe('send');
    expect(claimed[0]!.payload).toEqual({ messageId: 'msg_1' });
  });

  it('nie wydaje zadania zaplanowanego na przyszłość', () => {
    const repo = new JobsRepo(openDatabase(':memory:'));
    repo.enqueue('send', { messageId: 'msg_1' }, at(60_000));
    expect(repo.claim(at(0), 10)).toHaveLength(0);
  });

  it('nie wydaje dwa razy tego samego zadania', () => {
    const repo = new JobsRepo(openDatabase(':memory:'));
    repo.enqueue('send', { messageId: 'msg_1' }, at(0));
    expect(repo.claim(at(1000), 10)).toHaveLength(1);
    expect(repo.claim(at(1000), 10)).toHaveLength(0);
  });

  it('zwalnia zadanie po zaplanowaniu ponowienia', () => {
    const repo = new JobsRepo(openDatabase(':memory:'));
    repo.enqueue('send', { messageId: 'msg_1' }, at(0));
    const [job] = repo.claim(at(0), 10);
    repo.retry(job!.id, at(5000), 'timeout');
    expect(repo.claim(at(1000), 10)).toHaveLength(0);
    const again = repo.claim(at(6000), 10);
    expect(again).toHaveLength(1);
    expect(again[0]!.attempts).toBe(1);
    expect(again[0]!.lastError).toBe('timeout');
  });

  it('odkłada zadanie bez zużycia ponowienia', () => {
    const repo = new JobsRepo(openDatabase(':memory:'));
    repo.enqueue('send', { messageId: 'msg_1' }, at(0));
    const [job] = repo.claim(at(0), 10);
    repo.defer(job!.id, at(60_000), 'konto wstrzymane');
    expect(repo.claim(at(1000), 10)).toHaveLength(0);
    const again = repo.claim(at(61_000), 10);
    expect(again).toHaveLength(1);
    expect(again[0]!.attempts).toBe(0);
    expect(again[0]!.lastError).toBe('konto wstrzymane');
  });

  it('usuwa zadanie zakończone powodzeniem', () => {
    const repo = new JobsRepo(openDatabase(':memory:'));
    repo.enqueue('send', { messageId: 'msg_1' }, at(0));
    const [job] = repo.claim(at(0), 10);
    repo.complete(job!.id);
    expect(repo.claim(at(60_000), 10)).toHaveLength(0);
  });

  it('odzyskuje zadanie porzucone przez proces, który padł', () => {
    const repo = new JobsRepo(openDatabase(':memory:'));
    repo.enqueue('send', { messageId: 'msg_1' }, at(0));
    repo.claim(at(0), 10);
    // Blokada starsza niż piętnaście minut oznacza, że proces nie żyje.
    expect(repo.claim(at(16 * 60_000), 10)).toHaveLength(1);
  });

  it('usuwa zadanie zakończone niepowodzeniem i podaje głębokość kolejki', () => {
    const repo = new JobsRepo(openDatabase(':memory:'));
    repo.enqueue('send', { messageId: 'msg_1' }, at(0));
    repo.enqueue('poll', { messageId: 'msg_2' }, at(0));
    expect(repo.depth()).toBe(2);
    const [job] = repo.claim(at(0), 1);
    repo.fail(job!.id, 'konto wstrzymane');
    expect(repo.depth()).toBe(1);
  });
});
