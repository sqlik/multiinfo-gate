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
