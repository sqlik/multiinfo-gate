import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentConnectionsRepo } from '../../src/store/agent-connections.ts';
import { AgentDraftsRepo } from '../../src/store/agent-drafts.ts';
import { openDatabase } from '../../src/store/db.ts';
import { seedAgentIntegration } from './helpers.ts';

const NOW = new Date('2026-11-15T08:00:00Z');
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
let drafts: AgentDraftsRepo;
let ewa: number;
let marek: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const { integrationId } = seedAgentIntegration(db, randomBytes(32));
  const connections = new AgentConnectionsRepo(db);
  ewa = connections.insert({ integrationId, name: 'Ewa Nowak', method: 'oauth', expiresAt: null, createdBy: 'admin', createdAt: NOW });
  marek = connections.insert({ integrationId, name: 'Marek Kowalski', method: 'oauth', expiresAt: null, createdBy: 'admin', createdAt: NOW });
  drafts = new AgentDraftsRepo(db);
});

const payload = { to: ['48601000011', '48601000012'], text: 'Przypominamy o przeglądzie klimatyzacji w czwartek.' };

describe('AgentDraftsRepo', () => {
  it('insert zwraca identyfikator drf_, a get zwraca szkic z treścią i bez wyniku', () => {
    const id = drafts.insert({ connectionId: ewa, kind: 'sms', payload, createdAt: NOW, expiresAt: later(30) });
    expect(id).toMatch(/^drf_[0-9a-f]{20}$/);
    expect(drafts.get(id, ewa)).toEqual({
      id, connectionId: ewa, kind: 'sms', payload, createdAt: NOW.toISOString(), expiresAt: later(30).toISOString(), sentAt: null, result: null,
    });
  });

  it('get szkicu innego połączenia zwraca undefined', () => {
    const id = drafts.insert({ connectionId: ewa, kind: 'sms', payload, createdAt: NOW, expiresAt: later(30) });
    expect(drafts.get(id, marek)).toBeUndefined();
    expect(drafts.get('drf_nieznany', ewa)).toBeUndefined();
  });

  it('get zwraca także szkic po terminie, żeby wysyłka mogła podać czytelny powód', () => {
    const id = drafts.insert({ connectionId: ewa, kind: 'reply', payload, createdAt: NOW, expiresAt: later(30) });
    expect(drafts.get(id, ewa)?.expiresAt).toBe(later(30).toISOString());
  });

  it('markSent zapisuje wynik i chwilę wysyłki', () => {
    const id = drafts.insert({ connectionId: ewa, kind: 'group', payload, createdAt: NOW, expiresAt: later(30) });
    drafts.markSent(id, { kind: 'messages', ids: ['msg_1', 'msg_2'] }, later(2));
    expect(drafts.get(id, ewa)).toMatchObject({ sentAt: later(2).toISOString(), result: { kind: 'messages', ids: ['msg_1', 'msg_2'] } });
  });

  it('pruneBefore usuwa szkice, których termin minął', () => {
    const old = drafts.insert({ connectionId: ewa, kind: 'sms', payload, createdAt: NOW, expiresAt: later(30) });
    const fresh = drafts.insert({ connectionId: ewa, kind: 'sms', payload, createdAt: later(20), expiresAt: later(50) });
    expect(drafts.pruneBefore(later(31))).toBe(1);
    expect(drafts.get(old, ewa)).toBeUndefined();
    expect(drafts.get(fresh, ewa)).toBeDefined();
  });
});
