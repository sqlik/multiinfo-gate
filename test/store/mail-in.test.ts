import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { MailInRepo } from '../../src/store/mail-in.ts';
import { defaultInboundConfig, defaultMailInConfig } from '../../src/integrations/config.ts';
import { accountInput } from './helpers.ts';

const NOW = new Date('2026-10-21T10:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
let repo: MailInRepo;
let integrations: IntegrationsRepo;
let id: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const apiKeyId = new ApiKeysRepo(db, key).insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
  integrations = new IntegrationsRepo(db, key);
  // Rodzaj mail_in wchodzi w zadaniu 2; repozytorium stanu nie sprawdza rodzaju poza `due` i `counts`.
  id = integrations.insert({ name: 'x', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'custom', enabled: 1, config: defaultInboundConfig(), secrets: {}, storePayloads: 0, createdAt: NOW });
  repo = new MailInRepo(db);
});

describe('MailInRepo: stan skrzynki', () => {
  it('ensureState zakłada wiersz z odpytaniem na teraz, drugi raz nic nie zmienia', () => {
    repo.ensureState(id, NOW);
    repo.ensureState(id, later(60_000));
    expect(repo.state(id)?.nextPollAt).toBe(NOW.toISOString());
    expect(repo.state(id)?.uidFloor).toBe(0);
  });

  it('ensureAll zakłada stan każdej integracji mail_in bez stanu, nie rusza istniejących', () => {
    expect(repo.ensureAll(NOW)).toBe(0);
    const mail = integrations.insert({ name: 'm', kind: 'mail_in', apiKeyId: integrations.get(id)!.apiKeyId, serviceId: null, orig: null, preset: 'poczta-wlasny', enabled: 1, config: defaultMailInConfig(), secrets: {}, storePayloads: 0, createdAt: NOW });
    expect(repo.ensureAll(NOW)).toBe(1);
    repo.setFloor(mail, 5, 7);
    expect(repo.ensureAll(later(1000))).toBe(0);
    expect(repo.state(mail)).toMatchObject({ uidFloor: 5, nextPollAt: NOW.toISOString() });
    expect(repo.state(id)).toBeUndefined();
  });

  it('due zwraca tylko włączone integracje z terminem nie późniejszym niż teraz', () => {
    repo.ensureState(id, NOW);
    expect(repo.due(later(-1))).toEqual([]);
    expect(repo.due(NOW)).toEqual([id]);
    integrations.setEnabled(id, false, NOW);
    expect(repo.due(NOW)).toEqual([]);
  });

  it('recordPoll po sukcesie czyści błąd, po błędzie zlicza niepowodzenia i trzyma początek awarii', () => {
    repo.ensureState(id, NOW);
    repo.recordPoll(id, { ok: false, error: 'LOGIN failed', errorKind: 'auth', at: NOW, nextPollAt: later(300_000) });
    repo.recordPoll(id, { ok: false, error: 'LOGIN failed', errorKind: 'auth', at: later(300_000), nextPollAt: later(600_000) });
    let s = repo.state(id)!;
    expect(s.failures).toBe(2);
    expect(s.errorSince).toBe(NOW.toISOString());
    expect(s.lastOkAt).toBeNull();
    expect(s.lastPollAt).toBe(later(300_000).toISOString());
    repo.recordPoll(id, { ok: true, uidvalidity: 7, unseen: 3, at: later(900_000), nextPollAt: later(960_000) });
    s = repo.state(id)!;
    expect(s.failures).toBe(0);
    expect(s.error).toBeNull();
    expect(s.errorSince).toBeNull();
    expect(s.notifiedAt).toBeNull();
    expect(s.unseen).toBe(3);
    expect(s.uidvalidity).toBe(7);
    expect(s.lastOkAt).toBe(later(900_000).toISOString());
    expect(s.nextPollAt).toBe(later(960_000).toISOString());
  });

  it('setFloor, setBacklog, pollNow oraz markNotified zmieniają pojedyncze pola', () => {
    repo.ensureState(id, NOW);
    repo.setFloor(id, 41, 7);
    repo.setBacklog(id, 1);
    repo.markNotified(id, NOW);
    repo.pollNow(id, NOW);
    const s = repo.state(id)!;
    expect([s.uidFloor, s.uidvalidity, s.backlog, s.notifiedAt, s.nextPollAt]).toEqual([41, 7, 1, NOW.toISOString(), NOW.toISOString()]);
  });

  it('failing i counts liczą skrzynki w błędzie', () => {
    repo.ensureState(id, NOW);
    expect(repo.counts()).toEqual({ total: 1, failing: 0 });
    repo.recordPoll(id, { ok: false, error: 'x', errorKind: 'network', at: NOW, nextPollAt: NOW });
    expect(repo.failing().map((s) => s.integrationId)).toEqual([id]);
    expect(repo.counts()).toEqual({ total: 1, failing: 1 });
    integrations.setEnabled(id, false, NOW);
    expect(repo.failing()).toEqual([]);
    expect(repo.counts()).toEqual({ total: 0, failing: 0 });
  });

  it('usunięcie integracji kasuje jej stan i przetworzone maile', () => {
    repo.ensureState(id, NOW);
    repo.remember(id, { messageId: null, uidvalidity: 7, uid: 1 }, 'sent', NOW);
    integrations.remove(id);
    expect(repo.state(id)).toBeUndefined();
    expect(repo.pruneSeenBefore(later(1))).toBe(0);
  });
});

describe('MailInRepo: przetworzone maile', () => {
  it('seen rozpoznaje mail po Message-ID albo po parze UIDVALIDITY i UID', () => {
    repo.remember(id, { messageId: '<a@x>', uidvalidity: 7, uid: 10 }, 'sent', NOW);
    expect(repo.seen(id, { messageId: '<a@x>', uidvalidity: 8, uid: 1 })).toBe(true);
    expect(repo.seen(id, { messageId: null, uidvalidity: 7, uid: 10 })).toBe(true);
    expect(repo.seen(id, { messageId: '<b@x>', uidvalidity: 7, uid: 11 })).toBe(false);
  });

  it('setOutcome zmienia wynik zapamiętanego maila', () => {
    repo.remember(id, { messageId: '<a@x>', uidvalidity: 7, uid: 10 }, 'skipped', NOW);
    repo.setOutcome(id, { messageId: '<a@x>', uidvalidity: 7, uid: 10 }, 'sent');
    expect(repo.outcomes(id)).toEqual([{ uid: 10, outcome: 'sent' }]);
  });

  it('remember tego samego UID drugi raz nie rzuca, pruneSeenBefore kasuje stare', () => {
    repo.remember(id, { messageId: null, uidvalidity: 7, uid: 10 }, 'sent', NOW);
    repo.remember(id, { messageId: null, uidvalidity: 7, uid: 10 }, 'skipped', NOW);
    repo.remember(id, { messageId: null, uidvalidity: 7, uid: 11 }, 'sent', later(10));
    expect(repo.pruneSeenBefore(later(1))).toBe(1);
    expect(repo.seen(id, { messageId: null, uidvalidity: 7, uid: 11 })).toBe(true);
  });
});
