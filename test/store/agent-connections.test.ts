import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentConnectionsRepo } from '../../src/store/agent-connections.ts';
import { openDatabase } from '../../src/store/db.ts';
import { OAuthRepo } from '../../src/store/oauth.ts';
import { seedAgentIntegration } from './helpers.ts';

const NOW = new Date('2026-11-15T08:00:00Z');
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
let db: Database;
let repo: AgentConnectionsRepo;
let oauth: OAuthRepo;
let integrationId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  integrationId = seedAgentIntegration(db, randomBytes(32)).integrationId;
  repo = new AgentConnectionsRepo(db);
  oauth = new OAuthRepo(db);
});

const add = (name = 'Ewa Nowak', over: Partial<Parameters<AgentConnectionsRepo['insert']>[0]> = {}) =>
  repo.insert({ integrationId, name, method: 'oauth', expiresAt: '2027-02-13T08:00:00.000Z', createdBy: 'admin', createdAt: NOW, ...over });

const client = (clientId = 'cli_claude') => {
  oauth.upsertClient({ clientId, kind: 'dynamic', name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], sourceIp: '203.0.113.10', createdAt: NOW.toISOString(), fetchedAt: null });
  return clientId;
};

const token = (connectionId: number, hash: string, kind: 'access' | 'refresh' = 'access') =>
  oauth.insertToken(hash, { connectionId, kind, expiresAt: later(60).toISOString(), createdAt: NOW.toISOString() });

describe('AgentConnectionsRepo', () => {
  it('insert zapisuje połączenie bez kodu i bez tokenu, a lista integracji zachowuje kolejność dodania', () => {
    const first = add();
    const second = add('Marek Kowalski', { method: 'token', expiresAt: null });
    expect(repo.get(first)).toEqual({
      id: first, integrationId, name: 'Ewa Nowak', method: 'oauth', codeExpiresAt: null, codeUsedAt: null, clientId: null, clientName: null,
      expiresAt: '2027-02-13T08:00:00.000Z', createdAt: NOW.toISOString(), createdBy: 'admin', lastUsedAt: null, revokedAt: null, revokedReason: null,
    });
    expect(repo.listForIntegration(integrationId).map((c) => [c.name, c.method])).toEqual([['Ewa Nowak', 'oauth'], ['Marek Kowalski', 'token']]);
    expect(repo.get(999)).toBeUndefined();
  });

  it('setCode zapisuje skrót i termin kodu oraz czyści znacznik użycia, a findByCodeHash znajduje połączenie', () => {
    const id = add();
    repo.setCode(id, 'skrot-1', later(1440).toISOString());
    repo.useCode(id, { clientId: client(), clientName: 'Claude' }, later(5));
    repo.setCode(id, 'skrot-2', later(1500).toISOString());
    const row = repo.findByCodeHash('skrot-2')!;
    expect([row.id, row.codeExpiresAt, row.codeUsedAt]).toEqual([id, later(1500).toISOString(), null]);
    expect(repo.findByCodeHash('skrot-1')).toBeUndefined();
  });

  it('useCode usuwa tokeny OAuth połączenia i zapisuje klienta', () => {
    const id = add();
    const other = add('Marek Kowalski');
    repo.setCode(id, 'skrot-1', later(1440).toISOString());
    token(id, 'dostep-1');
    token(id, 'odswiezanie-1', 'refresh');
    token(other, 'dostep-innego');

    repo.useCode(id, { clientId: client(), clientName: 'Claude' }, later(5));

    const row = repo.get(id)!;
    expect([row.codeUsedAt, row.clientId, row.clientName]).toEqual([later(5).toISOString(), 'cli_claude', 'Claude']);
    expect(oauth.getToken('dostep-1')).toBeUndefined();
    expect(oauth.getToken('odswiezanie-1')).toBeUndefined();
    expect(oauth.getToken('dostep-innego')).toBeDefined();
  });

  it('setToken nadpisuje poprzedni skrót tokenu połączenia', () => {
    const id = add('Marek Kowalski', { method: 'token' });
    repo.setToken(id, 'token-1');
    repo.setToken(id, 'token-2');
    expect(repo.findByTokenHash('token-2')?.id).toBe(id);
    expect(repo.findByTokenHash('token-1')).toBeUndefined();
  });

  it('touch zapisuje ostatnie użycie, a revoke zapisuje powód i usuwa tokeny OAuth', () => {
    const id = add();
    token(id, 'dostep-1');
    repo.touch(id, later(10));
    repo.revoke(id, 'reuse', later(20));
    const row = repo.get(id)!;
    expect([row.lastUsedAt, row.revokedAt, row.revokedReason]).toEqual([later(10).toISOString(), later(20).toISOString(), 'reuse']);
    expect(oauth.getToken('dostep-1')).toBeUndefined();
  });

  it('remove usuwa połączenie razem z tokenami', () => {
    const id = add();
    token(id, 'dostep-1');
    repo.remove(id);
    expect(repo.get(id)).toBeUndefined();
    expect(oauth.getToken('dostep-1')).toBeUndefined();
  });

  it('countActive liczy połączenia z użytym kodem albo z tokenem, bez odwołanych i wygasłych', () => {
    const used = add('Ewa Nowak');
    repo.setCode(used, 'k1', later(60).toISOString());
    repo.useCode(used, { clientId: client(), clientName: 'Claude' }, later(1));
    const withToken = add('Marek Kowalski', { method: 'token', expiresAt: null });
    repo.setToken(withToken, 't1');
    const waiting = add('Anna Wiśniewska');
    repo.setCode(waiting, 'k2', later(60).toISOString());
    const revoked = add('Jan Zieliński', { method: 'token' });
    repo.setToken(revoked, 't2');
    repo.revoke(revoked, 'admin', later(2));
    const expired = add('Piotr Wójcik', { method: 'token', expiresAt: later(30).toISOString() });
    repo.setToken(expired, 't3');

    expect(repo.countActive(integrationId, later(10))).toBe(3);
    expect(repo.countActive(integrationId, later(31))).toBe(2);
  });
});
