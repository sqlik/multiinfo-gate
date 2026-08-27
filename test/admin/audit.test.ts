import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';

let h: AdminHarness;

beforeEach(async () => {
  h = await startAdminHarness();
});

const page = (url = '/dziennik') => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

describe('GET /dziennik', () => {
  it('wypisuje zdarzenia od najnowszego', async () => {
    h.audit.record({ actor: 'janek', action: 'klucz.utworzenie', target: 'klucz:1', ip: '10.0.0.7' });
    h.audit.record({ actor: 'janek', action: 'klucz.odwolanie', target: 'klucz:1', ip: '10.0.0.7' });
    const res = await page();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Dziennik zdarzeń');
    expect(res.body.indexOf('klucz.odwolanie')).toBeLessThan(res.body.indexOf('klucz.utworzenie'));
    expect(res.body).toContain('10.0.0.7');
  });

  it('pokazuje szczegóły zdarzenia bez sekretów', async () => {
    h.audit.record({
      actor: 'janek', action: 'klucz.utworzenie', target: 'klucz:3',
      meta: { nazwa: 'CRM', prefiks: 'a1b2c3d4', uslugi: ['24138'] },
    });
    const res = await page();
    expect(res.body).toContain('a1b2c3d4');
    expect(res.body).toContain('CRM');
  });

  it('ucieka znaki HTML w polach zdarzenia', async () => {
    h.audit.record({ actor: '<script>alert(1)</script>', action: 'logowanie_nieudane', ip: '::1' });
    const res = await page();
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('stronicuje po pięćdziesiąt wpisów', async () => {
    for (let i = 0; i < 55; i += 1) {
      h.audit.record({ actor: 'janek', action: `zdarzenie_${i}` });
    }
    const first = await page();
    expect(first.body).toContain('zdarzenie_54');
    expect(first.body).not.toContain('zdarzenie_4<');
    expect(first.body).toContain('offset=50');
    const second = await page('/dziennik?offset=50');
    expect(second.body).toContain('zdarzenie_4<');
    expect(second.body).not.toContain('zdarzenie_54');
  });

  it('bez sesji odsyła do logowania', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/dziennik' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/zaloguj');
  });
});
