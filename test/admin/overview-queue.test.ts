import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';
import { queuedJobs } from '../../src/admin/views/overview.ts';

const NOW = new Date('2026-08-25T10:00:00Z');

describe('queuedJobs', () => {
  it('odmienia liczbę zadań w kolejce workera', () => {
    expect(queuedJobs(0)).toBe('0 zadań czeka w kolejce workera');
    expect(queuedJobs(1)).toBe('1 zadanie czeka w kolejce workera');
    expect(queuedJobs(2)).toBe('2 zadania czekają w kolejce workera');
    expect(queuedJobs(4)).toBe('4 zadania czekają w kolejce workera');
    expect(queuedJobs(5)).toBe('5 zadań czeka w kolejce workera');
    expect(queuedJobs(12)).toBe('12 zadań czeka w kolejce workera');
    expect(queuedJobs(14)).toBe('14 zadań czeka w kolejce workera');
    expect(queuedJobs(22)).toBe('22 zadania czekają w kolejce workera');
    expect(queuedJobs(111)).toBe('111 zadań czeka w kolejce workera');
  });
});

describe('kafelek „W drodze”', () => {
  let h: AdminHarness;

  beforeEach(async () => {
    h = await startAdminHarness(NOW);
  });

  it('podaje liczbę zadań w kolejce w odmienionej formie', async () => {
    h.jobs.enqueue('send', { messageId: 'msg_a' }, NOW);
    h.jobs.enqueue('send', { messageId: 'msg_b' }, NOW);
    const res = await h.app.inject({ method: 'GET', url: '/przeglad', headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('2 zadania czekają w kolejce workera');
    expect(res.body).not.toContain('zadań czeka w kolejce workera');
  });
});
