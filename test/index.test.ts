import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.ts';
import { problemUrl } from '../src/docs-links.ts';
import { startFromEnv, startGate } from '../src/index.ts';

let dir: string;
let running: Awaited<ReturnType<typeof startGate>> | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('startGate', () => {
  it('uruchamia odbiornik i zatrzymuje go razem z bramką', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mig-start-'));
    const config = loadEnv({
      MIG_MASTER_KEY: randomBytes(32).toString('base64'),
      MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LINKS_PORT: '0', MIG_LOG_LEVEL: 'silent', MIG_INBOUND_IDLE_MS: '1000',
    });
    running = await startGate(config);
    const health = await fetch(`http://127.0.0.1:${running.adminPort}/healthz`);
    expect((await health.json()).inbound).toEqual({ services: 0, listening: 0, errors: [] });
    await running.stop();
    running = null;
  });

  it('tworzy bazę, uruchamia oba serwery i odpowiada na /healthz', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mig-start-'));
    const config = loadEnv({
      MIG_MASTER_KEY: randomBytes(32).toString('base64'),
      MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LINKS_PORT: '0',
    });
    running = await startGate(config);
    expect(running).toBeTruthy();
    const health = await fetch(`http://127.0.0.1:${running.apiPort}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
  });

  it('panel nasłuchuje wyłącznie na pętli zwrotnej, API na wszystkich interfejsach', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mig-start-'));
    const config = loadEnv({
      MIG_MASTER_KEY: randomBytes(32).toString('base64'),
      MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LINKS_PORT: '0', MIG_LOG_LEVEL: 'silent',
    });
    running = await startGate(config);
    expect(running.adminHost).toBe('127.0.0.1');
    expect(running.apiHost).toBe('0.0.0.0');
  });

  it('odpowiada na /hooks/ na porcie API i zatrzymuje się bez wiszących zegarów', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mig-start-'));
    const config = loadEnv({
      MIG_MASTER_KEY: randomBytes(32).toString('base64'),
      MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LINKS_PORT: '0', MIG_LOG_LEVEL: 'silent', MIG_TRUSTED_PROXIES: '10.0.0.1',
    });
    running = await startGate(config);
    const res = await fetch(`http://127.0.0.1:${running.apiPort}/hooks/abc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ accepted: false, reason: 'unknown' });
    const started = Date.now();
    await running.stop();
    running = null;
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('Node bez poprawek z października 2026 daje ostrzeżenie w dzienniku przy starcie, Node z poprawkami nie', async () => {
    const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const log = { error() {}, info() {}, debug() {}, warn: (msg: string, fields?: Record<string, unknown>) => { warnings.push({ msg, ...(fields ? { fields } : {}) }); } };
    const start = async (nodeVersion: string) => {
      dir = mkdtempSync(join(tmpdir(), 'mig-start-'));
      const config = loadEnv({ MIG_MASTER_KEY: randomBytes(32).toString('base64'), MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LINKS_PORT: '0' });
      running = await startGate(config, { log, nodeVersion });
      await running.stop();
      running = null;
      rmSync(dir, { recursive: true, force: true });
    };
    await start('v22.23.3');
    expect(warnings.filter((w) => w.msg === 'node.bez_poprawek')).toEqual([
      { msg: 'node.bez_poprawek', fields: { installed: '22.23.3', minimum: '22.23.4', unsupportedLine: false, help: problemUrl('wersja-node') } },
    ]);
    warnings.length = 0;
    await start('v22.23.4');
    expect(warnings.filter((w) => w.msg === 'node.bez_poprawek')).toEqual([]);
  });

  it('uruchamia serwer przekierowań na trzecim porcie i zamyka go razem z bramką', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mig-start-'));
    const infos: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const log = { error() {}, warn() {}, debug() {}, info: (msg: string, fields?: Record<string, unknown>) => { infos.push({ msg, ...(fields ? { fields } : {}) }); } };
    running = await startFromEnv({
      MIG_MASTER_KEY: randomBytes(32).toString('base64'), MIG_DATA_DIR: dir,
      MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LINKS_PORT: '0', MIG_API_HOST: '127.0.0.1',
    }, { log });
    expect(running.linksHost).toBe('127.0.0.1');
    const port = running.linksPort!;
    expect(port).toBeGreaterThan(0);
    expect(new Set([running.apiPort, running.adminPort, port]).size).toBe(3);
    const res = await fetch(`http://127.0.0.1:${port}/aB3xK9q`, { headers: { host: 'l.firma.pl' } });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Link wygasł');
    expect(infos.find((e) => e.msg === 'bramka.start')?.fields).toMatchObject({ linki: `127.0.0.1:${port}` });
    await running.stop();
    running = null;
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('zajęty port serwera przekierowań nie zatrzymuje bramki: API i panel działają, a dziennik podaje przyczynę', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mig-start-'));
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busy = (blocker.address() as AddressInfo).port;
    const entries: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const push = (level: string) => (msg: string, fields?: Record<string, unknown>) => { entries.push({ level, msg, ...(fields ? { fields } : {}) }); };
    const log = { error: push('error'), warn: push('warn'), info: push('info'), debug() {} };
    try {
      running = await startFromEnv({
        MIG_MASTER_KEY: randomBytes(32).toString('base64'), MIG_DATA_DIR: dir,
        MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LINKS_PORT: String(busy), MIG_API_HOST: '127.0.0.1',
      }, { log });
      expect(running.mode).toBe('normal');
      expect(running.linksPort).toBeUndefined();
      expect((await fetch(`http://127.0.0.1:${running.apiPort}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${running.adminPort}/healthz`)).status).toBe(200);
      expect(entries.filter((e) => e.level === 'error')).toEqual([{
        level: 'error', msg: 'linki.serwer_nie_dziala',
        fields: { host: '127.0.0.1', port: busy, code: 'EADDRINUSE', help: problemUrl('serwer-krotkich-linkow') },
      }]);
      expect(entries.find((e) => e.msg === 'bramka.start')?.fields).toMatchObject({ linki: 'nie działa' });
      await running.stop();
      running = null;
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('nie startuje bez klucza głównego', () => {
    expect(() => loadEnv({})).toThrow(/MIG_MASTER_KEY/);
  });
});
