import { describe, expect, it } from 'vitest';
import { problemUrl } from '../../src/docs-links.ts';
import type { LinksServerProblem } from '../../src/links/server-state.ts';
import { startAdminHarness, seedAccount } from '../helpers/admin-app.ts';

const NOW = new Date('2026-11-06T10:00:00Z');

const page = async (url: string, problem: LinksServerProblem | null) => {
  const h = await startAdminHarness(NOW, { linksServer: { problem: () => problem } });
  seedAccount(h);
  const res = await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
  expect(res.statusCode).toBe(200);
  return res.body;
};

const BUSY: LinksServerProblem = { host: '0.0.0.0', port: 8082, code: 'EADDRINUSE' };

describe('pasek „Serwer krótkich linków nie działa”', () => {
  for (const url of ['/przeglad', '/skracacz']) {
    it(`${url}: zajęty port daje pasek z przyczyną, skutkiem dla wysyłki i odnośnikiem do instrukcji`, async () => {
      const body = await page(url, BUSY);
      expect(body).toContain('Serwer krótkich linków nie działa, ponieważ port 8082 zajmuje inny program.');
      expect(body).toContain('Do czasu usunięcia przyczyny bramka wysyła linki w pełnej postaci, bez skracania.');
      expect(body).toContain(`href="${problemUrl('serwer-krotkich-linkow')}"`);
      expect(body).toMatch(/<div class="alert stop">[\s\S]*Serwer krótkich linków nie działa/);
    });

    it(`${url}: inny błąd nasłuchu podaje adres i kod błędu`, async () => {
      const body = await page(url, { host: '10.0.0.5', port: 8082, code: 'EADDRNOTAVAIL' });
      expect(body).toContain('Serwer krótkich linków nie działa, ponieważ bramka nie może nasłuchiwać na adresie 10.0.0.5:8082.');
      expect(body).toContain('System zgłasza błąd EADDRNOTAVAIL.');
    });

    it(`${url}: działający serwer nie daje paska`, async () => {
      expect(await page(url, null)).not.toContain('Serwer krótkich linków nie działa');
    });
  }
});
