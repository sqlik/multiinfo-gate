import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAdminDatabase } from '../../src/cli/admin.ts';
import { AdminUsersRepo } from '../../src/store/admin-users.ts';
import { applyMigrations, openDatabase, openDatabaseRaw } from '../../src/store/db.ts';

const FIRST_SIX = ['001-initial.sql', '002-etap-2.sql', '003-etap-3.sql', '004-etap-3b.sql', '005-odbior.sql', '006-integracje.sql'];
const keyA = randomBytes(32);
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mig-cli-'));
  path = join(dir, 'multiinfo-gate.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('openAdminDatabase', () => {
  it('na świeżej bazie zakłada schemat', () => {
    const db = openAdminDatabase(path, keyA);
    expect(db.pragma('user_version', { simple: true })).toBe(10);
    db.close();
  });

  it('odmawia, gdy baza czeka na zmianę schematu, bo kopię przed nią robi bramka', () => {
    const raw = openDatabaseRaw(path);
    applyMigrations(raw, { migrations: FIRST_SIX });
    raw.close();
    expect(() => openAdminDatabase(path, keyA)).toThrow(/Uruchom najpierw bramkę/);
    const check = openDatabaseRaw(path);
    expect(check.pragma('user_version', { simple: true })).toBe(6);
    check.close();
  });

  it('odmawia przy kluczu, którym nie da się odczytać bazy', () => {
    const db = openDatabase(path);
    const users = new AdminUsersRepo(db, keyA);
    users.enableTotp(users.insert('janek', 'skrot-hasla'), 'JBSWY3DPEHPK3PXP', []);
    db.close();
    expect(() => openAdminDatabase(path, randomBytes(32))).toThrow(/Klucz główny nie pasuje do bazy/);
  });
});
