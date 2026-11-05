/**
 * Szczegóły /healthz panelu (wersja, nazwy kont Multiinfo, daty certyfikatów, liczby kont Microsoft 365)
 * trafiają tylko tam, gdzie decyduje adres połączenia: pętla zwrotna albo odwrotne proxy z MIG_TRUSTED_PROXIES
 * przekazujące HTTPS. Nagłówki Host i X-Forwarded-Proto ustawia dowolny klient, więc same nie wystarczają.
 */
import { describe, expect, it } from 'vitest';
import { seedAccount, startAdminHarness } from '../helpers/admin-app.ts';

const healthz = async (remoteAddress: string, headers: Record<string, string> = {}, trustedProxies: string[] = []) => {
  const h = await startAdminHarness(undefined, { trustedProxies });
  seedAccount(h);
  return (await h.app.inject({ method: 'GET', url: '/healthz', remoteAddress, headers: { host: '10.10.10.159:8081', ...headers } })).json();
};
const detailed = (body: Record<string, unknown>) => 'version' in body && Array.isArray(body.accounts);

describe('/healthz panelu: szczegóły według adresu połączenia', () => {
  it('pętla zwrotna IPv4, IPv6 i odwzorowana IPv4 podaje szczegóły', async () => {
    for (const peer of ['127.0.0.1', '127.0.1.1', '::1', '::ffff:127.0.0.1']) expect(detailed(await healthz(peer)), peer).toBe(true);
  });

  it('klient z sieci bez nagłówków dostaje sam status', async () => {
    expect(await healthz('10.10.10.77')).toEqual({ status: 'ok' });
  });

  it('klient z sieci z dopisanym X-Forwarded-Proto: https dostaje sam status', async () => {
    expect(await healthz('10.10.10.77', { 'x-forwarded-proto': 'https' })).toEqual({ status: 'ok' });
  });

  it('klient z sieci z podmienionym Host: localhost dostaje sam status', async () => {
    expect(await healthz('10.10.10.77', { host: 'localhost:8081' })).toEqual({ status: 'ok' });
  });

  it('odwrotne proxy z MIG_TRUSTED_PROXIES przekazujące HTTPS podaje szczegóły', async () => {
    expect(detailed(await healthz('172.18.0.2', { host: 'sms.firma.pl', 'x-forwarded-proto': 'https' }, ['172.16.0.0/12']))).toBe(true);
  });

  it('zaufane proxy bez HTTPS i proxy spoza listy dostają sam status', async () => {
    expect(await healthz('172.18.0.2', { host: 'sms.firma.pl' }, ['172.16.0.0/12'])).toEqual({ status: 'ok' });
    expect(await healthz('10.10.10.5', { host: 'sms.firma.pl', 'x-forwarded-proto': 'https' }, ['172.16.0.0/12'])).toEqual({ status: 'ok' });
  });
});
