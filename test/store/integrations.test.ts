import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { IntegrationsRepo, newHookId } from '../../src/store/integrations.ts';
import { defaultInboundConfig, defaultOutboundConfig, defaultSmsGroupConfig } from '../../src/integrations/config.ts';
import { accountInput } from './helpers.ts';

const NOW = new Date('2026-09-02T10:00:00Z');
let repo: IntegrationsRepo;
let apiKeyId: number;
let accountId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  accountId = new AccountsRepo(db, key).insert(accountInput());
  apiKeyId = new ApiKeysRepo(db, key).insert({
    accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  repo = new IntegrationsRepo(db, key);
});

const inbound = (over: Record<string, unknown> = {}) => repo.insert({
  name: 'Uptime Kuma', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'uptime-kuma', enabled: 1,
  config: defaultInboundConfig(), secrets: { token: 'tajny' }, storePayloads: 0, createdAt: NOW, ...over,
});

describe('IntegrationsRepo', () => {
  it('copy tworzy wyłączoną kopię z tą samą konfiguracją i sekretami oraz nowym adresem wejściowym', () => {
    const id = inbound({ secrets: { token: 't' } });
    const copyId = repo.copy(id, 'Kuma (kopia)', new Date(NOW.getTime() + 1000));
    const a = repo.get(id)!;
    const b = repo.get(copyId)!;
    expect([b.name, b.enabled, b.kind, b.preset, b.apiKeyId, b.storePayloads]).toEqual(['Kuma (kopia)', 0, a.kind, a.preset, a.apiKeyId, a.storePayloads]);
    expect(b.config).toEqual(a.config);
    expect(repo.secrets(copyId)).toEqual({ token: 't' });
    expect(b.hookId).not.toBe(a.hookId);
    expect(b.hookId).toHaveLength(32);
    expect(b.createdAt).toBe(new Date(NOW.getTime() + 1000).toISOString());
    const out = repo.insert({
      name: 'Slack', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'slack', enabled: 1,
      config: { ...defaultOutboundConfig(), url: 'https://hooks.slack.com/x' }, secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    expect(repo.get(repo.copy(out, 'Slack (kopia)', NOW))?.hookId).toBeNull();
  });

  it('przychodząca dostaje adres wejściowy, wychodząca nie', () => {
    const id = inbound();
    const row = repo.get(id)!;
    expect(row.hookId).toHaveLength(32);
    expect(repo.getByHookId(row.hookId!)?.id).toBe(id);
    const out = repo.insert({
      name: 'Slack', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'slack', enabled: 1,
      config: { ...defaultOutboundConfig(), url: 'https://hooks.slack.com/x' }, secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    expect(repo.get(out)!.hookId).toBeNull();
  });
  it('sekrety są szyfrowane i nie ma ich w wierszu', () => {
    const id = inbound();
    expect(JSON.stringify(repo.get(id))).not.toContain('tajny');
    expect(repo.secrets(id)).toEqual({ token: 'tajny' });
    expect(repo.secretNames(id)).toEqual(['token']);
  });
  it('update: sekrety pominięte zostają, pusta wartość usuwa jeden', () => {
    const id = inbound();
    repo.update(id, { name: 'Kuma', serviceId: null, orig: null, preset: 'uptime-kuma', enabled: 1, config: defaultInboundConfig(), storePayloads: 1 }, NOW);
    expect(repo.secrets(id)).toEqual({ token: 'tajny' });
    expect(repo.get(id)!.storePayloads).toBe(1);
    repo.update(id, { name: 'Kuma', serviceId: null, orig: null, preset: 'uptime-kuma', enabled: 1, config: defaultInboundConfig(), storePayloads: 1, secrets: { token: '', basic: 'x' } }, NOW);
    expect(repo.secrets(id)).toEqual({ basic: 'x' });
  });
  it('regenerateHook unieważnia stary adres', () => {
    const id = inbound();
    const old = repo.get(id)!.hookId!;
    const fresh = repo.regenerateHook(id, NOW);
    expect(fresh).not.toBe(old);
    expect(repo.getByHookId(old)).toBeUndefined();
    expect(repo.getByHookId(fresh)?.id).toBe(id);
  });
  it('nazwa unikalna w obrębie klucza', () => {
    inbound();
    expect(() => inbound()).toThrow();
  });
  it('listOutboundFor zwraca tylko włączone z danym zdarzeniem', () => {
    const out = repo.insert({
      name: 'HA', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
      config: { ...defaultOutboundConfig(), url: 'https://ha.example/api/webhook/x', events: ['message.received'] }, secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    expect(repo.listOutboundFor(apiKeyId, 'message.received').map((r) => r.id)).toEqual([out]);
    expect(repo.listOutboundFor(apiKeyId, 'message.delivered')).toEqual([]);
    repo.setEnabled(out, false, NOW);
    expect(repo.listOutboundFor(apiKeyId, 'message.received')).toEqual([]);
  });
  it('inboundListenerKeyIds: klucz z wychodzącą na message.received zapala odbiór usługi', () => {
    expect(repo.inboundListenerKeyIds(accountId, '24138', NOW)).toEqual([]);
    repo.insert({
      name: 'HA', kind: 'webhook_out', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1,
      config: { ...defaultOutboundConfig(), url: 'https://ha.example/x' }, secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    expect(repo.inboundListenerKeyIds(accountId, '24138', NOW)).toEqual([apiKeyId]);
    expect(repo.inboundListenerKeyIds(accountId, '99999', NOW)).toEqual([]);
  });
  it('listOutboundFor zwraca włączoną grupę dla message.received, a nie dla statusów', () => {
    const g = repo.insert({ name: 'Grupa', kind: 'sms_group', apiKeyId, serviceId: null, orig: null, preset: 'sms-grupa', enabled: 1, config: defaultSmsGroupConfig(), secrets: {}, storePayloads: 0, createdAt: NOW });
    expect(repo.listOutboundFor(apiKeyId, 'message.received').map((r) => r.id)).toContain(g);
    expect(repo.listOutboundFor(apiKeyId, 'message.delivered').map((r) => r.id)).not.toContain(g);
    expect(repo.listOutboundFor(apiKeyId, 'message.sent').map((r) => r.id)).not.toContain(g);
    repo.setEnabled(g, false, NOW);
    expect(repo.listOutboundFor(apiKeyId, 'message.received').map((r) => r.id)).not.toContain(g);
  });
  it('inboundListenerKeyIds: klucz z włączoną grupą zapala odbiór usługi, wyłączona nie', () => {
    const g = repo.insert({ name: 'Grupa', kind: 'sms_group', apiKeyId, serviceId: null, orig: null, preset: 'sms-grupa', enabled: 1, config: defaultSmsGroupConfig(), secrets: {}, storePayloads: 0, createdAt: NOW });
    expect(repo.inboundListenerKeyIds(accountId, '24138', NOW)).toEqual([apiKeyId]);
    expect(repo.inboundListenerKeyIds(accountId, '99999', NOW)).toEqual([]);
    repo.setEnabled(g, false, NOW);
    expect(repo.inboundListenerKeyIds(accountId, '24138', NOW)).toEqual([]);
  });
  it('remove kasuje integrację; listForKey i list widzą resztę', () => {
    const a = inbound();
    const b = inbound({ name: 'Druga' });
    repo.remove(a);
    expect(repo.listForKey(apiKeyId).map((r) => r.id)).toEqual([b]);
    expect(repo.list().map((r) => r.id)).toEqual([b]);
  });
  it('newHookId ma 32 znaki base64url', () => {
    expect(newHookId()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
