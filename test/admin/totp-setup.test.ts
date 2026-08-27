import { authenticator } from 'otplib';
import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';

let h: AdminHarness;

beforeEach(async () => {
  h = await startAdminHarness(undefined, { totp: false });
});

const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string, payload: Record<string, string>) =>
  h.app.inject({ method: 'POST', url, payload, headers: { cookie: h.cookie } });

/** Sekret proponowany na ekranie włączania - ten sam, który przyjmie potwierdzenie. */
function secretFrom(body: string): string {
  const match = /data-sekret="([A-Z2-7]+)"/.exec(body);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe('wymuszenie drugiego składnika', () => {
  it('kieruje konto bez drugiego składnika na ekran włączania', async () => {
    const res = await get('/przeglad');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/drugi-skladnik');
  });

  it('pozwala się wylogować bez włączania', async () => {
    const res = await get('/wyloguj');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/zaloguj');
  });

  it('nie zatrzymuje konta, które ma już drugi składnik', async () => {
    h.users.enableTotp(h.userId, authenticator.generateSecret(), []);
    expect((await get('/przeglad')).statusCode).toBe(200);
  });

  it('odsyła z ekranu włączania konto, które ma już drugi składnik', async () => {
    h.users.enableTotp(h.userId, authenticator.generateSecret(), []);
    const res = await get('/drugi-skladnik');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/przeglad');
  });
});

describe('ekran włączania', () => {
  it('podaje sekret do przepisania i ten sam sekret w kodzie graficznym', async () => {
    const res = await get('/drugi-skladnik');
    expect(res.statusCode).toBe(200);
    const secret = secretFrom(res.body);
    expect(res.body).toContain('<svg');
    expect(res.body).toContain(`otpauth://totp/`);
    expect(res.body).toContain(encodeURIComponent('Multiinfo Gate'));
    expect(res.body).toContain(secret);
  });

  it('trzyma ten sam sekret między odświeżeniami, żeby przepisany kod nie przestał pasować', async () => {
    const first = secretFrom((await get('/drugi-skladnik')).body);
    const second = secretFrom((await get('/drugi-skladnik')).body);
    expect(second).toBe(first);
  });

  it('nie włącza drugiego składnika po błędnym kodzie', async () => {
    await get('/drugi-skladnik');
    const res = await post('/drugi-skladnik', { kod: '000000' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Kod nie pasuje');
    expect(h.users.findById(h.userId)?.totpEnabled).toBe(0);
  });

  it('nie przyjmuje potwierdzenia bez wcześniejszego wyświetlenia ekranu', async () => {
    const res = await post('/drugi-skladnik', { kod: '000000' });
    expect(res.statusCode).toBe(400);
    expect(h.users.findById(h.userId)?.totpEnabled).toBe(0);
  });

  it('włącza drugi składnik po poprawnym kodzie i pokazuje kody zapasowe', async () => {
    const secret = secretFrom((await get('/drugi-skladnik')).body);
    const res = await post('/drugi-skladnik', { kod: authenticator.generate(secret) });

    expect(res.statusCode).toBe(200);
    expect(h.users.findById(h.userId)?.totpEnabled).toBe(1);
    expect(h.users.totpSecret(h.userId)).toBe(secret);

    const codes = [...res.body.matchAll(/<li class="code">([A-Z0-9-]{9})<\/li>/g)].map((m) => m[1]!);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(h.users.consumeRecoveryCode(h.userId, codes[0]!)).toBe(true);
  });

  it('zapisuje włączenie w dzienniku', async () => {
    const secret = secretFrom((await get('/drugi-skladnik')).body);
    await post('/drugi-skladnik', { kod: authenticator.generate(secret) });
    expect(h.audit.list(10, 0).some((e) => e.action === 'drugi_skladnik_wlaczony')).toBe(true);
  });

  it('wpuszcza do panelu zaraz po włączeniu, bez ponownego logowania', async () => {
    const secret = secretFrom((await get('/drugi-skladnik')).body);
    await post('/drugi-skladnik', { kod: authenticator.generate(secret) });
    expect((await get('/przeglad')).statusCode).toBe(200);
  });
});
