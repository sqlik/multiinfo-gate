import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { AgentConnectionsRepo } from '../../src/store/agent-connections.ts';
import { DownloadLinksRepo } from '../../src/store/download-links.ts';
import { seedAgentIntegration } from './helpers.ts';

const NOW = new Date('2026-11-15T08:00:00Z');
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
let links: DownloadLinksRepo;
let apiKeyId: number;
let connectionId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const seeded = seedAgentIntegration(db, randomBytes(32));
  apiKeyId = seeded.apiKeyId;
  connectionId = new AgentConnectionsRepo(db).insert({
    integrationId: seeded.integrationId, name: 'Ewa Nowak', method: 'oauth', expiresAt: null, createdBy: 'admin', createdAt: NOW,
  });
  links = new DownloadLinksRepo(db);
});

describe('DownloadLinksRepo', () => {
  it('get zwraca klucz, rodzaj i odwołanie w terminie ważności', () => {
    links.insert('skrot-1', { apiKeyId, connectionId, kind: 'package_failed', ref: 'pkg_1', createdAt: NOW, expiresAt: later(60) });
    expect(links.get('skrot-1', later(59))).toEqual({ apiKeyId, connectionId, kind: 'package_failed', ref: 'pkg_1' });
    expect(links.get('nieznany', NOW)).toBeUndefined();
  });

  it('get linku do pobrania po terminie zwraca undefined', () => {
    links.insert('skrot-1', { apiKeyId, connectionId, kind: 'campaign_unopened', ref: 'przeglad-klimatyzacji-wiosna', createdAt: NOW, expiresAt: later(60) });
    expect(links.get('skrot-1', later(60))).toBeUndefined();
  });

  it('pruneBefore usuwa linki po terminie', () => {
    links.insert('stary', { apiKeyId, connectionId, kind: 'package_report', ref: 'pkg_1', createdAt: NOW, expiresAt: later(60) });
    links.insert('nowy', { apiKeyId, connectionId, kind: 'campaign_opened', ref: 'przeglad-klimatyzacji-wiosna', createdAt: later(30), expiresAt: later(90) });
    expect(links.pruneBefore(later(61))).toBe(1);
    expect(links.get('nowy', later(61))).toBeDefined();
  });
});
