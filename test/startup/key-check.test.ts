import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptSecret } from '../../src/secrets/crypto.ts';
import { isKeyMismatch, verifyMasterKey } from '../../src/startup/key-check.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { AdminUsersRepo } from '../../src/store/admin-users.ts';
import { openDatabase } from '../../src/store/db.ts';
import { accountInput } from '../store/helpers.ts';

const keyA = randomBytes(32);
const keyB = randomBytes(32);

/** Konto panelu z drugim składnikiem zaszyfrowanym kluczem `key`. */
function adminWithTotp(db: ReturnType<typeof openDatabase>, key: Buffer, login = 'janek'): void {
  const users = new AdminUsersRepo(db, key);
  const id = users.insert(login, 'skrot-hasla');
  users.enableTotp(id, 'JBSWY3DPEHPK3PXP', ['ZAPASOWY-1']);
}

describe('verifyMasterKey', () => {
  it('pusta baza przyjmuje każdy klucz', () => {
    const check = verifyMasterKey(openDatabase(':memory:'), keyB);
    expect(check).toEqual({ readable: 0, unreadable: 0, unreadableGroups: [] });
    expect(isKeyMismatch(check)).toBe(false);
  });

  it('konto panelu bez drugiego składnika nie ma czego odszyfrować, więc przyjmuje każdy klucz', () => {
    const db = openDatabase(':memory:');
    new AdminUsersRepo(db, keyA).insert('janek', 'skrot-hasla');
    expect(isKeyMismatch(verifyMasterKey(db, keyB))).toBe(false);
  });

  it('wykrywa klucz, którym nie da się odszyfrować żadnego sekretu', () => {
    const db = openDatabase(':memory:');
    adminWithTotp(db, keyA);
    new AccountsRepo(db, keyA).insert(accountInput());
    const check = verifyMasterKey(db, keyB);
    expect(check.unreadable).toBe(2);
    expect(check.readable).toBe(0);
    expect(check.unreadableGroups).toEqual(['konta_panelu', 'konta_multiinfo']);
    expect(isKeyMismatch(check)).toBe(true);
  });

  it('właściwy klucz odczytuje wszystkie sekrety', () => {
    const db = openDatabase(':memory:');
    adminWithTotp(db, keyA);
    new AccountsRepo(db, keyA).insert(accountInput());
    const check = verifyMasterKey(db, keyA);
    expect(check).toEqual({ readable: 2, unreadable: 0, unreadableGroups: [] });
    expect(isKeyMismatch(check)).toBe(false);
  });

  it('baza mieszana nie jest niezgodnością, ale wskazuje nieczytelne grupy', () => {
    const db = openDatabase(':memory:');
    adminWithTotp(db, keyA);
    new AccountsRepo(db, keyB).insert(accountInput());
    const check = verifyMasterKey(db, keyB);
    expect(isKeyMismatch(check)).toBe(false);
    expect(check.unreadableGroups).toEqual(['konta_panelu']);
  });

  it('wartości historyczne nie biorą udziału w rozpoznaniu', () => {
    const db = openDatabase(':memory:');
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO integration_events (integration_id, at, result, payload_enc) VALUES (1, '2026-11-02T10:00:00Z', 'ok', ?)")
      .run(encryptSecret('{"x":1}', keyA));
    db.prepare("UPDATE webhook_deliveries SET headers_enc = ?").run(encryptSecret('{}', keyA));
    expect(isKeyMismatch(verifyMasterKey(db, keyB))).toBe(false);
  });
});
