import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { cancelPackage, notCancellableMessage } from '../../src/api/cancel-package.ts';
import { generateApiKey } from '../../src/api/keys.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { defaultPowerAutomateConfig } from '../../src/integrations/config.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';

const masterKey = randomBytes(32);
const NOW = new Date('2026-11-16T10:00:00Z');
const HOUR = 3_600_000;
const PASSED = 'Rozsyłka została już przekazana do Multiinfo, które nie pozwala jej anulować.';

let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof buildApiServer>;
let deps: ReturnType<typeof integrationDeps> & { packages: PackagesRepo; jobs: JobsRepo; accounts: AccountsRepo; apiKeys: ApiKeysRepo };
let keyA: string;
let keyB: string;
let keyPa: string;
let keyLimit: string;
let accountId: number;
let paKeyId: number;
let limitKeyId: number;

beforeEach(async () => {
  db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  accountId = accounts.insert({
    name: 'Serwis Północ', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: 'serwis_api', password: 'tajne', certPem: 'CERT', keyPem: 'KEY', caPem: null,
    certCn: 'serwis_api', certIssuerCn: 'Plus MultiInfo CA', certFingerprintSha1: 'AA:BB',
    certNotBefore: '2026-01-01', certNotAfter: '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Serwis', storeContent: 1, serviceIds: ['24138'], origs: ['Serwis'],
  });
  const key = (name: string, extra: { webhookUrl?: string; integrationsOnly?: 0 | 1; ratePerMin?: number } = {}) => {
    const k = generateApiKey();
    const id = apiKeys.insert({
      accountId, name, keyHash: k.hash, keyPrefix: k.prefix, defaultServiceId: '24138', defaultOrig: null, maxParts: 5,
      ratePerMin: extra.ratePerMin ?? 60, webhookUrl: extra.webhookUrl ?? null, webhookSecret: extra.webhookUrl ? 'sekret' : null,
      serviceIds: ['24138'], integrationsOnly: extra.integrationsOnly ?? 0,
    });
    return { key: k.key, id };
  };
  keyA = key('Dyspozytornia', { webhookUrl: 'https://crm.example/hook' }).key;
  keyB = key('Biuro handlowe').key;
  ({ key: keyPa, id: paKeyId } = key('Power Automate', { integrationsOnly: 1 }));
  ({ key: keyLimit, id: limitKeyId } = key('Flota', { ratePerMin: 1 }));

  const jobs = new JobsRepo(db);
  const packages = new PackagesRepo(db);
  deps = { ...integrationDeps(db, masterKey), packages, jobs, accounts, apiKeys };
  app = buildApiServer({
    ...deps, messages: new MessagesRepo(db), events: new MessageEventsRepo(db),
    clients: {} as never, inbound: new InboundMessagesRepo(db), rateLimiter: new RateLimiter(), now: () => NOW,
  });
  await app.ready();
});

const call = (method: 'GET' | 'POST', url: string, key: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload === undefined ? {} : { payload }) });

/** Rozsyłka z terminem za godzinę, czyli w stanie scheduled. */
async function schedule(key = keyA): Promise<string> {
  const res = await call('POST', '/v1/packages', key, {
    defaultText: 'Przegląd klimatyzacji jutro o 8:00.', startAt: new Date(NOW.getTime() + HOUR).toISOString(),
    recipients: [{ to: '48601000001' }, { to: '48601000002', text: 'Przegląd floty jutro o 9:00.' }],
  });
  expect(res.statusCode).toBe(202);
  expect(res.json().status).toBe('scheduled');
  return res.json().id as string;
}

const cancel = (id: string, key = keyA) => call('POST', `/v1/packages/${id}/cancel`, key);
const packageWebhooks = () => deps.deliveries.listRecent(10).map((d) => JSON.parse(d.payload)).filter((p) => p.event === 'package.completed');

function link(packageId: string, code: string): void {
  const domainId = deps.linkDomains.create({ domain: `l${code}.firma.pl`, displayName: 'Serwis', homeUrl: null, bareLinks: false }, NOW);
  const campaignId = deps.campaigns.open(deps.packages.get(packageId)!.apiKeyId, `przeglad-${code}`, NOW);
  deps.shortLinks.insert({
    code, domainId, apiKeyId: deps.packages.get(packageId)!.apiKeyId, campaignId, target: 'https://firma.pl/przeglad', utm: 0,
    recipientKey: `${packageId}#1`, messageId: null, packageId, seq: 1, dest: '48601000001', clientId: null,
    expiresAt: new Date(NOW.getTime() + 30 * 24 * HOUR).toISOString(), purgeAfter: new Date(NOW.getTime() + 60 * 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
  });
}

describe('POST /v1/packages/{id}/cancel', () => {
  it('200 cancelled; drugie wywołanie ten sam wynik bez drugiego webhooka', async () => {
    const id = await schedule();
    const first = await cancel(id);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ id, status: 'cancelled' });
    const second = await cancel(id);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ id, status: 'cancelled' });
    expect(packageWebhooks()).toHaveLength(1);
    expect((await call('GET', `/v1/packages/${id}`, keyA)).json().status).toBe('cancelled');
  });

  it('rozsyłka innego klucza: 404 package_not_found', async () => {
    const id = await schedule();
    const res = await cancel(id, keyB);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'package_not_found' });
    expect(deps.packages.get(id)!.status).toBe('scheduled');
  });

  it('rozsyłka open: 409 package_not_cancellable z tekstem ze spec 4.5', async () => {
    const id = await schedule();
    deps.packages.beginHandover(id);
    deps.packages.setCreated(id, '28197391');
    const res = await cancel(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'package_not_cancellable', message: PASSED });
    expect(deps.packages.get(id)!.status).toBe('open');
  });

  it('rozsyłka zakończona: 409 z opisem stanu ostatecznego', async () => {
    const id = await schedule();
    deps.packages.beginHandover(id);
    deps.packages.setCreated(id, '28197391');
    deps.packages.setCompleted(id, NOW);
    const res = await cancel(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'package_not_cancellable', message: notCancellableMessage('completed') });
  });

  it('rozsyłka overdue: anulowanie skuteczne', async () => {
    const id = await schedule();
    expect(deps.packages.markOverdue(new Date(NOW.getTime() + 2 * HOUR)).map((p) => p.id)).toEqual([id]);
    const res = await cancel(id);
    expect(res.statusCode).toBe(200);
    expect(deps.packages.get(id)!.status).toBe('cancelled');
  });

  it('anulowanie: webhook package.completed cancelled, krótkie linki wyłączone, zadanie package.create usunięte, wpis w dzienniku panelu z nazwą klucza', async () => {
    const id = await schedule();
    link(id, 'aB3xK9q');
    expect(deps.jobs.depth()).toBe(1);
    await cancel(id);
    expect(packageWebhooks()).toEqual([expect.objectContaining({ event: 'package.completed', id, recipients: 2, status: 'cancelled' })]);
    expect(deps.shortLinks.get('aB3xK9q')!.disabledAt).toBe(NOW.toISOString());
    expect(deps.jobs.claim(new Date(NOW.getTime() + 2 * HOUR), 10).map((j) => j.type)).toEqual(['webhook']);
    expect(deps.audit.list(10, 0)).toEqual([expect.objectContaining({
      actor: 'klucz Dyspozytornia', action: 'rozsylka.anulowanie', target: `rozsylka:${id}`,
      meta: { stan: 'scheduled', odbiorcy: 2, termin: new Date(NOW.getTime() + HOUR).toISOString() },
    })]);
    expect(deps.packages.get(id)).toMatchObject({ status: 'cancelled', completedAt: NOW.toISOString() });
  });

  it('kody anulowanej rozsyłki pozostają wyłączone po ponownym włączeniu linków kampanii', async () => {
    const id = await schedule();
    link(id, 'aB3xK9q');
    await cancel(id);
    const campaignId = deps.shortLinks.get('aB3xK9q')!.campaignId;
    deps.shortLinks.disableCampaign(campaignId, NOW);
    deps.shortLinks.enableCampaign(campaignId);
    expect(deps.shortLinks.get('aB3xK9q')!.disabledAt).not.toBeNull();
  });

  it('konto bez przechowywania treści: anulowanie usuwa treści rozsyłki', async () => {
    db.prepare('UPDATE accounts SET store_content = 0').run();
    const id = await schedule();
    expect(deps.packages.get(id)!.defaultText).not.toBeNull();
    await cancel(id);
    expect(deps.packages.get(id)!.defaultText).toBeNull();
    expect(deps.packages.recipients(id).map((r) => r.text)).toEqual([null, null]);
  });

  it('konto z przechowywaniem treści: treści zostają', async () => {
    const id = await schedule();
    await cancel(id);
    expect(deps.packages.recipients(id).map((r) => r.text)).toEqual([null, 'Przegląd floty jutro o 9:00.']);
  });

  it('klucz wyłącznie dla integracji anuluje rozsyłkę własnej integracji z Power Automate', async () => {
    const integrationId = deps.integrations.insert({
      name: 'Dyspozytornia', kind: 'power_automate', apiKeyId: paKeyId, serviceId: null, orig: null, preset: 'power-automate',
      enabled: 1, config: defaultPowerAutomateConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    deps.packages.insert({
      id: 'pkg_pa', apiKeyId: paKeyId, accountId, serviceId: '24138', defaultText: 'Awaria pompy P2.', orig: null, costCenter: null,
      startAt: new Date(NOW.getTime() + HOUR).toISOString(), deliveryReport: 1, encoding: 'gsm', multipart: 0,
      createdAt: NOW.toISOString(), status: 'scheduled', integrationId, requestedBy: 'Ewa Nowak',
    }, [{ dest: '48601000001', text: null, clientId: null }]);
    const res = await cancel('pkg_pa', keyPa);
    expect(res.statusCode).toBe(200);
    expect(deps.audit.list(10, 0)[0]).toMatchObject({ actor: 'klucz Power Automate' });
  });

  it('limit żądań klucza obejmuje anulowanie', async () => {
    deps.packages.insert({
      id: 'pkg_flota', apiKeyId: limitKeyId, accountId, serviceId: '24138', defaultText: 'Przegląd floty.', orig: null, costCenter: null,
      startAt: new Date(NOW.getTime() + HOUR).toISOString(), deliveryReport: 1, encoding: 'gsm', multipart: 0,
      createdAt: NOW.toISOString(), status: 'scheduled',
    }, [{ dest: '48601000001', text: null, clientId: null }]);
    expect((await cancel('pkg_flota', keyLimit)).statusCode).toBe(200);
    const limited = await cancel('pkg_flota', keyLimit);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({ code: 'rate_limited' });
  });
});

describe('cancelPackage', () => {
  it('powód anulowania trafia do pola error, a aktor i powód do dziennika panelu', async () => {
    const id = await schedule();
    const result = cancelPackage(deps, deps.packages.get(id)!, NOW, { actor: 'bramka', reason: 'Klucz API rozsyłki został odwołany przed przekazaniem do Multiinfo' });
    expect(result).toEqual({ id, status: 'cancelled' });
    expect(deps.packages.get(id)!.error).toBe('Klucz API rozsyłki został odwołany przed przekazaniem do Multiinfo');
    expect(deps.audit.list(10, 0)[0]).toMatchObject({
      actor: 'bramka', meta: expect.objectContaining({ powod: 'Klucz API rozsyłki został odwołany przed przekazaniem do Multiinfo' }),
    });
  });

  it('rozsyłka przekazana w międzyczasie: 409 według stanu odczytanego po nieudanym przejściu', async () => {
    const id = await schedule();
    const stale = deps.packages.get(id)!;
    deps.packages.beginHandover(id);
    expect(() => cancelPackage(deps, stale, NOW, { actor: 'admin' })).toThrow(notCancellableMessage('queued'));
    expect(packageWebhooks()).toEqual([]);
    expect(deps.audit.list(10, 0)).toEqual([]);
  });

  it('opis stanu: przekazywana dla queued, przekazana dla open i sending, ostateczny dla completed i failed', () => {
    expect(notCancellableMessage('queued')).toBe('Bramka przekazuje rozsyłkę do Multiinfo, dlatego nie można jej już anulować.');
    for (const s of ['open', 'sending'] as const) expect(notCancellableMessage(s)).toBe(PASSED);
    expect(notCancellableMessage('completed')).toBe('Rozsyłka została już zakończona, dlatego nie można jej anulować.');
    expect(notCancellableMessage('failed')).toBe('Rozsyłka zakończyła się błędem, dlatego nie można jej anulować.');
  });
});
