import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
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

/** Żądanie z adresem, którego fetch by nie przepuścił (zepsute kodowanie procentowe). */
function raw(port: number, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const panel = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${running!.adminPort}${path}`, init);
const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${running!.apiPort}${path}`, init);

describe('startEmergency', () => {
  it('zgłasza tryb i przyczynę oraz zapisuje wpis w dzienniku z adresem opisu', () => {
    expect(running!.mode).toBe('emergency');
    expect(running!.reason).toBe('key_mismatch');
    expect(log.error).toHaveBeenCalledWith('bramka.awaria_startu', expect.objectContaining({
      reason: 'key_mismatch', id: 'a1b2c3d4', docs: 'https://sqlik.github.io/multiinfo-gate/problemy/#klucz-glowny',
    }));
  });

  it('zepsuty adres w panelu też dostaje stronę przyczyny', async () => {
    const res = await raw(running!.adminPort, '/%E0%A4%A');
    expect(res.status).toBe(503);
    expect(res.type).toContain('text/html');
    expect(res.body).toContain('Bramka nie rozpoczęła pracy');
  });

  it('zepsuty adres w API dostaje błąd w kształcie API', async () => {
    const res = await raw(running!.apiPort, '/%E0%A4%A');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe('unavailable');
  });

  it('nieprawidłowy JSON w API i na adresie wejściowym to nadal 503', async () => {
    const zly = { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } };
    const msg = await api('/v1/messages', zly);
    expect(msg.status).toBe(503);
    expect((await msg.json()).error.code).toBe('unavailable');
    const hook = await api('/hooks/abc', zly);
    expect(hook.status).toBe(503);
    expect(await hook.json()).toEqual({ accepted: false, reason: 'unavailable' });
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
    expect(await res.text()).toBe('{"status":"unavailable"}\n');
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
    const text = await res.text();
    expect(text.endsWith('}\n')).toBe(true);
    const body = JSON.parse(text);
    expect(body.status).toBe('unavailable');
    expect(body.error.code).toBe('unavailable');
  });
});

describe('startEmergency bez wolnego portu', () => {
  it('zapisuje przyczynę w dzienniku, zanim spróbuje nasłuchu', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const port = (blocker.address() as { port: number }).port;
    const logged = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = loadEnv({ MIG_MASTER_KEY: randomBytes(32).toString('base64'), MIG_DATA_DIR: dir, MIG_API_HOST: '127.0.0.1', MIG_API_PORT: String(port), MIG_ADMIN_PORT: '0' });
    try {
      await expect(startEmergency(config, { reason: 'disk_full', id: 'b2c3d4e5' }, { install: null, log: logged })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(logged.error).toHaveBeenCalledWith('bramka.awaria_startu', expect.objectContaining({ reason: 'disk_full', id: 'b2c3d4e5' }));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
