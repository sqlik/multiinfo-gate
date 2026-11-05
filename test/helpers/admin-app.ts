import { randomBytes } from 'node:crypto';
import type { CertificateView } from '../../src/multiinfo/client.ts';
import { authenticator } from 'otplib';
import { buildAdminServer } from '../../src/admin/server.ts';
import { SessionStore, hashPassword } from '../../src/admin/session.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { AdminUsersRepo } from '../../src/store/admin-users.ts';
import { AuditRepo } from '../../src/store/audit.ts';
import { WebhookDeliveriesRepo } from '../../src/store/webhook-deliveries.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { InboundServicesRepo } from '../../src/store/inbound-services.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { MailInRepo } from '../../src/store/mail-in.ts';
import { NotificationsRepo } from '../../src/store/notifications.ts';
import { SettingsRepo } from '../../src/store/settings.ts';
import { M365AccountsRepo } from '../../src/store/m365-accounts.ts';
import { M365Service } from '../../src/m365/service.ts';
import { M365Tokens } from '../../src/m365/tokens.ts';
import type { TokenFetch } from '../../src/m365/oauth.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import type { NotificationEvent } from '../../src/notifications/rules.ts';
import type { MailContent, MailerSettings } from '../../src/worker/mail.ts';
import { FakeMailbox, fakeConnect } from './fake-mailbox.ts';
import { linkDeps } from './api-deps.ts';
import { DomainChecks } from '../../src/links/domain-checks.ts';
import type { InstallKind } from '../../src/config/install.ts';
import type { Logger } from '../../src/log.ts';

export interface AdminHarness {
  app: ReturnType<typeof buildAdminServer>;
  db: ReturnType<typeof openDatabase>;
  accounts: AccountsRepo;
  apiKeys: ApiKeysRepo;
  messages: MessagesRepo;
  events: MessageEventsRepo;
  jobs: JobsRepo;
  users: AdminUsersRepo;
  audit: AuditRepo;
  deliveries: WebhookDeliveriesRepo;
  packages: PackagesRepo;
  inbound: InboundMessagesRepo;
  inboundServices: InboundServicesRepo;
  integrations: IntegrationsRepo;
  integrationEvents: IntegrationEventsRepo;
  guards: IntegrationGuardsRepo;
  mailIn: MailInRepo;
  /** Repozytoria skracacza: domeny, kampanie i kody. */
  linkDomains: ReturnType<typeof linkDeps>['linkDomains'];
  campaigns: ReturnType<typeof linkDeps>['campaigns'];
  shortLinks: ReturnType<typeof linkDeps>['shortLinks'];
  /** Tokeny sprawdzenia domeny i podmienne pobranie tokenu (domyślnie 404); nazwę rozwiązuje `resolve`. */
  domainChecks: DomainChecks;
  domainNet: { fetch: typeof fetch };
  /** Podróbka skrzynki pocztowej do „Sprawdź połączenie”; hasło TajneHaslo9, UIDVALIDITY 7. */
  mailbox: FakeMailbox;
  notifications: NotificationsRepo;
  settings: SettingsRepo;
  m365Accounts: M365AccountsRepo;
  m365: M365Service;
  /** Formularze wysłane do atrapy punktu tokenów Microsoftu i odpowiedź, jaką atrapa zwraca. */
  m365Forms: URLSearchParams[];
  m365Reply: { value: { status: number; body: unknown } };
  /** Powiadomienia zgłoszone przez trasy panelu - atrapa notifiera. */
  notified: Array<{ event: NotificationEvent; subjectKey: string | null; summary: string }>;
  /** Maile wysłane przez panel (mail testowy) i wynik, jaki atrapa ma zwrócić. */
  mails: MailContent[];
  /** Ustawienia przekazane mailerowi przy każdej wysyłce, w kolejności wywołań. */
  mailSettings: MailerSettings[];
  mailError: Error | null;
  /** Wywołania `receiver.refresh()` z tras panelu - atrapa odbiornika. */
  refreshed: Array<{ retryAccount?: number }>;
  sessions: SessionStore;
  userId: number;
  masterKey: Buffer;
  cookie: string;
  totpSecret: string;
  probe: ProbeStub;
  invalidated: number[];
  /** Podmienny resolver nazw dla adresów webhooków; domyślnie każdą nazwę zwraca jako adres publiczny. */
  resolve: { value: (hostname: string) => Promise<string[]> };
}

interface ProbeStub {
  result: { ok: true } | { ok: false; code: number; message: string };
  calls: number;
  /** Co zwraca strona test.aspx; Error oznacza błąd sieci przy tym drugim zapytaniu. */
  certificate: CertificateView | Error;
}

function makeProbeStub(): ProbeStub {
  return {
    result: { ok: true },
    calls: 0,
    certificate: {
      seen: true,
      subject: 'C=PL, O=Polkomtel, CN=firma_test',
      subjectCn: 'firma_test',
      issuer: 'C=PL, O=Grupa Polsat, CN=GCP Signing CA',
      issuerCn: 'GCP Signing CA',
      validTo: '2028-04-19 13:01:04',
    },
  };
}

/**
 * Buduje panel z zalogowaną sesją i atrapą puli klientów Multiinfo.
 * Konto ma domyślnie włączony drugi składnik - inaczej panel odsyłałby
 * każde żądanie na ekran jego włączania.
 */
export async function startAdminHarness(
  now = new Date('2026-08-25T10:00:00Z'),
  opts: { totp?: boolean; allowPrivateWebhooks?: boolean; allowPrivateMail?: boolean; log?: Logger; install?: InstallKind | null; nodeVersion?: string; trustedProxies?: string[] } = {},
): Promise<AdminHarness> {
  const masterKey = randomBytes(32);
  const db = openDatabase(':memory:');

  const accounts = new AccountsRepo(db, masterKey);
  const apiKeys = new ApiKeysRepo(db, masterKey);
  const messages = new MessagesRepo(db);
  const events = new MessageEventsRepo(db);
  const jobs = new JobsRepo(db);
  const users = new AdminUsersRepo(db, masterKey);
  const audit = new AuditRepo(db);
  const deliveries = new WebhookDeliveriesRepo(db, masterKey);
  const packages = new PackagesRepo(db);
  const inbound = new InboundMessagesRepo(db);
  const inboundServices = new InboundServicesRepo(db);
  const integrations = new IntegrationsRepo(db, masterKey);
  const integrationEvents = new IntegrationEventsRepo(db, masterKey);
  const guards = new IntegrationGuardsRepo(db);
  const mailIn = new MailInRepo(db);
  const links = linkDeps(db);
  const mailbox = new FakeMailbox({ password: 'TajneHaslo9', uidValidity: 7 });
  const notifications = new NotificationsRepo(db, masterKey);
  const settings = new SettingsRepo(db);
  const notified: AdminHarness['notified'] = [];
  const notifier = { notify: (event: NotificationEvent, subjectKey: string | null, summary: string) => { notified.push({ event, subjectKey, summary }); } };
  const mails: MailContent[] = [];
  const mailSettings: MailerSettings[] = [];
  const harness = { mailError: null as Error | null };
  const refreshed: Array<{ retryAccount?: number }> = [];
  const receiver = { refresh: (o: { retryAccount?: number } = {}) => { refreshed.push(o); } };

  const userId = users.insert('janek', await hashPassword('tajne-haslo'));
  const totpSecret = authenticator.generateSecret();
  if (opts.totp !== false) users.enableTotp(userId, totpSecret, []);
  const sessions = new SessionStore();
  const token = sessions.create(userId);

  const probe = makeProbeStub();
  const invalidated: number[] = [];
  const clients = {
    for: () => ({
      probe: async () => { probe.calls += 1; return probe.result; },
      inspectCertificate: async () => {
        if (probe.certificate instanceof Error) throw probe.certificate;
        return probe.certificate;
      },
    }),
    invalidate: (id: number) => { invalidated.push(id); },
    closeAll: () => {},
  };

  const m365Accounts = new M365AccountsRepo(db, masterKey);
  const m365Forms: URLSearchParams[] = [];
  const m365Reply = { value: m365TokenReply({ oid: M365_OID, preferred_username: 'alarmy@firma.pl' }) };
  const m365Fetch: TokenFetch = async (_url, form) => { m365Forms.push(form); return m365Reply.value; };
  const m365Tokens = new M365Tokens({ accounts: m365Accounts, fetch: m365Fetch, notifier });
  const m365 = new M365Service({ accounts: m365Accounts, tokens: m365Tokens, fetch: m365Fetch, integrations, notifications, audit });

  const resolve = { value: async (_hostname: string) => ['93.184.216.34'] };
  const domainChecks = new DomainChecks();
  const domainNet: AdminHarness['domainNet'] = {
    fetch: (async () => new Response('', { status: 404 })) as typeof fetch,
  };
  const app = buildAdminServer({
    accounts, apiKeys, messages, events, jobs, users, audit, deliveries, packages, inbound, inboundServices, integrations, receiver,
    integrationEvents, guards, mailIn, mailboxConnect: fakeConnect(mailbox), engine: new TemplateEngine(), notifications, settings, notifier,
    m365, m365Accounts, m365Tokens, ...links, domainChecks,
    domainFetch: ((input, init) => domainNet.fetch(input, init)) as typeof fetch,
    mailer: async (settings, mail) => { mailSettings.push(settings); if (harness.mailError) throw harness.mailError; mails.push(mail); },
    clients: clients as never, sessions, masterKey, now: () => now, trustedProxies: opts.trustedProxies ?? [],
    resolve: (hostname) => resolve.value(hostname),
    ...(opts.allowPrivateWebhooks ? { allowPrivateWebhooks: true } : {}),
    ...(opts.allowPrivateMail ? { allowPrivateMail: true } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.install !== undefined ? { install: opts.install } : {}),
    ...(opts.nodeVersion !== undefined ? { nodeVersion: opts.nodeVersion } : {}),
  });
  await app.ready();

  return {
    app, db, accounts, apiKeys, messages, events, jobs, users, audit, deliveries, packages, inbound, inboundServices, integrations, refreshed,
    integrationEvents, guards, mailIn, ...links, mailbox, notifications, settings, notified, mails, mailSettings, m365Accounts, m365, m365Forms, m365Reply,
    get mailError() { return harness.mailError; },
    set mailError(e: Error | null) { harness.mailError = e; },
    sessions, userId, masterKey,
    cookie: `mig_session=${token}`, totpSecret, probe, invalidated, resolve, domainChecks, domainNet,
  };
}

/** Identyfikator `oid` skrzynki bramki w odpowiedzi atrapy punktu tokenów. */
export const M365_OID = 'aaaaaaaa-0000-1111-2222-333344445555';

/** Odpowiedź punktu tokenów Microsoftu z `id_token` zawierającym podane roszczenia. */
export function m365TokenReply(claims: Record<string, unknown>): { status: number; body: unknown } {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return {
    status: 200,
    body: {
      token_type: 'Bearer', expires_in: 3600, access_token: 'token-dostepu-1', refresh_token: 'token-odswiezania-1',
      id_token: `${part({ alg: 'RS256' })}.${part(claims)}.`,
    },
  };
}

/** Zakłada konto z certyfikatem zastępczym, gotowe do testów panelu. */
export function seedAccount(h: AdminHarness, patch: Partial<{ name: string; login: string; notAfter: string; storeContent: 0 | 1; origs: string[] }> = {}): number {
  return h.accounts.insert({
    name: patch.name ?? 'Firma Info',
    baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
    login: patch.login ?? 'firma_api',
    password: 'tajne-multiinfo',
    certPem: '-----BEGIN CERTIFICATE-----\nSTARE\n-----END CERTIFICATE-----\n',
    keyPem: '-----BEGIN PRIVATE KEY-----\nSTARE\n-----END PRIVATE KEY-----\n',
    caPem: null,
    certCn: patch.login ?? 'firma_api', certIssuerCn: 'Plus MultiInfo CA',
    certFingerprintSha1: 'AA:BB:CC', certNotBefore: '2026-01-01',
    certNotAfter: patch.notAfter ?? '2027-03-14',
    defaultCountryCode: '48', defaultOrig: 'Firma Info',
    storeContent: patch.storeContent ?? 1, serviceIds: ['24138'],
    origs: patch.origs ?? ['Firma Info'],
  });
}
