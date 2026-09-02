import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.ts';
import { startGate } from '../src/index.ts';

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
      MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LOG_LEVEL: 'silent', MIG_INBOUND_IDLE_MS: '1000',
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
      MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0',
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
      MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LOG_LEVEL: 'silent',
    });
    running = await startGate(config);
    expect(running.adminHost).toBe('127.0.0.1');
    expect(running.apiHost).toBe('0.0.0.0');
  });

  it('odpowiada na /hooks/ na porcie API i zatrzymuje się bez wiszących zegarów', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mig-start-'));
    const config = loadEnv({
      MIG_MASTER_KEY: randomBytes(32).toString('base64'),
      MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LOG_LEVEL: 'silent', MIG_TRUSTED_PROXIES: '10.0.0.1',
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

  it('nie startuje bez klucza głównego', () => {
    expect(() => loadEnv({})).toThrow(/MIG_MASTER_KEY/);
  });
});
