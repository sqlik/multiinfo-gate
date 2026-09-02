import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildAdminServer } from './admin/server.ts';
import { SessionStore } from './admin/session.ts';
import { RateLimiter } from './api/rate-limit.ts';
import { buildApiServer } from './api/server.ts';
import { loadEnv, type AppConfig } from './config/env.ts';
import { Receiver } from './inbound/receiver.ts';
import { SourceMatcher } from './integrations/sources.ts';
import { TemplateEngine } from './integrations/templates.ts';
import { createLogger } from './log.ts';
import { systemResolver } from './net/private-address.ts';
import { AccountsRepo } from './store/accounts.ts';
import { AdminUsersRepo } from './store/admin-users.ts';
import { ApiKeysRepo } from './store/api-keys.ts';
import { AuditRepo } from './store/audit.ts';
import { BackupScheduler } from './store/backup.ts';
import { openDatabase } from './store/db.ts';
import { InboundMessagesRepo } from './store/inbound-messages.ts';
import { InboundServicesRepo } from './store/inbound-services.ts';
import { IntegrationEventsRepo } from './store/integration-events.ts';
import { IntegrationGuardsRepo } from './store/integration-guards.ts';
import { IntegrationsRepo } from './store/integrations.ts';
import { JobsRepo } from './store/jobs.ts';
import { MessageEventsRepo } from './store/message-events.ts';
import { MessagesRepo } from './store/messages.ts';
import { PackagesRepo } from './store/packages.ts';
import { WebhookDeliveriesRepo } from './store/webhook-deliveries.ts';
import { ClientPool } from './worker/clients.ts';
import { Worker } from './worker/loop.ts';

export interface RunningGate {
  apiPort: number;
  adminPort: number;
  apiHost: string;
  adminHost: string;
  stop: () => Promise<void>;
}

export async function startGate(config: AppConfig): Promise<RunningGate> {
  const log = createLogger(config.logLevel);
  const db = openDatabase(join(config.dataDir, 'multiinfo-gate.sqlite'));

  const accounts = new AccountsRepo(db, config.masterKey);
  const apiKeys = new ApiKeysRepo(db, config.masterKey);
  const messages = new MessagesRepo(db);
  const events = new MessageEventsRepo(db);
  const deliveries = new WebhookDeliveriesRepo(db, config.masterKey);
  const packages = new PackagesRepo(db);
  const jobs = new JobsRepo(db);
  const inbound = new InboundMessagesRepo(db);
  const inboundServices = new InboundServicesRepo(db);
  const users = new AdminUsersRepo(db, config.masterKey);
  const audit = new AuditRepo(db);
  const sessions = new SessionStore();
  const clients = new ClientPool(accounts, config.masterKey);
  const integrations = new IntegrationsRepo(db, config.masterKey);
  const integrationEvents = new IntegrationEventsRepo(db, config.masterKey);
  const guards = new IntegrationGuardsRepo(db);
  const engine = new TemplateEngine();

  const backups = new BackupScheduler({
    db, dir: join(config.dataDir, 'backups'), retentionDays: config.backupRetentionDays, log,
  });
  backups.start();

  const worker = new Worker({
    accounts, apiKeys, messages, events, deliveries, packages, jobs, clients, inbound,
    reportsDir: join(config.dataDir, 'reports'), log, allowPrivateWebhooks: config.webhookAllowPrivate,
  });
  worker.start();

  const receiver = new Receiver({
    accounts, apiKeys, inbound, services: inboundServices, messages, deliveries, jobs, clients,
    timeoutMs: config.inboundTimeoutMs, idleMs: config.inboundIdleMs, log,
  });
  receiver.start();

  const api = buildApiServer({
    accounts, apiKeys, messages, events, packages, jobs, clients, inbound, rateLimiter: new RateLimiter(), log,
    inboundHealth: () => receiver.health(),
    integrations, integrationEvents, guards, engine, sources: new SourceMatcher(systemResolver),
    hookLimiter: new RateLimiter(), trustedProxies: config.trustedProxies,
  });
  const admin = buildAdminServer({
    accounts, apiKeys, messages, events, jobs, users, audit, deliveries, packages, sessions, clients,
    inbound, inboundServices, receiver, inboundHealth: () => receiver.health(),
    masterKey: config.masterKey, allowPrivateWebhooks: config.webhookAllowPrivate,
  });

  // Panel domyślnie zostaje na pętli zwrotnej (MIG_ADMIN_HOST); w kontenerze o wystawieniu
  // decyduje dodatkowo mapowanie portów w docker/docker-compose.yml.
  await api.listen({ port: config.apiPort, host: config.apiHost });
  await admin.listen({ port: config.adminPort, host: config.adminHost });

  const portOf = (address: string | { port: number } | null): number =>
    typeof address === 'object' && address !== null ? address.port : 0;

  const running: RunningGate = {
    apiPort: portOf(api.server.address()),
    adminPort: portOf(admin.server.address()),
    apiHost: config.apiHost,
    adminHost: config.adminHost,
    stop: async () => {
      // Odbiornik pierwszy: przerywa long polling, zanim zamkniemy pulę klientów i bazę.
      await receiver.stop();
      backups.stop();
      worker.stop();
      await api.close();
      await admin.close();
      clients.closeAll();
      db.close();
      log.info('bramka.zatrzymana');
    },
  };

  // Same adresy i porty - bez nazw kont, kluczy i ścieżek do sekretów.
  log.info('bramka.start', {
    api: `${running.apiHost}:${running.apiPort}`,
    panel: `${running.adminHost}:${running.adminPort}`,
    queueDepth: jobs.depth(),
    webhookAllowPrivate: config.webhookAllowPrivate,
    inboundTimeoutMs: config.inboundTimeoutMs,
    inboundIdleMs: config.inboundIdleMs,
    trustedProxies: config.trustedProxies.length,
  });
  return running;
}

/** Prawda tylko wtedy, gdy ten plik został uruchomiony jako program, a nie zaimportowany. */
function startedAsProgram(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsProgram()) {
  const config = loadEnv();
  const running = await startGate(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { void running.stop().then(() => process.exit(0)); });
  }
}
