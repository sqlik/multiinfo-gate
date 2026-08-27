import { describe, expect, it } from 'vitest';
import { AdminUsersRepo } from '../../src/store/admin-users.ts';
import { openDatabase } from '../../src/store/db.ts';
import { testKey } from './helpers.ts';

const setup = () => new AdminUsersRepo(openDatabase(':memory:'), testKey());

describe('AdminUsersRepo', () => {
  it('zakłada konto i odnajduje je po loginie', () => {
    const repo = setup();
    const id = repo.insert('rose', 'argon2id$aaa');

    const row = repo.findByLogin('rose');
    expect(row?.id).toBe(id);
    expect(row?.passwordHash).toBe('argon2id$aaa');
    expect(row?.totpEnabled).toBe(0);
    expect(repo.findByLogin('ktos-inny')).toBeUndefined();
  });

  it('zapisuje sekret TOTP w postaci zaszyfrowanej', () => {
    const db = openDatabase(':memory:');
    const repo = new AdminUsersRepo(db, testKey());
    const id = repo.insert('rose', 'argon2id$aaa');
    repo.enableTotp(id, 'JBSWY3DPEHPK3PXP', ['kod-1', 'kod-2']);

    const stored = db.prepare('SELECT totp_secret_enc, recovery_codes_enc FROM admin_users WHERE id = ?').get(id) as {
      totp_secret_enc: string; recovery_codes_enc: string;
    };
    expect(stored.totp_secret_enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(stored.recovery_codes_enc).not.toContain('kod-1');
    expect(repo.totpSecret(id)).toBe('JBSWY3DPEHPK3PXP');
    expect(repo.findByLogin('rose')?.totpEnabled).toBe(1);
  });

  it('nie zwraca sekretu TOTP, zanim drugi składnik zostanie uruchomiony', () => {
    const repo = setup();
    const id = repo.insert('rose', 'argon2id$aaa');
    expect(repo.totpSecret(id)).toBeNull();
  });

  it('zużywa kod odzyskiwania tylko raz', () => {
    const repo = setup();
    const id = repo.insert('rose', 'argon2id$aaa');
    repo.enableTotp(id, 'JBSWY3DPEHPK3PXP', ['kod-1', 'kod-2']);

    expect(repo.consumeRecoveryCode(id, 'kod-1')).toBe(true);
    expect(repo.consumeRecoveryCode(id, 'kod-1')).toBe(false);
    expect(repo.consumeRecoveryCode(id, 'kod-2')).toBe(true);
    expect(repo.consumeRecoveryCode(id, 'kod-nieznany')).toBe(false);
  });

  it('odmawia zużycia kodu, gdy drugi składnik nie jest uruchomiony', () => {
    const repo = setup();
    const id = repo.insert('rose', 'argon2id$aaa');
    expect(repo.consumeRecoveryCode(id, 'kod-1')).toBe(false);
  });

  it('nie pozwala na dwa konta o tym samym loginie', () => {
    const repo = setup();
    repo.insert('rose', 'argon2id$aaa');
    expect(() => repo.insert('rose', 'argon2id$bbb')).toThrow();
  });
  it('lista zawiera wszystkie konta w kolejności utworzenia, z datą ostatniego logowania', () => {
    const repo = setup();
    const a = repo.insert('ania', 'argon2id$aaa');
    const b = repo.insert('bartek', 'argon2id$bbb');
    repo.touchLogin(b, new Date('2026-08-26T20:50:38Z'));

    const rows = repo.list();
    expect(rows.map((r) => r.login)).toEqual(['ania', 'bartek']);
    expect(rows[0]!.lastLoginAt).toBeNull();
    expect(rows[1]!.lastLoginAt).toBe('2026-08-26T20:50:38.000Z');
    expect(repo.count()).toBe(2);
    expect(repo.findById(a)?.lastLoginAt).toBeNull();
  });

  it('usuwa konto', () => {
    const repo = setup();
    const id = repo.insert('ania', 'argon2id$aaa');
    repo.delete(id);
    expect(repo.findById(id)).toBeUndefined();
    expect(repo.count()).toBe(0);
  });

  it('reset drugiego składnika czyści sekret, kody i znacznik', () => {
    const db = openDatabase(':memory:');
    const repo = new AdminUsersRepo(db, testKey());
    const id = repo.insert('ania', 'argon2id$aaa');
    repo.enableTotp(id, 'JBSWY3DPEHPK3PXP', ['kod-1']);
    repo.resetTotp(id);
    const raw = db.prepare('SELECT totp_secret_enc, recovery_codes_enc, totp_enabled FROM admin_users WHERE id = ?').get(id) as {
      totp_secret_enc: string | null; recovery_codes_enc: string | null; totp_enabled: number;
    };
    expect(raw).toEqual({ totp_secret_enc: null, recovery_codes_enc: null, totp_enabled: 0 });
    expect(repo.totpSecret(id)).toBeNull();
    expect(repo.consumeRecoveryCode(id, 'kod-1')).toBe(false);
  });

  it('zmienia skrót hasła', () => {
    const repo = setup();
    const id = repo.insert('ania', 'argon2id$aaa');
    repo.setPassword(id, 'argon2id$nowy');
    expect(repo.findById(id)?.passwordHash).toBe('argon2id$nowy');
  });
});
