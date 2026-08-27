import { describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { SessionStore, hashPassword, verifyPassword, verifyTotp } from '../../src/admin/session.ts';

describe('hashPassword / verifyPassword', () => {
  it('nie przechowuje hasła jawnie', async () => {
    const hash = await hashPassword('tajne-haslo');
    expect(hash).not.toContain('tajne-haslo');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('przyjmuje właściwe hasło i odrzuca inne', async () => {
    const hash = await hashPassword('tajne-haslo');
    await expect(verifyPassword(hash, 'tajne-haslo')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'inne-haslo')).resolves.toBe(false);
  });
});

describe('verifyTotp', () => {
  it('przyjmuje bieżący kod', () => {
    const secret = authenticator.generateSecret();
    expect(verifyTotp(secret, authenticator.generate(secret))).toBe(true);
  });

  it('odrzuca kod błędny', () => {
    const secret = authenticator.generateSecret();
    expect(verifyTotp(secret, '000000')).toBe(false);
  });
});

describe('SessionStore', () => {
  it('tworzy token i zwraca po nim użytkownika', () => {
    const store = new SessionStore();
    const token = store.create(1);
    expect(token).toHaveLength(43);
    expect(store.get(token)).toBe(1);
  });

  it('nie zwraca użytkownika po nieznanym tokenie', () => {
    expect(new SessionStore().get('nieistniejacy')).toBeNull();
  });

  it('unieważnia token przy wylogowaniu', () => {
    const store = new SessionStore();
    const token = store.create(1);
    store.destroy(token);
    expect(store.get(token)).toBeNull();
  });

  it('wygasza sesję po ośmiu godzinach bezczynności', () => {
    let t = 0;
    const store = new SessionStore(() => t);
    const token = store.create(1);
    t += 8 * 3600_000 + 1;
    expect(store.get(token)).toBeNull();
  });

  it('odświeża czas przy każdym użyciu', () => {
    let t = 0;
    const store = new SessionStore(() => t);
    const token = store.create(1);
    t += 7 * 3600_000;
    expect(store.get(token)).toBe(1);
    t += 7 * 3600_000;
    expect(store.get(token)).toBe(1);
  });
  it('kasuje wszystkie sesje użytkownika, z wyjątkiem wskazanej', () => {
    const store = new SessionStore();
    const a1 = store.create(1);
    const a2 = store.create(1);
    const b = store.create(2);
    store.destroyForUser(1, a2);
    expect(store.get(a1)).toBeNull();
    expect(store.get(a2)).toBe(1);
    expect(store.get(b)).toBe(2);
    store.destroyForUser(1);
    expect(store.get(a2)).toBeNull();
  });
});
