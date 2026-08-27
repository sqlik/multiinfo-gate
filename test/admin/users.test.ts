import { beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { hashPassword, verifyPassword } from '../../src/admin/session.ts';
import { startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';

let h: AdminHarness;
let olaId: number;

beforeEach(async () => {
  h = await startAdminHarness();
  olaId = h.users.insert('ola', await hashPassword('haslo-oli-dwanascie'));
  h.users.enableTotp(olaId, authenticator.generateSecret(), []);
});

const get = (url: string, cookie = h.cookie) => h.app.inject({ method: 'GET', url, headers: { cookie } });
const form = (url: string, fields: Record<string, string>, cookie = h.cookie) => h.app.inject({
  method: 'POST', url,
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(fields).toString(),
});

describe('GET /uzytkownicy', () => {
  it('pokazuje wszystkich, oznacza własny wiersz i nie daje mu przycisku Usuń', async () => {
    h.users.touchLogin(olaId, new Date('2026-08-25T08:15:00Z'));
    const res = await get('/uzytkownicy');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<strong>janek</strong> <span class="tag">to Ty</span>');
    expect(res.body).toContain('<strong>ola</strong>');
    expect(res.body).toContain('2026-08-25 10:15:00');
    expect(res.body).toContain(`/uzytkownicy/${olaId}/usun`);
    expect(res.body).not.toContain(`/uzytkownicy/${h.userId}/usun`);
    expect(res.body).toContain(`/uzytkownicy/${h.userId}/reset-2fa`);
    expect(res.body).toContain('<span class="ct">2</span>');
  });

  it('rozróżnia konto z drugim składnikiem od konta czekającego na pierwsze logowanie', async () => {
    h.users.resetTotp(olaId);
    const res = await get('/uzytkownicy');
    expect(res.body).toContain('włączony');
    expect(res.body).toContain('czeka na pierwsze logowanie');
    expect(res.body).toContain('jeszcze bez logowania');
  });
});

describe('POST /uzytkownicy/nowy', () => {
  const add = (over: Record<string, string> = {}) => form('/uzytkownicy/nowy', {
    login: 'kasia', haslo: 'haslo-startowe-kasi', haslo2: 'haslo-startowe-kasi', ...over,
  });

  it('pokazuje formularz z regułami', async () => {
    const res = await get('/uzytkownicy/nowy');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="login"');
    expect(res.body).toContain('name="haslo2"');
    expect(res.body).toContain('co najmniej dwanaście znaków');
  });

  it('zakłada konto, pisze do dziennika i pokazuje komunikat o haśle startowym', async () => {
    const res = await add();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/uzytkownicy');
    const kasia = h.users.findByLogin('kasia');
    expect(kasia?.totpEnabled).toBe(0);
    expect(kasia?.passwordHash.startsWith('$argon2')).toBe(true);
    const list = await get('/uzytkownicy');
    expect(list.body).toContain('class="flash flash-ok"');
    expect(list.body).toContain('Użytkownik kasia dodany. Przekaż mu hasło startowe');
    const entry = h.audit.list(1, 0)[0]!;
    expect(entry.action).toBe('uzytkownik.utworzenie');
    expect(entry.actor).toBe('janek');
    expect(entry.target).toBe(`uzytkownik:${kasia!.id}`);
    expect(entry.meta).toEqual({ login: 'kasia' });
    expect(JSON.stringify(entry)).not.toContain('haslo-startowe');
  });

  it('odrzuca różne hasła, za krótkie hasło, zły login i powtórzony login - bez zapisu', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ haslo2: 'inne-haslo-startowe' }, 'Hasła różnią się.'],
      [{ haslo: 'krotkie', haslo2: 'krotkie' }, 'dwanaście'],
      [{ login: 'Kasia Nowak' }, 'Nieprawidłowy login'],
      [{ login: 'ola' }, 'już istnieje'],
    ];
    for (const [over, text] of cases) {
      const res = await add(over);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(text);
    }
    expect(h.users.count()).toBe(2);
  });

  it('po błędzie zostawia wpisany login w formularzu', async () => {
    const res = await add({ login: 'kasia', haslo2: 'inne-haslo-startowe' });
    expect(res.body).toContain('value="kasia"');
  });
});

describe('POST /uzytkownicy/:id/usun', () => {
  it('usuwa konto, zamyka jego sesje, pisze do dziennika i pokazuje komunikat', async () => {
    const olaCookie = `mig_session=${h.sessions.create(olaId)}`;
    expect((await get('/przeglad', olaCookie)).statusCode).toBe(200);

    const res = await form(`/uzytkownicy/${olaId}/usun`, {});
    expect(res.statusCode).toBe(302);
    expect(h.users.findById(olaId)).toBeUndefined();

    const stale = await get('/przeglad', olaCookie);
    expect(stale.headers.location).toBe('/zaloguj');

    const list = await get('/uzytkownicy');
    expect(list.body).toContain('Użytkownik ola usunięty.');
    const entry = h.audit.list(1, 0)[0]!;
    expect(entry.action).toBe('uzytkownik.usuniecie');
    expect(entry.meta).toEqual({ login: 'ola' });
  });

  it('nie pozwala usunąć siebie', async () => {
    const res = await form(`/uzytkownicy/${h.userId}/usun`, {});
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('class="flash flash-fail"');
    expect(res.body).toContain('Nie można usunąć własnego konta.');
    expect(h.users.findById(h.userId)).toBeDefined();
  });

  it('nie pozwala usunąć ostatniego konta', async () => {
    h.users.delete(h.userId);
    const olaCookie = `mig_session=${h.sessions.create(olaId)}`;
    const res = await form(`/uzytkownicy/${olaId}/usun`, {}, olaCookie);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('ostatniego');
  });

  it('nieistniejące konto daje 404', async () => {
    expect((await form('/uzytkownicy/999/usun', {})).statusCode).toBe(404);
  });
});

describe('POST /uzytkownicy/:id/reset-2fa', () => {
  it('cudze konto: wyłącza drugi składnik, zamyka sesje, następne logowanie idzie na ekran włączania', async () => {
    const olaCookie = `mig_session=${h.sessions.create(olaId)}`;
    const res = await form(`/uzytkownicy/${olaId}/reset-2fa`, {});
    expect(res.statusCode).toBe(302);
    expect(h.users.findById(olaId)?.totpEnabled).toBe(0);
    expect(h.users.totpSecret(olaId)).toBeNull();
    expect((await get('/przeglad', olaCookie)).headers.location).toBe('/zaloguj');

    const login = await h.app.inject({ method: 'POST', url: '/zaloguj', payload: { login: 'ola', haslo: 'haslo-oli-dwanascie' } });
    expect(login.statusCode).toBe(302);
    const session = login.cookies.find((c) => c.name === 'mig_session')!;
    expect((await get('/przeglad', `mig_session=${session.value}`)).headers.location).toBe('/drugi-skladnik');

    const list = await get('/uzytkownicy');
    expect(list.body).toContain('Drugi składnik użytkownika ola wyłączony.');
    expect(h.audit.list(10, 0).some((e) => e.action === 'uzytkownik.reset_2fa' && e.meta?.login === 'ola')).toBe(true);
  });

  it('własne konto: wylogowuje od razu', async () => {
    const res = await form(`/uzytkownicy/${h.userId}/reset-2fa`, {});
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/zaloguj');
    expect(h.users.findById(h.userId)?.totpEnabled).toBe(0);
    expect((await get('/przeglad')).headers.location).toBe('/zaloguj');
  });
});

describe('/haslo', () => {
  const change = (over: Record<string, string> = {}, cookie = h.cookie) => form('/haslo', {
    obecne: 'tajne-haslo', nowe: 'zupelnie-nowe-haslo', nowe2: 'zupelnie-nowe-haslo', ...over,
  }, cookie);

  it('pokazuje formularz z trzema polami', async () => {
    const res = await get('/haslo');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="obecne"');
    expect(res.body).toContain('name="nowe2"');
  });

  it('zmienia hasło, zamyka pozostałe sesje, zostawia bieżącą, pisze do dziennika', async () => {
    const other = `mig_session=${h.sessions.create(h.userId)}`;
    const res = await change();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/przeglad');
    const hash = h.users.findById(h.userId)!.passwordHash;
    expect(await verifyPassword(hash, 'zupelnie-nowe-haslo')).toBe(true);
    expect((await get('/przeglad', other)).headers.location).toBe('/zaloguj');
    const home = await get('/przeglad');
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Hasło zmienione.');
    const entry = h.audit.list(1, 0)[0]!;
    expect(entry.action).toBe('haslo.zmiana');
    expect(entry.actor).toBe('janek');
    expect(entry.meta).toBeUndefined();
  });

  it('odrzuca złe obecne hasło, różne nowe i za krótkie nowe - hasło bez zmian', async () => {
    const before = h.users.findById(h.userId)!.passwordHash;
    const cases: Array<[Record<string, string>, string]> = [
      [{ obecne: 'nie-to-haslo' }, 'Obecne hasło nie pasuje.'],
      [{ nowe2: 'inne-nowe-haslo-xx' }, 'Nowe hasła różnią się.'],
      [{ nowe: 'krotkie', nowe2: 'krotkie' }, 'dwanaście'],
    ];
    for (const [over, text] of cases) {
      const res = await change(over);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(text);
    }
    expect(h.users.findById(h.userId)!.passwordHash).toBe(before);
  });
});
