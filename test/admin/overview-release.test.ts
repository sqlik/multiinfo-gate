import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-08-25T10:00:00Z');
const RELEASE = { version: '9.9.9', url: 'https://github.com/sqlik/multiinfo-gate/releases/tag/v9.9.9', publishedAt: '2026-08-20T12:00:00Z' };

let h: AdminHarness;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  seedAccount(h);
});

const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string, payload: Record<string, string>) =>
  h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(payload).toString() });

describe('GET /przeglad - nowe wydanie', () => {
  it('bez zapisanego wydania nie ma paska ani znacznika w maszcie', async () => {
    const res = await page('/przeglad');
    expect(res.body).not.toContain('Dostępne wydanie');
    expect(res.body).not.toContain('ver-new');
  });

  it('pokazuje pasek z numerem, datą, odnośnikami do opisu i instrukcji oraz przyciskiem odłożenia', async () => {
    h.settings.setLatestRelease(RELEASE, NOW);
    const res = await page('/przeglad');
    expect(res.body).toContain('Dostępne wydanie <strong>9.9.9</strong>');
    expect(res.body).toContain('2026-08-20');
    expect(res.body).toContain(`href="${RELEASE.url}"`);
    expect(res.body).toContain('href="https://sqlik.github.io/multiinfo-gate/uruchomienie/#74-aktualizacja"');
    expect(res.body).toContain('href="https://sqlik.github.io/multiinfo-gate/uruchomienie/#94-utrzymanie-w-kontenerze"');
    expect(res.body).toContain('action="/wydanie/odloz"');
    expect(res.body).toContain('<a class="ver-new" href="/przeglad">nowe wydanie 9.9.9</a>');
  });

  it('odłożone wydanie znika z przeglądu i masztu, a nowsze znów się pokazuje', async () => {
    h.settings.setLatestRelease(RELEASE, NOW);
    const res = await post('/wydanie/odloz', { version: '9.9.9' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/przeglad');
    expect(h.settings.dismissedRelease()).toBe('9.9.9');
    const after = await page('/przeglad');
    expect(after.body).not.toContain('Dostępne wydanie');
    expect(after.body).not.toContain('ver-new');
    expect(h.audit.list(5, 0).some((a) => a.action === 'ustawienia.wydanie_odlozone')).toBe(true);
    h.settings.setLatestRelease({ ...RELEASE, version: '9.9.10' }, NOW);
    expect((await page('/przeglad')).body).toContain('Dostępne wydanie <strong>9.9.10</strong>');
  });
});
