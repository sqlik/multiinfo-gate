import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/config/env.ts';
import type { Logger } from '../../src/log.ts';
import { startEmergency } from '../../src/startup/emergency.ts';
import type { RunningGate } from '../../src/startup/running.ts';

let dir: string;
let running: RunningGate | null = null;
let log: Logger & { error: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mig-awaria-'));
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const config = loadEnv({ MIG_MASTER_KEY: randomBytes(32).toString('base64'), MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0' });
  running = await startEmergency(config, { reason: 'key_mismatch', id: 'a1b2c3d4' }, { install: 'docker', log, error: new Error('szczegół') });
});

afterEach(async () => {
  await running?.stop();
  running = null;
  rmSync(dir, { recursive: true, force: true });
});

const panel = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${running!.adminPort}${path}`, init);
const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${running!.apiPort}${path}`, init);

describe('startEmergency', () => {
  it('zgłasza tryb i przyczynę oraz zapisuje wpis w dzienniku', () => {
    expect(running!.mode).toBe('emergency');
    expect(running!.reason).toBe('key_mismatch');
    expect(log.error).toHaveBeenCalledWith('bramka.awaria_startu', expect.objectContaining({ reason: 'key_mismatch', id: 'a1b2c3d4' }));
  });

  it('panel odpowiada stroną przyczyny na każdą ścieżkę', async () => {
    const res = await panel('/');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Bramka nie rozpoczęła pracy');
  });

  it('formularz wysłany z ciasteczkiem sesji też dostaje stronę przyczyny', async () => {
    const res = await panel('/konta', {
      method: 'POST', body: 'nazwa=Firma',
      headers: { cookie: 'mig_session=x', 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('a1b2c3d4');
  });

  it('arkusz stylów działa, żeby strona miała wygląd panelu', async () => {
    expect((await panel('/style.css')).status).toBe(200);
  });

  it('stan panelu zgłasza niedostępność bez szczegółów', async () => {
    const res = await panel('/healthz');
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"status":"unavailable"}');
  });

  it('API odpowiada błędem w kształcie API', async () => {
    const res = await api('/v1/messages', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('unavailable');
  });

  it('adres wejściowy integracji odpowiada w kształcie /hooks/', async () => {
    const res = await api('/hooks/abc', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ accepted: false, reason: 'unavailable' });
  });

  it('stan API zgłasza niedostępność', async () => {
    const res = await api('/healthz');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.error.code).toBe('unavailable');
  });
});
