import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/admin/session.ts';
import { UserInputError, createAdminUser, validateLogin, validatePassword } from '../../src/admin/users.ts';
import { AdminUsersRepo } from '../../src/store/admin-users.ts';
import { openDatabase } from '../../src/store/db.ts';

let users: AdminUsersRepo;

beforeEach(() => {
  users = new AdminUsersRepo(openDatabase(':memory:'), randomBytes(32));
});

describe('createAdminUser', () => {
  it('zakłada konto z hasłem zapisanym jako skrót argon2', async () => {
    const id = await createAdminUser(users, 'janek', 'dostatecznie-dlugie-haslo');
    const user = users.findById(id);
    expect(user?.login).toBe('janek');
    expect(user?.passwordHash.startsWith('$argon2')).toBe(true);
    expect(await verifyPassword(user!.passwordHash, 'dostatecznie-dlugie-haslo')).toBe(true);
  });

  it('zakłada konto bez drugiego składnika, bo włącza się go z panelu', async () => {
    const id = await createAdminUser(users, 'janek', 'dostatecznie-dlugie-haslo');
    expect(users.findById(id)?.totpEnabled).toBe(0);
  });

  it('odrzuca hasło krótsze niż dwanaście znaków', async () => {
    await expect(createAdminUser(users, 'janek', 'krotkie')).rejects.toThrow(/dwanaście/);
  });

  it('odrzuca login z niedozwolonymi znakami', async () => {
    await expect(createAdminUser(users, 'jan kowalski', 'dostatecznie-dlugie-haslo')).rejects.toThrow(/login/i);
    await expect(createAdminUser(users, '', 'dostatecznie-dlugie-haslo')).rejects.toThrow(/login/i);
  });

  it('odrzuca powtórzony login zamiast przerywać błędem bazy', async () => {
    await createAdminUser(users, 'janek', 'dostatecznie-dlugie-haslo');
    await expect(createAdminUser(users, 'janek', 'inne-dlugie-haslo')).rejects.toThrow(/istnieje/);
  });

  it('błędy danych są typu UserInputError, żeby formularz mógł je pokazać', async () => {
    await expect(createAdminUser(users, 'JANEK', 'dostatecznie-dlugie-haslo')).rejects.toBeInstanceOf(UserInputError);
  });
});

describe('validateLogin / validatePassword', () => {
  it('przepuszczają poprawne wartości', () => {
    expect(() => validateLogin('jan.kowalski_2')).not.toThrow();
    expect(() => validatePassword('dwanascie-znakow')).not.toThrow();
  });

  it('odrzucają złe wartości z komunikatem po polsku', () => {
    expect(() => validateLogin('-jan')).toThrow(/login/i);
    expect(() => validatePassword('11-znakow-a')).toThrow(/dwanaście/);
  });
});
