import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sourceLabel } from '../../src/integrations/source-label.ts';
import { defaultInboundConfig, defaultMailInConfig, defaultPowerAutomateConfig, defaultSmsGroupConfig } from '../../src/integrations/config.ts';
import { openDatabase } from '../../src/store/db.ts';
import type { AgentToolDeps } from '../../src/mcp/tools.ts';
import { AGENT_SEED_AT, agentToolDeps, seedAgent } from '../helpers/agent.ts';

const CONFIGS = {
  webhook_in: defaultInboundConfig, sms_group: defaultSmsGroupConfig, power_automate: defaultPowerAutomateConfig, mail_in: defaultMailInConfig,
} as const;

let seed: ReturnType<typeof seedAgent>;
let deps: AgentToolDeps;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  seed = seedAgent(db, key);
  deps = agentToolDeps(db, key);
});

function integration(name: string, kind: 'webhook_in' | 'sms_group' | 'power_automate' | 'mail_in'): number {
  return deps.integrations.insert({
    name, kind, apiKeyId: seed.keyId, serviceId: null, orig: null, preset: 'wlasny', enabled: 1, config: CONFIGS[kind](), secrets: {}, storePayloads: 0,
    createdAt: AGENT_SEED_AT,
  });
}

const label = (integrationId: number | null, agentConnectionId: number | null, requestedBy: string | null): string =>
  sourceLabel(deps, { integrationId, agentConnectionId, requestedBy });

describe('sourceLabel', () => {
  it('API, integracja, Mail2SMS i Power Automate', () => {
    expect(label(null, null, null)).toBe('API');
    expect(label(integration('Zgłoszenia serwisowe', 'webhook_in'), null, null)).toBe('integracja Zgłoszenia serwisowe');
    expect(label(integration('Alarmy z poczty', 'mail_in'), null, null)).toBe('integracja Alarmy z poczty');
    expect(label(integration('Formularz floty', 'power_automate'), null, 'ewa.nowak@firma.pl')).toBe('Power Automate Formularz floty');
    expect(label(seed.integrationId, seed.connectionId, 'Ewa Nowak')).toBe('agent Agent AI - dyspozytornia · Ewa Nowak');
  });

  it('sourceLabel dla grupy przez agenta i dla usuniętego połączenia', () => {
    const serwis = integration('SERWIS', 'sms_group');
    expect(label(serwis, seed.connectionId, 'Ewa Nowak')).toBe('grupa SERWIS · agent Agent AI - dyspozytornia · Ewa Nowak');
    expect(label(serwis, null, null)).toBe('integracja SERWIS');
    // Połączenie znika razem z integracją agenta: zostaje nazwa zapisana przy wysyłce.
    expect(label(serwis, null, 'Ewa Nowak')).toBe('grupa SERWIS · agent AI · Ewa Nowak');
    expect(label(seed.integrationId, null, 'Ewa Nowak')).toBe('agent Agent AI - dyspozytornia · Ewa Nowak');
    expect(label(null, null, 'Ewa Nowak')).toBe('usunięta integracja · Ewa Nowak');
  });

  it('sourceLabel: rozsyłka wysyłki z pliku z dopiskiem plik', () => {
    const row = { integrationId: seed.integrationId, agentConnectionId: seed.connectionId, requestedBy: 'Ewa Nowak' };
    expect(sourceLabel(deps, { ...row, fileSendId: 'fsd_1' })).toBe('agent Agent AI - dyspozytornia · Ewa Nowak · plik');
    expect(sourceLabel(deps, { ...row, fileSendId: null })).toBe('agent Agent AI - dyspozytornia · Ewa Nowak');
  });
});
