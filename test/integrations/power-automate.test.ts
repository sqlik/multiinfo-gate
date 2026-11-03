import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors.ts';
import { defaultPowerAutomateConfig } from '../../src/integrations/config.ts';
import { fitToParts } from '../../src/integrations/pipeline.ts';
import { runPowerAutomate, type PowerAutomateIntegration } from '../../src/integrations/power-automate.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-11-03T10:00:00Z');
const meta = { sourceIp: 'API · 127.0.0.1' };
let deps: Parameters<typeof runPowerAutomate>[0];
let integration: PowerAutomateIntegration;
let accounts: AccountsRepo;
let accountId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  accounts = new AccountsRepo(db, key);
  accountId = accounts.insert(accountInput({ storeContent: 1 }));
  const apiKeys = new ApiKeysRepo(db, key);
  const apiKeyId = apiKeys.insert({ accountId, name: 'Power Automate', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
  const extra = integrationDeps(db, key);
  const id = extra.integrations.insert({
    name: 'Dyspozytornia', kind: 'power_automate', apiKeyId, serviceId: null, orig: null, preset: 'power-automate', enabled: 1,
    config: { ...defaultPowerAutomateConfig(), recipients: [{ phone: '48601000011', name: 'Marek Kowalski' }] }, secrets: {}, storePayloads: 0, createdAt: NOW,
  });
  integration = extra.integrations.get(id) as PowerAutomateIntegration;
  deps = {
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
    inbound: new InboundMessagesRepo(db), packages: new PackagesRepo(db), ...extra,
  };
});

const sms = (to: string, text = 'Awaria w hali B') => ({ action: 'sms' as const, body: { to, text, encoding: 'auto' as const, deliveryReport: true } });

describe('runPowerAutomate', () => {
  it('SMS do numeru: wynik z wiadomością i znormalizowanym numerem', () => {
    const out = runPowerAutomate(deps, integration, sms('601000001'), meta, NOW);
    expect(out).toEqual({ kind: 'sent', messages: [expect.objectContaining({ id: expect.stringMatching(/^msg_/), to: '48601000001', status: 'queued', parts: 1 })] });
  });

  it('SMS do grupy: wiadomość na każdy numer listy integracji', () => {
    const out = runPowerAutomate(deps, integration, { action: 'group', body: { text: 'x', encoding: 'auto', deliveryReport: true } }, meta, NOW);
    expect(out).toMatchObject({ kind: 'sent', messages: [{ to: '48601000011' }] });
  });

  it('konto wstrzymane: unavailable z powodem słowami', () => {
    accounts.pause(accountId, 'certyfikat wygasł');
    expect(runPowerAutomate(deps, integration, sms('48601000001'), meta, NOW)).toEqual({ kind: 'unavailable', detail: 'konto wstrzymane: certyfikat wygasł' });
  });

  it('nieprawidłowy numer: error z ApiError invalid_phone', () => {
    const out = runPowerAutomate(deps, integration, sms('abc'), meta, NOW);
    expect(out.kind).toBe('error');
    expect((out as { error: ApiError }).error).toBeInstanceOf(ApiError);
    expect((out as { error: ApiError }).error.code).toBe('invalid_phone');
  });

  it('burza: throttled z flagą powiadomienia tylko przy pierwszej odmowie w oknie', () => {
    integration = { ...integration, config: { ...integration.config, throttle: { limit: 1, windowMinutes: 10 } } };
    expect(runPowerAutomate(deps, integration, sms('48601000001'), meta, NOW).kind).toBe('sent');
    expect(runPowerAutomate(deps, integration, sms('48601000001'), meta, NOW)).toEqual({ kind: 'throttled', notify: true });
    expect(runPowerAutomate(deps, integration, sms('48601000001'), meta, NOW)).toEqual({ kind: 'throttled', notify: false });
  });
});

describe('fitToParts z kodowaniem', () => {
  it('kodowanie unicode liczy części jak UCS-2, także dla tekstu w alfabecie GSM', () => {
    expect(fitToParts('x'.repeat(100), 1).over).toBe(false);
    expect(fitToParts('x'.repeat(100), 1, 'unicode').over).toBe(true);
  });
});
