import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.ts';

const base = { MIG_MASTER_KEY: randomBytes(32).toString('base64') };

describe('loadEnv - odbiornik', () => {
  it('domyślnie long polling 60 s bez przerwy po pustej odpowiedzi', () => {
    const cfg = loadEnv(base, {});
    expect(cfg.inboundTimeoutMs).toBe(10_000);
    expect(cfg.inboundIdleMs).toBe(0);
  });
  it('przyjmuje odpytywanie okresowe', () => {
    const cfg = loadEnv({ ...base, MIG_INBOUND_TIMEOUT_MS: '1', MIG_INBOUND_IDLE_MS: '30000' }, {});
    expect(cfg.inboundTimeoutMs).toBe(1);
    expect(cfg.inboundIdleMs).toBe(30_000);
  });
  it('odrzuca timeout ponad limit Multiinfo i ujemną przerwę', () => {
    expect(() => loadEnv({ ...base, MIG_INBOUND_TIMEOUT_MS: '60001' }, {})).toThrow(/MIG_INBOUND_TIMEOUT_MS/);
    expect(() => loadEnv({ ...base, MIG_INBOUND_TIMEOUT_MS: '0' }, {})).toThrow(/MIG_INBOUND_TIMEOUT_MS/);
    expect(() => loadEnv({ ...base, MIG_INBOUND_IDLE_MS: '-1' }, {})).toThrow(/MIG_INBOUND_IDLE_MS/);
  });
});

describe('loadEnv - zaufane proxy', () => {
  it('pusta zmienna daje pustą listę', () => {
    expect(loadEnv(base, {}).trustedProxies).toEqual([]);
    expect(loadEnv({ ...base, MIG_TRUSTED_PROXIES: ' ' }, {}).trustedProxies).toEqual([]);
  });
  it('przyjmuje adresy i zakresy po przecinku', () => {
    expect(loadEnv({ ...base, MIG_TRUSTED_PROXIES: '10.0.0.1, 172.16.0.0/12' }, {}).trustedProxies).toEqual(['10.0.0.1', '172.16.0.0/12']);
  });
  it('odrzuca nazwę hosta', () => {
    expect(() => loadEnv({ ...base, MIG_TRUSTED_PROXIES: 'proxy.example' }, {})).toThrow(/MIG_TRUSTED_PROXIES/);
  });
});

describe('loadEnv - sprawdzanie wydań', () => {
  it('domyślnie włączone; MIG_UPDATE_CHECK=0 wyłącza', () => {
    expect(loadEnv(base, {}).updateCheck).toBe(true);
    expect(loadEnv({ ...base, MIG_UPDATE_CHECK: '1' }, {}).updateCheck).toBe(true);
    expect(loadEnv({ ...base, MIG_UPDATE_CHECK: '0' }, {}).updateCheck).toBe(false);
    expect(loadEnv({ ...base, MIG_UPDATE_CHECK: 'nie' }, {}).updateCheck).toBe(false);
  });
});

describe('loadEnv - sprawdzenie domeny skracacza w sieci wewnętrznej', () => {
  it('MIG_LINKS_ALLOW_PRIVATE domyślnie wyłączone, 1 włącza', () => {
    expect(loadEnv(base, {}).linksAllowPrivate).toBe(false);
    expect(loadEnv({ ...base, MIG_LINKS_ALLOW_PRIVATE: '1' }, {}).linksAllowPrivate).toBe(true);
  });
});

describe('loadEnv - serwer IMAP w sieci wewnętrznej', () => {
  it('MIG_MAIL_ALLOW_PRIVATE domyślnie wyłączone, 1 włącza', () => {
    expect(loadEnv(base, {}).mailAllowPrivate).toBe(false);
    expect(loadEnv({ ...base, MIG_MAIL_ALLOW_PRIVATE: '1' }, {}).mailAllowPrivate).toBe(true);
  });
});

describe('loadEnv - port przekierowań', () => {
  it('domyślnie port 8082 i adres nasłuchu API', () => {
    expect(loadEnv(base, {})).toMatchObject({ linksPort: 8082, linksHost: '0.0.0.0' });
    expect(loadEnv({ ...base, MIG_API_HOST: '10.0.0.5' }, {})).toMatchObject({ linksHost: '10.0.0.5' });
  });
  it('przyjmuje własny port i adres nasłuchu', () => {
    expect(loadEnv({ ...base, MIG_API_HOST: '10.0.0.5', MIG_LINKS_HOST: '127.0.0.1', MIG_LINKS_PORT: '9082' }, {}))
      .toMatchObject({ linksPort: 9082, linksHost: '127.0.0.1', apiHost: '10.0.0.5' });
  });
  it('nazwę interfejsu zamienia na jego adres IPv4, także odziedziczoną po MIG_API_HOST', () => {
    const interfaces = {
      eth0: [{ address: '172.30.0.5', family: 'IPv4' as const, internal: false }],
      eth1: [{ address: '172.31.0.5', family: 'IPv4' as const, internal: false }],
    };
    expect(loadEnv({ ...base, MIG_API_HOST: 'eth1' }, interfaces).linksHost).toBe('172.31.0.5');
    expect(loadEnv({ ...base, MIG_API_HOST: 'eth1', MIG_LINKS_HOST: 'eth0' }, interfaces).linksHost).toBe('172.30.0.5');
    expect(() => loadEnv({ ...base, MIG_LINKS_HOST: 'eth7' }, interfaces)).toThrow(/MIG_LINKS_HOST.*eth7/);
  });
});
