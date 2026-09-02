import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';
import { NOTIFICATION_EVENTS, RULE_DEFAULTS } from '../../src/notifications/rules.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
let repo: NotificationsRepo;
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new NotificationsRepo(db, randomBytes(32));
});

describe('SMTP', () => {
  it('brak konfiguracji to null; zapis szyfruje hasło; pominięte hasło zostaje; null kasuje', () => {
    expect(repo.smtp()).toBeNull();
    expect(repo.smtpPassword()).toBeNull();
    repo.saveSmtp({ host: 'smtp.example', port: 587, security: 'starttls', user: 'gate', password: 'tajne', fromAddress: 'gate@example', fromName: 'Multiinfo Gate', recipients: ['a@example', 'b@example'], instanceName: 'bramka-test', panelUrl: null }, NOW);
    expect(repo.smtp()).toMatchObject({ host: 'smtp.example', port: 587, security: 'starttls', user: 'gate', recipients: ['a@example', 'b@example'], instanceName: 'bramka-test', panelUrl: null, updatedAt: NOW.toISOString() });
    expect(JSON.stringify(db.prepare('SELECT * FROM smtp_settings').get())).not.toContain('tajne');
    expect(repo.smtpPassword()).toBe('tajne');
    repo.saveSmtp({ host: 'smtp2.example', port: 465, security: 'tls', user: 'gate', fromAddress: 'gate@example', fromName: 'Gate', recipients: ['a@example'], instanceName: 'x', panelUrl: 'https://panel.example' }, NOW);
    expect(repo.smtpPassword()).toBe('tajne');
    expect(repo.smtp()).toMatchObject({ host: 'smtp2.example', panelUrl: 'https://panel.example' });
    repo.saveSmtp({ host: 'smtp2.example', port: 25, security: 'none', user: null, password: null, fromAddress: 'gate@example', fromName: 'Gate', recipients: ['a@example'], instanceName: 'x', panelUrl: null }, NOW);
    expect(repo.smtpPassword()).toBeNull();
    expect(repo.smtp()!.user).toBeNull();
  });
});

describe('reguły', () => {
  it('rules() zwraca komplet z domyślnymi i zapisuje je', () => {
    const rules = repo.rules();
    expect(rules.map((r) => r.event)).toEqual([...NOTIFICATION_EVENTS]);
    expect(repo.rule('daily_summary')).toMatchObject({ enabled: 0, params: { hour: 8 } });
    expect(repo.rule('certificate_expiring').params).toEqual(RULE_DEFAULTS.certificate_expiring.params);
    expect(repo.rule('integration_error')).toMatchObject({ enabled: 1, maxPerHour: 5, groupHours: 1 });
    repo.saveRule('integration_error', { enabled: 1, maxPerHour: 2, groupHours: 3, params: {} });
    expect(repo.rule('integration_error')).toMatchObject({ maxPerHour: 2, groupHours: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM notification_rules').get()).toEqual({ n: NOTIFICATION_EVENTS.length });
  });
});

describe('kolejka', () => {
  it('enqueue z dedupKey drugi raz daje null; bez dedupKey zawsze nowy wpis', () => {
    expect(repo.enqueue({ event: 'certificate_expiring', at: NOW, subjectKey: 'account:1', dedupKey: 'account:1:30', summary: 'x' })).not.toBeNull();
    expect(repo.enqueue({ event: 'certificate_expiring', at: NOW, subjectKey: 'account:1', dedupKey: 'account:1:30', summary: 'x' })).toBeNull();
    expect(repo.enqueue({ event: 'integration_error', at: NOW, summary: 'a' })).not.toBeNull();
    expect(repo.enqueue({ event: 'integration_error', at: NOW, summary: 'a' })).not.toBeNull();
  });
  it('pending, markSent, markSuppressed, liczniki', () => {
    const a = repo.enqueue({ event: 'integration_error', at: NOW, subjectKey: 'integration:1', summary: 'a' })!;
    const b = repo.enqueue({ event: 'integration_error', at: NOW, summary: 'b' })!;
    repo.enqueue({ event: 'webhook_undelivered', at: NOW, summary: 'c' });
    expect(repo.pending('integration_error').map((r) => r.id)).toEqual([a, b]);
    expect(repo.pending('integration_error')[0]).toMatchObject({ subjectKey: 'integration:1', summary: 'a', status: 'pending', sentAt: null });
    repo.markSent([a], NOW);
    repo.markSuppressed([b]);
    expect(repo.pending('integration_error')).toEqual([]);
    expect(repo.sentCountSince('integration_error', new Date(0))).toBe(1);
    expect(repo.sentCountSince('integration_error', new Date(NOW.getTime() + 1))).toBe(0);
    expect(repo.suppressedCountSince('integration_error', new Date(0))).toBe(1);
    expect(repo.lastSentAt('integration_error')).toBe(NOW.toISOString());
    expect(repo.lastSentAt('webhook_undelivered')).toBeNull();
  });
  it('pruneBefore usuwa stare załatwione wpisy, oczekujące zostają', () => {
    const old = new Date('2026-07-01T00:00:00Z');
    const a = repo.enqueue({ event: 'integration_error', at: old, summary: 'a' })!;
    repo.enqueue({ event: 'integration_error', at: old, summary: 'b' });
    repo.markSent([a], old);
    expect(repo.pruneBefore(NOW)).toBe(1);
    expect(repo.pending('integration_error')).toHaveLength(1);
  });
});
