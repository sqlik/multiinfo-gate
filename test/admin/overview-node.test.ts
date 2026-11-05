import { describe, expect, it } from 'vitest';
import { problemUrl } from '../../src/docs-links.ts';
import { startAdminHarness, seedAccount } from '../helpers/admin-app.ts';

const NOW = new Date('2026-11-04T10:00:00Z');

const overview = async (nodeVersion: string) => {
  const h = await startAdminHarness(NOW, { nodeVersion });
  seedAccount(h);
  return (await h.app.inject({ method: 'GET', url: '/przeglad', headers: { cookie: h.cookie } })).body;
};

describe('GET /przeglad - wersja Node', () => {
  it('Node bez poprawek z października 2026 daje pasek z wymaganą wersją i odnośnikiem do instrukcji', async () => {
    const body = await overview('v22.23.3');
    expect(body).toContain('Node.js 22.23.3, na którym działa bramka, nie zawiera poprawek bezpieczeństwa z października 2026');
    expect(body).toContain('Wymagana jest wersja 22.23.4 lub nowsza');
    expect(body).toContain(`href="${problemUrl('wersja-node')}"`);
  });
  it('linia bez poprawek (25) dostaje zdanie o linii, a nie o starszej wersji', async () => {
    const body = await overview('v25.9.0');
    expect(body).toContain('Node.js 25.9.0, na którym działa bramka, należy do linii, która nie otrzymuje poprawek bezpieczeństwa');
    expect(body).toContain('Wymagana jest wersja 22.23.4 lub nowsza z linii 22');
  });
  it('Node z poprawkami nie daje paska', async () => {
    const body = await overview('v22.23.4');
    expect(body).not.toContain('nie zawiera poprawek bezpieczeństwa');
  });
});
