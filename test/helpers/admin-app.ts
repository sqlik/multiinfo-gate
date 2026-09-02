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
  opts: { totp?: boolean; allowPrivateWebhooks?: boolean } = {},
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

  const resolve = { value: async (_hostname: string) => ['93.184.216.34'] };
  const app = buildAdminServer({
    accounts, apiKeys, messages, events, jobs, users, audit, deliveries, packages, inbound, inboundServices, integrations, receiver,
    clients: clients as never, sessions, masterKey, now: () => now,
    resolve: (hostname) => resolve.value(hostname),
    ...(opts.allowPrivateWebhooks ? { allowPrivateWebhooks: true } : {}),
  });
  await app.ready();

  return {
    app, db, accounts, apiKeys, messages, events, jobs, users, audit, deliveries, packages, inbound, inboundServices, integrations, refreshed,
    sessions, userId, masterKey,
    cookie: `mig_session=${token}`, totpSecret, probe, invalidated, resolve,
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
