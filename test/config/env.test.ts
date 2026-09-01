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
