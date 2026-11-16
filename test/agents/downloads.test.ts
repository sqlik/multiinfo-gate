import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDownload, DOWNLOAD_TTL_MS, failedCsv, unopenedCsv } from '../../src/agents/downloads.ts';
import { reportCsv } from '../../src/api/packages.ts';
import { buildApiServer, type AgentServerDeps, type ApiDeps } from '../../src/api/server.ts';
import { AgentError } from '../../src/integrations/agent.ts';
import { openersCsv } from '../../src/links/campaigns.ts';
import type { ReportRow } from '../../src/multiinfo/report.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AGENT_SEED_AT, agentApiDeps, seedAgent } from '../helpers/agent.ts';

const BASE = 'https://bramka.serwis.example';
const NOW = new Date(AGENT_SEED_AT.getTime() + 3_600_000);

let db: Database;
let seed: ReturnType<typeof seedAgent>;
let deps: ApiDeps & { agents: AgentServerDeps };
let clock: Date;
let info: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = openDatabase(':memory:');
  const key = randomBytes(32);
  seed = seedAgent(db, key, { scopes: ['read_sent', 'campaigns'] });
  clock = NOW;
  info = vi.fn();
  deps = agentApiDeps(db, key, { now: () => clock, log: { error: vi.fn(), warn: vi.fn(), info, debug: vi.fn() } });
});

const report = (dest: string, miStatus: number, status: ReportRow['status'], miId: string): ReportRow => ({
  miId, dest, miStatus, status, rawStatus: String(miStatus), changedAt: '2026-11-15 08:30:00', clientId: null,
});

function pkg(): string {
  deps.packages.insert({
    id: 'pkg_1', apiKeyId: seed.keyId, accountId: seed.accountId, serviceId: '24138', defaultText: 'Przypomnienie o przeglądzie.', orig: null,
    costCenter: null, startAt: null, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: AGENT_SEED_AT.toISOString(),
  }, [
    { dest: '48601000011', text: null, clientId: 'K-17' },
    { dest: '48601000012', text: null, clientId: null },
    { dest: '48601000013', text: null, clientId: null },
  ]);
  deps.packages.setCompleted('pkg_1', AGENT_SEED_AT);
  deps.packages.applyReport('pkg_1', [
    report('48601000011', 21, 'delivered', '1'), report('48601000012', 11, 'failed', '2'), report('48601000013', 12, 'expired', '3'),
  ]);
  deps.packages.setReport('pkg_1', { status: 'ready' });
  return 'pkg_1';
}

function campaign(): number {
  const at = AGENT_SEED_AT;
  const domainId = deps.linkDomains.create({ domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, at);
  const id = deps.campaigns.open(seed.keyId, 'Przegląd klimatyzacji - wiosna', at);
  const link = (code: string, dest: string, key: string, target: string): void => deps.shortLinks.insert({
    code, domainId, apiKeyId: seed.keyId, campaignId: id, target, utm: 0, recipientKey: key, messageId: key, packageId: null, seq: null,
    dest, clientId: key === 'msg_b' ? 'K-21' : null, expiresAt: '2026-12-31T23:00:00.000Z', purgeAfter: '2027-01-30T23:00:00.000Z', createdAt: at.toISOString(),
  });
  link('aB3xK9q', '48601000011', 'msg_a', 'https://firma.pl/przeglad');
  link('cD4yL0s', '48601000012', 'msg_b', 'https://firma.pl/przeglad');
  link('cD4yL0t', '48601000012', 'msg_b', 'https://firma.pl/cennik');
  link('eF5zM1t', '48601000013', 'msg_c', 'https://firma.pl/przeglad');
  deps.shortLinks.click('aB3xK9q', new Date('2026-11-15T08:10:00Z'), false);
  deps.shortLinks.click('eF5zM1t', new Date('2026-11-15T08:12:00Z'), true);
  return id;
}

async function get(url: string) {
  const app = buildApiServer(deps);
  return app.inject({ method: 'GET', url: url.replace(BASE, '') });
}

describe('linki do pobrania', () => {
  it('link pobiera raport rozsyłki w formacie z API', async () => {
    pkg();
    const link = createDownload(deps.agents, BASE, { apiKeyId: seed.keyId, connectionId: seed.connectionId }, 'package_report', 'pkg_1', NOW);
    expect(link.url).toMatch(/^https:\/\/bramka\.serwis\.example\/pobierz\/[A-Za-z0-9_-]{43}$/);
    expect(link.expiresAt).toBe(new Date(NOW.getTime() + DOWNLOAD_TTL_MS).toISOString());
    const res = await get(link.url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="raport-pkg_1.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toBe(reportCsv(deps.packages.recipients('pkg_1')));
  });

  it('link po godzinie i 1 s: 404', async () => {
    pkg();
    const link = createDownload(deps.agents, BASE, { apiKeyId: seed.keyId, connectionId: seed.connectionId }, 'package_report', 'pkg_1', NOW);
    clock = new Date(NOW.getTime() + DOWNLOAD_TTL_MS + 1000);
    const res = await get(link.url);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('<h1>Link wygasł</h1>');
    expect(res.body).not.toContain('48601000011');
    expect((await get(`${BASE}/pobierz/nieznany`)).statusCode).toBe(404);
  });

  it('niedoręczeni: tylko odbiorcy bez doręczenia', async () => {
    pkg();
    const rows = deps.packages.recipients('pkg_1');
    expect(failedCsv(rows)).toBe(reportCsv(rows.filter((r) => r.status !== 'delivered')));
    const res = await get(createDownload(deps.agents, BASE, { apiKeyId: seed.keyId, connectionId: seed.connectionId }, 'package_failed', 'pkg_1', NOW).url);
    expect(res.headers['content-disposition']).toBe('attachment; filename="niedoreczeni-pkg_1.csv"');
    expect(res.body.split('\r\n')).toEqual([
      'numer;identyfikator_klienta;id_multiinfo;status;status_multiinfo;czas',
      '48601000012;;2;failed;11;2026-11-15 08:30:00',
      '48601000013;;3;expired;12;2026-11-15 08:30:00',
      '',
    ]);
  });

  it('kampania bez otwarcia: odbiorcy bez first_opened_at', async () => {
    const id = campaign();
    expect(unopenedCsv(deps, id).split('\r\n')).toEqual([
      'numer;identyfikator_klienta;klikniecia;linki',
      '48601000012;K-21;0;https://firma.pl/cennik https://firma.pl/przeglad',
      '48601000013;;0;https://firma.pl/przeglad',
      '',
    ]);
    const unopened = await get(createDownload(deps.agents, BASE, { apiKeyId: seed.keyId, connectionId: seed.connectionId }, 'campaign_unopened', String(id), NOW).url);
    expect(unopened.headers['content-disposition']).toBe('attachment; filename="kampania-przeglad-klimatyzacji-wiosna-bez-otwarcia.csv"');
    expect(unopened.body).toBe(unopenedCsv(deps, id));
    const opened = await get(createDownload(deps.agents, BASE, { apiKeyId: seed.keyId, connectionId: seed.connectionId }, 'campaign_opened', String(id), NOW).url);
    expect(opened.headers['content-disposition']).toBe('attachment; filename="kampania-przeglad-klimatyzacji-wiosna-z-otwarciem.csv"');
    expect(opened.body).toBe(openersCsv(deps, id));
  });

  it('plik innego klucza nie jest dostępny przez link', async () => {
    pkg();
    const other = deps.apiKeys.insert({
      accountId: seed.accountId, name: 'inny', keyHash: 'h2', keyPrefix: 'p2', defaultServiceId: '24138', defaultOrig: null,
      maxParts: 9, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
    });
    const res = await get(createDownload(deps.agents, BASE, { apiKeyId: other, connectionId: seed.connectionId }, 'package_report', 'pkg_1', NOW).url);
    expect(res.statusCode).toBe(404);
  });

  it('log zawiera tylko przedrostek tokenu', async () => {
    pkg();
    const link = createDownload(deps.agents, BASE, { apiKeyId: seed.keyId, connectionId: seed.connectionId }, 'package_report', 'pkg_1', NOW);
    const token = link.url.split('/').pop()!;
    await get(link.url);
    expect(info).toHaveBeenCalledWith('pobranie', { token: `${token.slice(0, 12)}…`, kind: 'package_report', apiKeyId: seed.keyId });
    expect(JSON.stringify(info.mock.calls)).not.toContain(token);
  });

  it('bez adresu bramki createDownload rzuca błąd z komunikatem', () => {
    let error: unknown;
    try {
      createDownload(deps.agents, null, { apiKeyId: seed.keyId, connectionId: seed.connectionId }, 'package_report', 'pkg_1', NOW);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).message).toBe('Adres bramki nie jest ustawiony, dlatego bramka nie może utworzyć linku do pobrania.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM download_links').get()).toEqual({ n: 0 });
  });
});
