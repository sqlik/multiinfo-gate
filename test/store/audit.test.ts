import { describe, expect, it } from 'vitest';
import { AuditRepo } from '../../src/store/audit.ts';
import { openDatabase } from '../../src/store/db.ts';

const setup = () => new AuditRepo(openDatabase(':memory:'));

describe('AuditRepo', () => {
  it('zapisuje wpis z adresem IP i odczytuje go przez list', () => {
    const repo = setup();
    repo.record({
      actor: 'rose',
      action: 'api_key.create',
      target: 'rejestracja',
      meta: { accountId: 1, maxParts: 3 },
      ip: '10.20.0.14',
    });

    const [entry] = repo.list(10, 0);
    expect(entry?.actor).toBe('rose');
    expect(entry?.action).toBe('api_key.create');
    expect(entry?.target).toBe('rejestracja');
    expect(entry?.meta).toEqual({ accountId: 1, maxParts: 3 });
    expect(entry?.ip).toBe('10.20.0.14');
    expect(entry?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('przyjmuje wpis bez celu, opisu i adresu', () => {
    const repo = setup();
    repo.record({ actor: 'system', action: 'account.pause' });

    const [entry] = repo.list(10, 0);
    expect(entry?.actor).toBe('system');
    expect(entry).not.toHaveProperty('target');
    expect(entry).not.toHaveProperty('meta');
    expect(entry).not.toHaveProperty('ip');
  });

  it('zwraca wpisy od najnowszego i respektuje limit z przesunięciem', () => {
    const repo = setup();
    repo.record({ actor: 'rose', action: 'pierwsza' });
    repo.record({ actor: 'rose', action: 'druga' });
    repo.record({ actor: 'rose', action: 'trzecia' });

    expect(repo.list(10, 0).map((e) => e.action)).toEqual(['trzecia', 'druga', 'pierwsza']);
    expect(repo.list(1, 0).map((e) => e.action)).toEqual(['trzecia']);
    expect(repo.list(1, 2).map((e) => e.action)).toEqual(['pierwsza']);
  });
});
