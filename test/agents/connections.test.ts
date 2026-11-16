import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateSecret } from '../../src/agents/codes.ts';
import { CODE_VALIDITY, CONNECTION_VALIDITY, connectionState, effectiveExpiry } from '../../src/agents/connections.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { AgentConnectionsRepo } from '../../src/store/agent-connections.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { OAuthRepo } from '../../src/store/oauth.ts';
import { AGENT_SEED_AT, seedAgent } from '../helpers/agent.ts';

const NOW = AGENT_SEED_AT;
const MIN = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
let db: Database;
let key: Buffer;

beforeEach(() => {
  db = openDatabase(':memory:');
  key = randomBytes(32);
});

const repos = () => ({
  connections: new AgentConnectionsRepo(db), oauth: new OAuthRepo(db), integrations: new IntegrationsRepo(db, key),
  apiKeys: new ApiKeysRepo(db, key), accounts: new AccountsRepo(db, key),
});

const connectClient = (connectionId: number, when: Date) => {
  const { oauth, connections } = repos();
  oauth.upsertClient({ clientId: 'cli_claude', kind: 'dynamic', name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], sourceIp: null, createdAt: NOW.toISOString(), fetchedAt: null });
  connections.useCode(connectionId, { clientId: 'cli_claude', clientName: 'Claude' }, when);
};

describe('wartości ważności', () => {
  it('kod 15 min, 1 h, 24 h, 3 dni, 7 dni; połączenie 30 dni, 90 dni, rok albo bez terminu', () => {
    expect(CODE_VALIDITY).toEqual({ '15m': 15 * MIN, '1h': 60 * MIN, '24h': DAY, '3d': 3 * DAY, '7d': 7 * DAY });
    expect(CONNECTION_VALIDITY).toEqual({ '30d': 30, '90d': 90, '365d': 365, none: null });
  });
});

describe('ConnectionService.create', () => {
  it('połączenie z logowaniem dostaje kod z terminem, a z kluczem w nagłówku token mig_mcp_ bez terminu', () => {
    const { service, integrationId } = seedAgent(db, key, { method: 'oauth' });
    const oauthConn = service.create(integrationId, { name: 'Marek Kowalski', method: 'oauth', codeValidity: '1h', validity: '30d' }, 'admin', NOW);
    expect(oauthConn.secret).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(oauthConn.secretExpiresAt).toBe(at(60 * MIN).toISOString());
    const tokenConn = service.create(integrationId, { name: 'Copilot Studio', method: 'token', codeValidity: '24h', validity: 'none' }, 'admin', NOW);
    expect(tokenConn.secret).toMatch(/^mig_mcp_/);
    expect(tokenConn.secretExpiresAt).toBeNull();
    const { connections } = repos();
    expect(connections.get(oauthConn.id)!.expiresAt).toBe(at(30 * DAY).toISOString());
    expect(connections.get(tokenConn.id)!.expiresAt).toBeNull();
    expect(connections.get(tokenConn.id)!.createdBy).toBe('admin');
  });

  it('create w integracji innego rodzaju rzuca błąd', () => {
    const { service, keyId } = seedAgent(db, key);
    const webhookId = repos().integrations.insert({
      name: 'Uptime Kuma', kind: 'webhook_in', apiKeyId: keyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
      config: { condition: { mode: 'builder', rules: [] }, throttle: { limit: 10, windowMinutes: 10 }, eventLogLimit: 200, auth: { sources: [] }, to: { fallback: [] }, text: { mode: 'liquid', template: '' }, maxParts: 1, overflow: 'truncate', invalidRecipient: 'error' },
      secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    expect(() => service.create(webhookId, { name: 'Ewa', method: 'token', codeValidity: '24h', validity: '90d' }, 'admin', NOW)).toThrow();
  });
});

describe('stan i ważność połączenia', () => {
  it('stan: czeka na kod, kod wygasł, aktywne po użyciu, wygasłe, odwołane', () => {
    const { service, integrationId } = seedAgent(db, key, { method: 'oauth' });
    const { id } = service.create(integrationId, { name: 'Marek Kowalski', method: 'oauth', codeValidity: '1h', validity: '30d' }, 'admin', NOW);
    const row = () => repos().connections.get(id)!;
    expect(connectionState(row(), null, at(10 * MIN))).toBe('waiting');
    expect(connectionState(row(), null, at(2 * 60 * MIN))).toBe('code_expired');
    connectClient(id, at(10 * MIN));
    expect(connectionState(row(), null, at(2 * 60 * MIN))).toBe('active');
    expect(connectionState(row(), null, at(31 * DAY))).toBe('expired');
    service.revoke(id, at(DAY));
    expect(connectionState(row(), null, at(2 * DAY))).toBe('revoked');
  });

  it('połączenie z tokenem jest aktywne od utworzenia', () => {
    const { connectionId } = seedAgent(db, key);
    expect(connectionState(repos().connections.get(connectionId)!, null, at(MIN))).toBe('active');
  });

  it('effectiveExpiry: połączenie bez terminu na kluczu do 2026-12-31 kończy się 2026-12-31', () => {
    const keyEnd = '2026-12-31T22:59:59.999Z';
    expect(effectiveExpiry({ expiresAt: null }, keyEnd)).toBe(keyEnd);
    expect(effectiveExpiry({ expiresAt: '2026-12-01T08:00:00.000Z' }, keyEnd)).toBe('2026-12-01T08:00:00.000Z');
    expect(effectiveExpiry({ expiresAt: '2027-02-13T08:00:00.000Z' }, keyEnd)).toBe(keyEnd);
    expect(effectiveExpiry({ expiresAt: null }, null)).toBeNull();
  });

  it('skrócenie ważności klucza skraca połączenie przy następnym resolve', () => {
    const { service, connectionId, keyId } = seedAgent(db, key);
    expect(service.resolve(connectionId, at(DAY)).ok).toBe(true);
    db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(at(2 * DAY).toISOString(), keyId);
    const resolved = service.resolve(connectionId, at(3 * DAY));
    expect(resolved).toEqual({ ok: false, reason: expect.stringMatching(/^klucz API wygasł/) });
    expect(connectionState(repos().connections.get(connectionId)!, at(2 * DAY).toISOString(), at(3 * DAY))).toBe('expired');
  });
});

describe('ConnectionService.resolve', () => {
  it('resolve daje kontekst z kluczem, kontem, uprawnieniami klucza i zakresami integracji', () => {
    const { service, connectionId, keyId, accountId, integrationId } = seedAgent(db, key, { scopes: ['reply', 'send'] });
    const resolved = service.resolve(connectionId, at(MIN));
    if (!resolved.ok) throw new Error(resolved.reason);
    expect([resolved.ctx.connection.id, resolved.ctx.integration.id, resolved.ctx.key.id, resolved.ctx.account.id]).toEqual([connectionId, integrationId, keyId, accountId]);
    expect(resolved.ctx.auth).toMatchObject({ apiKeyId: keyId, accountId, allowedServiceIds: ['24138'], ratePerMin: 60 });
    expect([...resolved.ctx.scopes].sort()).toEqual(['read_inbound', 'reply', 'send']);
  });

  it('resolve: wyłączona integracja daje powód, ponowne włączenie przywraca bez nowego kodu', () => {
    const { service, connectionId, integrationId } = seedAgent(db, key);
    const { integrations } = repos();
    integrations.setEnabled(integrationId, false, at(MIN));
    expect(service.resolve(connectionId, at(2 * MIN))).toEqual({ ok: false, reason: 'integracja jest wyłączona' });
    integrations.setEnabled(integrationId, true, at(3 * MIN));
    expect(service.resolve(connectionId, at(4 * MIN)).ok).toBe(true);
  });

  it('resolve: klucz odwołany, klucz wygasły, konto wstrzymane', () => {
    const first = seedAgent(db, key);
    repos().apiKeys.revoke(first.keyId);
    expect(first.service.resolve(first.connectionId, at(MIN))).toEqual({ ok: false, reason: 'klucz API został odwołany' });

    db = openDatabase(':memory:');
    const second = seedAgent(db, key, { keyExpiresAt: at(DAY).toISOString() });
    expect(second.service.resolve(second.connectionId, at(2 * DAY))).toEqual({ ok: false, reason: expect.stringMatching(/^klucz API wygasł/) });

    db = openDatabase(':memory:');
    const third = seedAgent(db, key);
    repos().accounts.pause(third.accountId, 'certyfikat wygasł');
    expect(third.service.resolve(third.connectionId, at(MIN))).toEqual({ ok: false, reason: 'konto wstrzymane: certyfikat wygasł' });
  });

  it('resolve: odwołane połączenie, połączenie po terminie i nieznane połączenie dają powód', () => {
    const { service, connectionId, integrationId } = seedAgent(db, key);
    const short = service.create(integrationId, { name: 'Marek Kowalski', method: 'token', codeValidity: '24h', validity: '30d' }, 'admin', NOW);
    service.revoke(connectionId, at(MIN));
    expect(service.resolve(connectionId, at(2 * MIN))).toEqual({ ok: false, reason: 'połączenie zostało odwołane' });
    expect(service.resolve(short.id, at(31 * DAY))).toEqual({ ok: false, reason: 'ważność połączenia minęła' });
    expect(service.resolve(9999, at(MIN))).toEqual({ ok: false, reason: 'połączenie nie istnieje' });
  });
});

describe('ConnectionService.authenticate', () => {
  it('authenticate: mig_live_ daje api_key, nieznany token invalid, token połączenia ok', () => {
    const { service, connectionId, secret } = seedAgent(db, key);
    expect(service.authenticate(`Bearer ${secret}`, at(MIN))).toEqual({ ok: true, connectionId });
    expect(service.authenticate(secret, at(MIN))).toEqual({ ok: true, connectionId });
    expect(service.authenticate('Bearer mig_live_abcdefgh12345678', at(MIN))).toEqual({ ok: false, code: 'api_key' });
    expect(service.authenticate(`Bearer ${generateSecret('mig_mcp_').value}`, at(MIN))).toEqual({ ok: false, code: 'invalid' });
    expect(service.authenticate('Bearer cokolwiek', at(MIN))).toEqual({ ok: false, code: 'invalid' });
    expect(service.authenticate(undefined, at(MIN))).toEqual({ ok: false, code: 'missing' });
    expect(service.authenticate('  ', at(MIN))).toEqual({ ok: false, code: 'missing' });
  });

  it('token dostępu OAuth w terminie działa, po terminie i token odświeżania nie', () => {
    const { service, connectionId } = seedAgent(db, key, { method: 'oauth' });
    connectClient(connectionId, at(MIN));
    const { oauth } = repos();
    const access = generateSecret('mig_at_');
    const refresh = generateSecret('mig_rt_');
    oauth.insertToken(access.hash, { connectionId, kind: 'access', expiresAt: at(61 * MIN).toISOString(), createdAt: at(MIN).toISOString() });
    oauth.insertToken(refresh.hash, { connectionId, kind: 'refresh', expiresAt: null, createdAt: at(MIN).toISOString() });
    expect(service.authenticate(`Bearer ${access.value}`, at(30 * MIN))).toEqual({ ok: true, connectionId });
    expect(service.authenticate(`Bearer ${access.value}`, at(61 * MIN))).toEqual({ ok: false, code: 'invalid' });
    expect(service.authenticate(`Bearer ${refresh.value}`, at(30 * MIN))).toEqual({ ok: false, code: 'invalid' });
  });

  it('token odwołanego albo wygasłego połączenia jest nieważny', () => {
    const { service, connectionId, secret, integrationId } = seedAgent(db, key);
    const short = service.create(integrationId, { name: 'Marek Kowalski', method: 'token', codeValidity: '24h', validity: '30d' }, 'admin', NOW);
    expect(service.authenticate(`Bearer ${short.secret}`, at(31 * DAY))).toEqual({ ok: false, code: 'invalid' });
    service.revoke(connectionId, at(MIN));
    expect(service.authenticate(`Bearer ${secret}`, at(2 * MIN))).toEqual({ ok: false, code: 'invalid' });
  });
});

describe('ConnectionService: nowy kod, nowy token, usunięcie', () => {
  it('newToken unieważnia poprzedni token', () => {
    const { service, connectionId, secret } = seedAgent(db, key);
    const { token } = service.newToken(connectionId);
    expect(token).toMatch(/^mig_mcp_/);
    expect(service.authenticate(`Bearer ${secret}`, at(MIN))).toEqual({ ok: false, code: 'invalid' });
    expect(service.authenticate(`Bearer ${token}`, at(MIN))).toEqual({ ok: true, connectionId });
  });

  it('newToken dla połączenia z logowaniem i newCode dla połączenia z tokenem rzucają błąd', () => {
    const { service, connectionId, integrationId } = seedAgent(db, key);
    const oauthConn = service.create(integrationId, { name: 'Marek Kowalski', method: 'oauth', codeValidity: '24h', validity: '90d' }, 'admin', NOW);
    expect(() => service.newToken(oauthConn.id)).toThrow();
    expect(() => service.newCode(connectionId, '24h', NOW)).toThrow();
  });

  it('newCode dla aktywnego połączenia: stan zostaje aktywny, a dotychczasowe tokeny działają do użycia nowego kodu', () => {
    const { service, connectionId, integrationId } = seedAgent(db, key, { method: 'oauth' });
    connectClient(connectionId, at(MIN));
    const access = generateSecret('mig_at_');
    repos().oauth.insertToken(access.hash, { connectionId, kind: 'access', expiresAt: at(61 * MIN).toISOString(), createdAt: at(MIN).toISOString() });
    const fresh = service.newCode(connectionId, '1h', at(2 * MIN));
    expect(fresh).toEqual({ code: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/), expiresAt: at(62 * MIN).toISOString() });
    expect(connectionState(repos().connections.get(connectionId)!, null, at(3 * MIN))).toBe('active');
    expect(repos().connections.countActive(integrationId, null, at(3 * MIN))).toBe(1);
    expect(service.authenticate(`Bearer ${access.value}`, at(3 * MIN))).toEqual({ ok: true, connectionId });
  });

  it('newCode dla odwołanego połączenia rzuca błąd', () => {
    const { service, connectionId } = seedAgent(db, key, { method: 'oauth' });
    service.revoke(connectionId, at(MIN));
    expect(() => service.newCode(connectionId, '24h', at(2 * MIN))).toThrow();
  });

  it('remove aktywnego połączenia rzuca błąd', () => {
    const { service, connectionId } = seedAgent(db, key);
    expect(() => service.remove(connectionId)).toThrow();
    expect(repos().connections.get(connectionId)).toBeDefined();
  });

  it('remove połączenia czekającego na kod usuwa je', () => {
    const { service, connectionId } = seedAgent(db, key, { method: 'oauth' });
    service.remove(connectionId);
    expect(repos().connections.get(connectionId)).toBeUndefined();
  });

});
