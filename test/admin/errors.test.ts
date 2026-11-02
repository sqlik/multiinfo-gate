import { randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Logger, LogFields } from '../../src/log.ts';
import { AdminUsersRepo } from '../../src/store/admin-users.ts';
import { startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';

let h: AdminHarness;
let entries: Array<{ level: string; msg: string; fields?: LogFields }>;

beforeEach(async () => {
  entries = [];
  const at = (level: string) => (msg: string, fields?: LogFields) => { entries.push({ level, msg, fields }); };
  const log: Logger = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
  h = await startAdminHarness(undefined, { totp: false, log, install: 'docker' });
});

const wyjatki = () => entries.filter((e) => e.msg === 'panel.wyjatek');

describe('błąd wewnętrzny panelu', () => {
  it('zapisuje wpis z identyfikatorem i pokazuje stronę z tym identyfikatorem zamiast treści błędu', async () => {
    // Drugi składnik zaszyfrowany innym kluczem niż klucz panelu - jak po nadpisaniu pliku .env.
    const secret = authenticator.generateSecret();
    new AdminUsersRepo(h.db, randomBytes(32)).enableTotp(h.userId, secret, []);
    const first = await h.app.inject({ method: 'POST', url: '/zaloguj', payload: { login: 'janek', haslo: 'tajne-haslo' } });
    const stage = first.cookies.find((c) => c.name === 'mig_stage')!;
    const res = await h.app.inject({
      method: 'POST', url: '/zaloguj/kod?x=1', payload: { kod: authenticator.generate(secret) }, headers: { cookie: `mig_stage=${stage.value}` },
    });

    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toContain('text/html');
    expect(wyjatki()).toHaveLength(1);
    const { id, url, method } = wyjatki()[0]!.fields as { id: string; url: string; method: string };
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(url).toBe('/zaloguj/kod');
    expect(method).toBe('POST');
    expect(res.body).toContain(id);
    expect(res.body).toContain(`docker compose logs multiinfo-gate | grep ${id}`);
    expect(res.body).toContain('https://sqlik.github.io/multiinfo-gate/problemy/#blad-wewnetrzny');
    expect(res.body).not.toContain('odszyfrować');
  });
});

describe('inne odpowiedzi błędów', () => {
  it('nieznana strona dla zalogowanego to strona 404, nie JSON', async () => {
    h.users.enableTotp(h.userId, authenticator.generateSecret(), []);
    const res = await h.app.inject({ method: 'GET', url: '/nie-ma-takiej-strony', headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(wyjatki()).toHaveLength(0);
  });

  it('za duży formularz to strona 413 bez wpisu o wyjątku', async () => {
    h.users.enableTotp(h.userId, authenticator.generateSecret(), []);
    const res = await h.app.inject({
      method: 'POST', url: '/klucze', headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `nazwa=${'a'.repeat(3 * 1024 * 1024)}`,
    });
    expect(res.statusCode).toBe(413);
    expect(res.headers['content-type']).toContain('text/html');
    expect(wyjatki()).toHaveLength(0);
  });
});
