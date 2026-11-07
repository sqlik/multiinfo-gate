import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.ts';
import { startFromEnv, startGate } from '../../src/index.ts';
import type { Logger, LogFields } from '../../src/log.ts';
import type { RunningGate } from '../../src/startup/running.ts';
import { AdminUsersRepo } from '../../src/store/admin-users.ts';
import { openDatabase } from '../../src/store/db.ts';
import { SettingsRepo } from '../../src/store/settings.ts';
import { GATE_VERSION } from '../../src/version.ts';

const keyA = randomBytes(32);
const keyB = randomBytes(32);

let dir: string;
let running: RunningGate | null = null;
let entries: Array<{ level: string; msg: string; fields?: LogFields }>;
let log: Logger;
let blocker: Server | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mig-start-'));
  entries = [];
  const at = (level: string) => (msg: string, fields?: LogFields) => { entries.push({ level, msg, fields }); };
  log = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
});

afterEach(async () => {
  await running?.stop();
  running = null;
  await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
  blocker = null;
  rmSync(dir, { recursive: true, force: true });
});

const env = (key: Buffer, extra: Record<string, string> = {}) => ({
  MIG_MASTER_KEY: key.toString('base64'), MIG_DATA_DIR: dir, MIG_API_PORT: '0', MIG_ADMIN_PORT: '0', MIG_LINKS_PORT: '0', ...extra,
});
const start = (key: Buffer, extra: Record<string, string> = {}) => startGate(loadEnv(env(key, extra)), { log, install: 'docker' });
const dbPath = () => join(dir, 'multiinfo-gate.sqlite');

/** Baza z kontem panelu, którego drugi składnik zaszyfrowano kluczem `key`. */
function seedAdmin(key: Buffer): void {
  const db = openDatabase(dbPath());
  const users = new AdminUsersRepo(db, key);
  users.enableTotp(users.insert('janek', 'skrot-hasla'), 'JBSWY3DPEHPK3PXP', []);
  db.close();
}

describe('start bramki', () => {
  it('pierwszy start na pustym katalogu pracuje normalnie, bez kopii, z zapisaną wersją', async () => {
    running = await start(keyA);
    expect(running.mode).toBe('normal');
    const backups = join(dir, 'backups');
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
    const db = new Database(dbPath(), { readonly: true });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'gate_version'").get()).toEqual({ value: GATE_VERSION });
    db.close();
  });

  it('klucz niepasujący do bazy przełącza bramkę w tryb awaryjny', async () => {
    seedAdmin(keyA);
    running = await start(keyB);
    expect(running.mode).toBe('emergency');
    expect(running.reason).toBe('key_mismatch');
    expect(running.linksPort).toBeUndefined();
    const res = await fetch(`http://127.0.0.1:${running.adminPort}/zaloguj`);
    expect(res.status).toBe(503);
    expect(entries).toContainEqual(expect.objectContaining({ level: 'error', msg: 'bramka.awaria_startu', fields: expect.objectContaining({ reason: 'key_mismatch' }) }));
  });

  it('właściwy klucz uruchamia bramkę normalnie', async () => {
    seedAdmin(keyA);
    running = await start(keyA);
    expect(running.mode).toBe('normal');
  });

  it('baza z nowszego wydania przełącza w tryb awaryjny i zostaje nienaruszona', async () => {
    const raw = new Database(dbPath());
    raw.pragma('user_version = 99');
    raw.close();
    running = await start(keyA);
    expect(running.reason).toBe('newer_database');
    const check = new Database(dbPath(), { readonly: true });
    expect(check.pragma('user_version', { simple: true })).toBe(99);
    check.close();
  });

  it('zmiana wersji zapisuje kopię, a ponowny start tej samej wersji już nie', async () => {
    const db = openDatabase(dbPath());
    new SettingsRepo(db).setGateVersion('1.0.0', new Date('2026-11-01T10:00:00Z'));
    db.close();
    running = await start(keyA);
    expect(readdirSync(join(dir, 'backups'))).toEqual(['przed-aktualizacja-1.0.0.sqlite']);
    await running.stop();
    running = await start(keyA);
    expect(readdirSync(join(dir, 'backups'))).toEqual(['przed-aktualizacja-1.0.0.sqlite']);
  });

  it('zajęty port kończy start błędem zamiast trybu awaryjnego', async () => {
    blocker = createServer();
    await new Promise<void>((resolve) => blocker!.listen(0, '127.0.0.1', () => resolve()));
    const port = (blocker.address() as { port: number }).port;
    await expect(start(keyA, { MIG_API_HOST: '127.0.0.1', MIG_API_PORT: String(port) })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('zajęty port przekierowań nie zatrzymuje startu, a zatrzymanie bramki zwalnia bazę dla następnego startu', async () => {
    // Decyzja z 2026-11-06: serwer krótkich linków nie może odebrać klientowi wysyłki SMS-ów po aktualizacji.
    blocker = createServer();
    await new Promise<void>((resolve) => blocker!.listen(0, '127.0.0.1', () => resolve()));
    const port = (blocker.address() as { port: number }).port;
    running = await start(keyA, { MIG_LINKS_HOST: '127.0.0.1', MIG_LINKS_PORT: String(port) });
    expect(running.mode).toBe('normal');
    expect(running.linksPort).toBeUndefined();
    await running.stop();
    running = await start(keyA);
    expect(running.mode).toBe('normal');
    expect(running.linksPort).toBeGreaterThan(0);
  });

  it('świeża instalacja, która nie wystartowała, nie dostaje potem kopii pustej bazy', async () => {
    blocker = createServer();
    await new Promise<void>((resolve) => blocker!.listen(0, '127.0.0.1', () => resolve()));
    const port = (blocker.address() as { port: number }).port;
    await expect(start(keyA, { MIG_API_HOST: '127.0.0.1', MIG_API_PORT: String(port) })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    running = await start(keyA);
    expect(running.mode).toBe('normal');
    const backups = join(dir, 'backups');
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
  });

  it('klucz w złej postaci przełącza w tryb awaryjny już przy odczycie konfiguracji', async () => {
    running = await startFromEnv({ ...env(keyA), MIG_MASTER_KEY: 'za-krotki' }, { log, install: 'docker' });
    expect(running.mode).toBe('emergency');
    expect(running.reason).toBe('key_invalid');
  });
});
