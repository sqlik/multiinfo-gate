import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentConnectionsRepo } from '../../src/store/agent-connections.ts';
import { openDatabase } from '../../src/store/db.ts';
import { OAuthRepo } from '../../src/store/oauth.ts';
import { seedAgentIntegration } from './helpers.ts';

const NOW = new Date('2026-11-15T08:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;
const DAY = 86_400_000;
let repo: OAuthRepo;
let connections: AgentConnectionsRepo;
let connectionId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const { integrationId } = seedAgentIntegration(db, randomBytes(32));
  repo = new OAuthRepo(db);
  connections = new AgentConnectionsRepo(db);
  connectionId = connections.insert({ integrationId, name: 'Ewa Nowak', method: 'oauth', expiresAt: null, createdBy: 'admin', createdAt: NOW });
});

const dynamic = (clientId: string, createdAt = NOW) => repo.upsertClient({
  clientId, kind: 'dynamic', name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], sourceIp: '203.0.113.10',
  createdAt: createdAt.toISOString(), fetchedAt: null,
});

const code = (hash: string, expiresAt = at(MIN)) => repo.insertCode(hash, {
  connectionId, clientId: 'cli_claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'wyzwanie',
  resource: 'https://bramka.serwis.example/mcp', expiresAt: expiresAt.toISOString(),
});

describe('OAuthRepo: klienci', () => {
  it('upsertClient zapisuje klienta z listą adresów powrotu, a ponowny zapis aktualizuje nazwę i adresy', () => {
    dynamic('cli_claude');
    expect(repo.getClient('cli_claude')).toEqual({
      clientId: 'cli_claude', kind: 'dynamic', name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], sourceIp: '203.0.113.10',
      createdAt: NOW.toISOString(), fetchedAt: null, connectedAt: null,
    });
    repo.upsertClient({
      clientId: 'https://chatgpt.com/oauth/client.json', kind: 'metadata', name: 'ChatGPT', redirectUris: ['https://chatgpt.com/connector/oauth/cb'],
      sourceIp: null, createdAt: NOW.toISOString(), fetchedAt: NOW.toISOString(),
    });
    repo.upsertClient({
      clientId: 'https://chatgpt.com/oauth/client.json', kind: 'metadata', name: 'ChatGPT Business', redirectUris: ['https://chatgpt.com/connector/oauth/cb2'],
      sourceIp: null, createdAt: at(DAY).toISOString(), fetchedAt: at(DAY).toISOString(),
    });
    const metadata = repo.getClient('https://chatgpt.com/oauth/client.json')!;
    expect([metadata.name, metadata.redirectUris, metadata.createdAt, metadata.fetchedAt])
      .toEqual(['ChatGPT Business', ['https://chatgpt.com/connector/oauth/cb2'], NOW.toISOString(), at(DAY).toISOString()]);
    expect(repo.getClient('nieznany')).toBeUndefined();
  });

  it('markConnected zapisuje chwilę pierwszego połączenia', () => {
    dynamic('cli_claude');
    repo.markConnected('cli_claude', at(MIN));
    expect(repo.getClient('cli_claude')!.connectedAt).toBe(at(MIN).toISOString());
  });
});

describe('OAuthRepo: kody autoryzacji', () => {
  it('takeCode zwraca kod i oznacza użycie', () => {
    code('kod-1');
    expect(repo.takeCode('kod-1', at(10_000))).toEqual({
      connectionId, clientId: 'cli_claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'wyzwanie',
      resource: 'https://bramka.serwis.example/mcp', expiresAt: at(MIN).toISOString(),
    });
  });

  it('takeCode drugi raz zwraca undefined, kod po terminie też', () => {
    code('kod-1');
    code('kod-2');
    expect(repo.takeCode('kod-1', at(10_000))).toBeDefined();
    expect(repo.takeCode('kod-1', at(20_000))).toBeUndefined();
    expect(repo.takeCode('kod-2', at(MIN))).toBeUndefined();
    expect(repo.takeCode('nieznany', at(0))).toBeUndefined();
  });
});

describe('OAuthRepo: tokeny', () => {
  it('insertToken, getToken, rotate i deleteToken', () => {
    repo.insertToken('rt-1', { connectionId, kind: 'refresh', expiresAt: null, createdAt: NOW.toISOString() });
    expect(repo.getToken('rt-1')).toEqual({ connectionId, kind: 'refresh', expiresAt: null, createdAt: NOW.toISOString(), rotatedAt: null, gracePairEnc: null });
    repo.rotate('rt-1', 'para-zaszyfrowana', at(MIN));
    expect(repo.getToken('rt-1')).toMatchObject({ rotatedAt: at(MIN).toISOString(), gracePairEnc: 'para-zaszyfrowana' });
    repo.deleteToken('rt-1');
    expect(repo.getToken('rt-1')).toBeUndefined();
  });

  it('deleteForConnection usuwa tokeny i kody połączenia', () => {
    repo.insertToken('at-1', { connectionId, kind: 'access', expiresAt: at(60 * MIN).toISOString(), createdAt: NOW.toISOString() });
    code('kod-1');
    repo.deleteForConnection(connectionId);
    expect(repo.getToken('at-1')).toBeUndefined();
    expect(repo.takeCode('kod-1', at(1000))).toBeUndefined();
  });
});

describe('OAuthRepo.prune', () => {
  it('prune usuwa klienta dynamicznego bez połączenia po dobie i zostawia klienta z dokumentu metadanych', () => {
    dynamic('cli_porzucony', NOW);
    dynamic('cli_swiezy', at(DAY - MIN));
    dynamic('cli_polaczony', NOW);
    repo.markConnected('cli_polaczony', at(MIN));
    repo.upsertClient({
      clientId: 'https://chatgpt.com/oauth/client.json', kind: 'metadata', name: 'ChatGPT', redirectUris: ['https://chatgpt.com/connector/oauth/cb'],
      sourceIp: null, createdAt: NOW.toISOString(), fetchedAt: NOW.toISOString(),
    });

    expect(repo.prune(at(DAY + MIN)).clients).toBe(1);

    expect(repo.getClient('cli_porzucony')).toBeUndefined();
    expect(repo.getClient('cli_swiezy')).toBeDefined();
    expect(repo.getClient('cli_polaczony')).toBeDefined();
    expect(repo.getClient('https://chatgpt.com/oauth/client.json')).toBeDefined();
  });

  it('prune usuwa kody i tokeny dostępu po terminie, tolerancję starszą niż 60 s i tokeny odświeżania 30 dni po rotacji', () => {
    code('kod-stary', at(MIN));
    code('kod-wazny', at(10 * MIN));
    repo.insertToken('at-stary', { connectionId, kind: 'access', expiresAt: at(MIN).toISOString(), createdAt: NOW.toISOString() });
    repo.insertToken('at-wazny', { connectionId, kind: 'access', expiresAt: at(60 * MIN).toISOString(), createdAt: NOW.toISOString() });
    repo.insertToken('rt-rotowany-dawno', { connectionId, kind: 'refresh', expiresAt: null, createdAt: NOW.toISOString() });
    repo.rotate('rt-rotowany-dawno', 'para', NOW);
    repo.insertToken('rt-rotowany-teraz', { connectionId, kind: 'refresh', expiresAt: null, createdAt: NOW.toISOString() });

    const later = at(2 * MIN);
    repo.rotate('rt-rotowany-teraz', 'para-swieza', at(2 * MIN - 30_000));
    expect(repo.prune(later)).toEqual({ codes: 1, tokens: 1, clients: 0 });
    expect(repo.getToken('rt-rotowany-dawno')).toMatchObject({ gracePairEnc: null, rotatedAt: NOW.toISOString() });
    expect(repo.getToken('rt-rotowany-teraz')!.gracePairEnc).toBe('para-swieza');
    expect(repo.getToken('at-wazny')).toBeDefined();
    expect(repo.takeCode('kod-wazny', later)).toBeDefined();

    expect(repo.prune(at(30 * DAY + MIN)).tokens).toBe(2);
    expect(repo.getToken('rt-rotowany-dawno')).toBeUndefined();
    expect(repo.getToken('at-wazny')).toBeUndefined();
    expect(repo.getToken('rt-rotowany-teraz')).toBeDefined();
  });
});
