import { beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';

let h: AdminHarness;
const SECRET = authenticator.generateSecret();

beforeEach(async () => {
  h = await startAdminHarness();
});

const post = (url: string, payload: Record<string, string>, cookie?: string) =>
  h.app.inject({ method: 'POST', url, payload, ...(cookie ? { headers: { cookie } } : {}) });

/** Przechodzi oba etapy logowania i zwraca ciasteczko sesji. */
async function logIn(code = () => authenticator.generate(SECRET)) {
  h.users.enableTotp(h.userId, SECRET, ['ZAPASOWY-1', 'ZAPASOWY-2']);
  const first = await post('/zaloguj', { login: 'janek', haslo: 'tajne-haslo' });
  const stage = first.cookies.find((c) => c.name === 'mig_stage')!;
  const second = await post('/zaloguj/kod', { kod: code() }, `mig_stage=${stage.value}`);
  return { first, second, session: second.cookies.find((c) => c.name === 'mig_session') };
}

describe('dostęp bez sesji', () => {
  it('przekierowuje na ekran logowania', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/konta' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/zaloguj');
  });

  it('wpuszcza ekran logowania i arkusz stylów', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/zaloguj' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/style.css' })).statusCode).toBe(200);
  });

  it('podaje kroje pisma z repozytorium, a nie z sieci', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/fonts/IBMPlexSans-Regular.woff2' });
    expect(res.statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/style.css' })).body).not.toContain('googleapis');
  });
});

describe('pierwszy etap', () => {
  it('odpowiada tak samo na nieznany login i na złe hasło', async () => {
    const nieznany = await post('/zaloguj', { login: 'ktos.inny', haslo: 'tajne-haslo' });
    const zleHaslo = await post('/zaloguj', { login: 'janek', haslo: 'nie-to-haslo' });
    expect(nieznany.statusCode).toBe(401);
    expect(zleHaslo.statusCode).toBe(401);
    expect(nieznany.body).toBe(zleHaslo.body);
    expect(zleHaslo.body).toContain('Nieprawidłowy login lub hasło.');
  });

  it('zapisuje nieudaną próbę w dzienniku razem z adresem', async () => {
    await post('/zaloguj', { login: 'janek', haslo: 'nie-to-haslo' });
    const wpis = h.audit.list(10, 0).find((e) => e.action === 'logowanie_nieudane');
    expect(wpis?.actor).toBe('janek');
    expect(wpis?.ip).toBeTruthy();
  });

  it('po poprawnym haśle pyta o kod i nie zakłada jeszcze sesji', async () => {
    h.users.enableTotp(h.userId, SECRET, []);
    const res = await post('/zaloguj', { login: 'janek', haslo: 'tajne-haslo' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Kod z aplikacji');
    expect(res.cookies.find((c) => c.name === 'mig_session')).toBeUndefined();
  });

  it('wpuszcza konto bez drugiego składnika, ale tylko na ekran jego włączania', async () => {
    h = await startAdminHarness(undefined, { totp: false });
    const res = await post('/zaloguj', { login: 'janek', haslo: 'tajne-haslo' });
    expect(res.statusCode).toBe(302);
    const session = res.cookies.find((c) => c.name === 'mig_session');
    expect(session).toBeDefined();
    expect(h.audit.list(10, 0).some((e) => e.action === 'logowanie_bez_totp')).toBe(true);

    const dalej = await h.app.inject({
      method: 'GET', url: '/przeglad', headers: { cookie: `mig_session=${session!.value}` },
    });
    expect(dalej.headers.location).toBe('/drugi-skladnik');
  });
});

describe('ochrona przed zgadywaniem', () => {
  const stageOf = async () => {
    h.users.enableTotp(h.userId, SECRET, []);
    const first = await post('/zaloguj', { login: 'janek', haslo: 'tajne-haslo' });
    return `mig_stage=${first.cookies.find((c) => c.name === 'mig_stage')!.value}`;
  };

  it('po pięciu błędnych kodach unieważnia etap pośredni i każe zacząć od nowa', async () => {
    const cookie = await stageOf();
    for (let i = 0; i < 4; i += 1) {
      const res = await post('/zaloguj/kod', { kod: '000000' }, cookie);
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('Kod nie pasuje');
    }
    const piata = await post('/zaloguj/kod', { kod: '000000' }, cookie);
    expect(piata.statusCode).toBe(401);
    expect(piata.body).toContain('Zbyt wiele błędnych kodów');
    expect(piata.cookies.find((c) => c.name === 'mig_stage')?.value).toBe('');

    // Etap jest już unieważniony - nawet poprawny kod nie zakłada sesji.
    const poprawny = await post('/zaloguj/kod', { kod: authenticator.generate(SECRET) }, cookie);
    expect(poprawny.statusCode).toBe(401);
    expect(poprawny.cookies.find((c) => c.name === 'mig_session')).toBeUndefined();
    expect(h.audit.list(20, 0).some((e) => e.action === 'drugi_skladnik_zablokowany')).toBe(true);
  });

  it('po dziesięciu nieudanych logowaniach z jednego adresu odpowiada 429 także na poprawne hasło', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await post('/zaloguj', { login: 'janek', haslo: 'nie-to-haslo' })).statusCode).toBe(401);
    }
    const res = await post('/zaloguj', { login: 'janek', haslo: 'tajne-haslo' });
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain('Zbyt wiele nieudanych prób');
    expect(res.cookies.find((c) => c.name === 'mig_stage')).toBeUndefined();
    expect(h.audit.list(20, 0).some((e) => e.action === 'logowanie_zablokowane')).toBe(true);
  });

  it('błędne kody liczą się do blokady adresu tak samo jak błędne hasła', async () => {
    const cookie = await stageOf();
    for (let i = 0; i < 4; i += 1) await post('/zaloguj/kod', { kod: '000000' }, cookie);
    for (let i = 0; i < 6; i += 1) await post('/zaloguj', { login: 'janek', haslo: 'nie-to-haslo' });
    expect((await post('/zaloguj', { login: 'janek', haslo: 'tajne-haslo' })).statusCode).toBe(429);
  });

  it('blokada adresu mija po kwadransie', async () => {
    const clock = new Date('2026-08-25T10:00:00Z');
    h = await startAdminHarness(clock);
    for (let i = 0; i < 10; i += 1) await post('/zaloguj', { login: 'janek', haslo: 'nie-to-haslo' });
    expect((await post('/zaloguj', { login: 'janek', haslo: 'tajne-haslo' })).statusCode).toBe(429);
    clock.setTime(clock.getTime() + 15 * 60_000 + 1);
    expect((await post('/zaloguj', { login: 'janek', haslo: 'tajne-haslo' })).statusCode).toBe(200);
  });

  it('udane logowanie zeruje licznik nieudanych prób adresu', async () => {
    for (let i = 0; i < 9; i += 1) await post('/zaloguj', { login: 'janek', haslo: 'nie-to-haslo' });
    await logIn();
    for (let i = 0; i < 9; i += 1) await post('/zaloguj', { login: 'janek', haslo: 'nie-to-haslo' });
    expect((await post('/zaloguj', { login: 'janek', haslo: 'tajne-haslo' })).statusCode).toBe(200);
  });

  it('nieznany login kosztuje tyle samo pracy co sprawdzenie hasła znanego konta', async () => {
    // Rozgrzewka: pierwsze wywołanie argon2 bywa wolniejsze.
    await post('/zaloguj', { login: 'janek', haslo: 'nie-to-haslo' });
    const started = process.hrtime.bigint();
    await post('/zaloguj', { login: 'nie.ma.takiego', haslo: 'nie-to-haslo' });
    const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    // Odrzucenie bez liczenia skrótu trwa ułamek milisekundy; argon2 - dziesiątki.
    expect(elapsedMs).toBeGreaterThanOrEqual(5);
  });
});

describe('panel bez HTTPS poza pętlą zwrotną', () => {
  const lan = { host: '192.168.1.5:8081' };

  it('nie próbuje logować, tylko mówi, że ciasteczko sesji wymaga HTTPS albo adresu lokalnego', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/zaloguj', headers: lan, payload: { login: 'janek', haslo: 'tajne-haslo' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('127.0.0.1');
    expect(res.cookies.find((c) => c.name === 'mig_stage')).toBeUndefined();
    expect(h.audit.list(10, 0).some((e) => e.action === 'logowanie_nieudane')).toBe(false);
  });

  it('ostrzega już na ekranie logowania', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/zaloguj', headers: lan });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('127.0.0.1');
  });

  it('ufa nagłówkowi X-Forwarded-Proto: https od odwrotnego proxy', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/zaloguj', headers: { ...lan, 'x-forwarded-proto': 'https' }, payload: { login: 'janek', haslo: 'tajne-haslo' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Kod z aplikacji');
  });

  it('adres lokalny przechodzi bez ostrzeżenia', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/zaloguj', headers: { host: '127.0.0.1:8081' } });
    expect(res.body).not.toContain('wymaga HTTPS');
  });
});

describe('drugi etap', () => {
  it('zakłada sesję po poprawnym kodzie', async () => {
    const { second, session } = await logIn();
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toBe('/przeglad');
    expect(h.sessions.get(session!.value)).toBe(h.userId);
  });

  it('daje ciasteczko niedostępne dla skryptów i nieprzenośne między witrynami', async () => {
    const { session } = await logIn();
    expect(session!.httpOnly).toBe(true);
    expect(session!.sameSite).toMatch(/strict/i);
    expect(session!.secure).toBe(true);
    expect(session!.path).toBe('/');
  });

  it('odrzuca błędny kod i nie zakłada sesji', async () => {
    const { second, session } = await logIn(() => '000000');
    expect(second.statusCode).toBe(401);
    expect(session).toBeUndefined();
    expect(h.audit.list(10, 0).some((e) => e.action === 'drugi_skladnik_nieudany')).toBe(true);
  });

  it('przyjmuje kod zapasowy, ale tylko raz', async () => {
    h.users.enableTotp(h.userId, SECRET, ['ZAPASOWY-1']);
    const start = () => post('/zaloguj', { login: 'janek', haslo: 'tajne-haslo' });

    const pierwszy = await start();
    const stage1 = pierwszy.cookies.find((c) => c.name === 'mig_stage')!;
    const udane = await post('/zaloguj/kod', { kod: 'ZAPASOWY-1' }, `mig_stage=${stage1.value}`);
    expect(udane.statusCode).toBe(302);

    const drugi = await start();
    const stage2 = drugi.cookies.find((c) => c.name === 'mig_stage')!;
    const powtorne = await post('/zaloguj/kod', { kod: 'ZAPASOWY-1' }, `mig_stage=${stage2.value}`);
    expect(powtorne.statusCode).toBe(401);
  });

  it('zapisuje w dzienniku login, nie numer konta, i odnotowuje ostatnie logowanie', async () => {
    await logIn();
    const udane = h.audit.list(10, 0).find((e) => e.action === 'logowanie_udane');
    expect(udane?.actor).toBe('janek');
    expect(h.users.findById(h.userId)?.lastLoginAt).toBe('2026-08-25T10:00:00.000Z');

    await logIn(() => '000000');
    const nieudane = h.audit.list(10, 0).find((e) => e.action === 'drugi_skladnik_nieudany');
    expect(nieudane?.actor).toBe('janek');
  });

  it('nie przyjmuje kodu bez przejścia pierwszego etapu', async () => {
    h.users.enableTotp(h.userId, SECRET, []);
    const res = await post('/zaloguj/kod', { kod: authenticator.generate(SECRET) });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === 'mig_session')).toBeUndefined();
  });

  it('nie przyjmuje kodu po wygaśnięciu etapu pośredniego', async () => {
    h.users.enableTotp(h.userId, SECRET, []);
    const res = await post('/zaloguj/kod', { kod: authenticator.generate(SECRET) }, 'mig_stage=zmyslony-token');
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Zacznij od nowa');
  });
});

describe('wylogowanie', () => {
  it('unieważnia sesję', async () => {
    const { session } = await logIn();
    const res = await h.app.inject({
      method: 'GET', url: '/wyloguj', headers: { cookie: `mig_session=${session!.value}` },
    });
    expect(res.statusCode).toBe(302);
    expect(h.sessions.get(session!.value)).toBeNull();
  });
});
