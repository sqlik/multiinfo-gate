import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildAdminServer } from './admin/server.ts';
import { nodemailerMailer } from './worker/mail.ts';
import { SessionStore } from './admin/session.ts';
import { RateLimiter } from './api/rate-limit.ts';
import { buildApiServer } from './api/server.ts';
import { loadEnv, MissingMasterKeyError, type AppConfig } from './config/env.ts';
import { detectInstall, type InstallKind } from './config/install.ts';
import { Receiver } from './inbound/receiver.ts';
import { SourceMatcher } from './integrations/sources.ts';
import { TemplateEngine } from './integrations/templates.ts';
import { createLogger, type Logger } from './log.ts';
import { nodeUpdateNeeded, plainVersion, unsupportedLine } from './runtime/node-version.ts';
import { problemUrl } from './docs-links.ts';
import { systemResolver } from './net/private-address.ts';
import { Notifier, subjectNamer } from './notifications/notifier.ts';
import { sendNotificationSms } from './notifications/sms.ts';
import { NotificationScanner } from './notifications/scanner.ts';
import { pendingRelease, ReleaseChecker } from './releases/check.ts';
import { AccountsRepo } from './store/accounts.ts';
import { AdminUsersRepo } from './store/admin-users.ts';
import { ApiKeysRepo } from './store/api-keys.ts';
import { AuditRepo } from './store/audit.ts';
import { BackupScheduler } from './store/backup.ts';
import { applyMigrations, migrationState, NewerDatabaseError, openDatabaseRaw, type Database } from './store/db.ts';
import { InboundMessagesRepo } from './store/inbound-messages.ts';
import { InboundServicesRepo } from './store/inbound-services.ts';
import { IntegrationEventsRepo } from './store/integration-events.ts';
import { IntegrationGuardsRepo } from './store/integration-guards.ts';
import { MailInRepo } from './store/mail-in.ts';
import { imapConnect } from './integrations/mail/client.ts';
import { MailInPoller } from './worker/mail-in.ts';
import { IntegrationsRepo } from './store/integrations.ts';
import { JobsRepo } from './store/jobs.ts';
import { MessageEventsRepo } from './store/message-events.ts';
import { MessagesRepo } from './store/messages.ts';
import { NotificationsRepo } from './store/notifications.ts';
import { M365AccountsRepo } from './store/m365-accounts.ts';
import { fetchToken } from './m365/oauth.ts';
import { M365Service } from './m365/service.ts';
import { M365Tokens } from './m365/tokens.ts';
import { SettingsRepo } from './store/settings.ts';
import { PackagesRepo } from './store/packages.ts';
import { WebhookDeliveriesRepo } from './store/webhook-deliveries.ts';
import { ClientPool } from './worker/clients.ts';
import { Worker } from './worker/loop.ts';
import { newIncidentId, startEmergency } from './startup/emergency.ts';
import { isKeyMismatch, KeyMismatchError, verifyMasterKey } from './startup/key-check.ts';
import { classifyStartupError, isListenError } from './startup/reason.ts';
import type { RunningGate } from './startup/running.ts';
import { backupBeforeUpgrade } from './startup/upgrade-backup.ts';
import { GATE_VERSION } from './version.ts';

export type { RunningGate };

export interface StartOptions {
  /** Wariant instalacji do poleceń na stronach pomocy; domyślnie rozpoznawany z systemu plików. */
  install?: InstallKind | null;
  log?: Logger;
  /** Wersja Node do sprawdzenia poprawek bezpieczeństwa; domyślnie `process.version`. */
  nodeVersion?: string;
}

/**
 * Uruchamia bramkę. Każdy błąd przygotowania bazy albo startu usług, poza zajętym portem,
 * przełącza proces w tryb awaryjny: przeglądarka pokazuje przyczynę zamiast zerwanego połączenia.
 */
export async function startGate(config: AppConfig, opts: StartOptions = {}): Promise<RunningGate> {
  const log = opts.log ?? createLogger(config.logLevel);
  const install = opts.install === undefined ? detectInstall() : opts.install;
  try {
    return await startNormal(config, log, install, opts.nodeVersion ?? process.version);
  } catch (error) {
    if (isListenError(error)) throw error;
    return startEmergency(config, { reason: classifyStartupError(error), id: newIncidentId() }, { install, log, error });
  }
}

/**
 * Wejście programu: konfiguracja ze zmiennych środowiska. Brak klucza albo klucz w złej postaci
 * to też tryb awaryjny - porty i adresy są wtedy odczytywane z zastępczym kluczem, którego tryb
 * awaryjny nie używa, bo nie otwiera bazy.
 */
export async function startFromEnv(env: NodeJS.ProcessEnv = process.env, opts: StartOptions = {}): Promise<RunningGate> {
  let config: AppConfig;
  try {
    config = loadEnv(env);
  } catch (error) {
    if (!(error instanceof MissingMasterKeyError)) throw error;
    const fallback = loadEnv({ ...env, MIG_MASTER_KEY: Buffer.alloc(32).toString('base64') });
    const log = opts.log ?? createLogger(fallback.logLevel);
    const install = opts.install === undefined ? detectInstall() : opts.install;
    return startEmergency(fallback, { reason: 'key_invalid', id: newIncidentId() }, { install, log, error });
  }
  return startGate(config, opts);
}

/**
 * Baza gotowa do pracy: kopia przed aktualizacją, migracje, sprawdzenie klucza. Kolejność ma
 * znaczenie - kopia powstaje przed pierwszą zmianą schematu, a klucz sprawdza się na schemacie bieżącym.
 */
async function prepareDatabase(config: AppConfig, log: Logger): Promise<Database> {
  const db = openDatabaseRaw(join(config.dataDir, 'multiinfo-gate.sqlite'));
  try {
    const { current, target } = migrationState(db);
    if (current > target) throw new NewerDatabaseError(current, target);
    await backupBeforeUpgrade({ db, dir: join(config.dataDir, 'backups'), current: GATE_VERSION, log });
    applyMigrations(db);
    // Świeża baza od razu zna swoją wersję: gdy pierwszy start się nie powiedzie, następny nie
    // potraktuje jej jak bazy z poprzedniego wydania i nie zrobi kopii pustego schematu.
    if (current === 0) new SettingsRepo(db).setGateVersion(GATE_VERSION, new Date());
    const check = verifyMasterKey(db, config.masterKey);
    if (isKeyMismatch(check)) throw new KeyMismatchError(check.unreadableGroups);
    if (check.unreadable > 0) log.warn('klucz.czesc_nieczytelna', { groups: check.unreadableGroups });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function startNormal(config: AppConfig, log: Logger, install: InstallKind | null, nodeVersion: string): Promise<RunningGate> {
  const db = await prepareDatabase(config, log);

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
  const mailIn = new MailInRepo(db);
  const engine = new TemplateEngine();
  const notifications = new NotificationsRepo(db, config.masterKey);
  const settings = new SettingsRepo(db);
  const m365Accounts = new M365AccountsRepo(db, config.masterKey);
  const notifier = new Notifier({
    notifications, jobs, log,
    sms: (text, now) => sendNotificationSms({ accounts, apiKeys, messages, events, jobs, inbound, notifications }, text, now),
    subjectName: subjectNamer({ integrations, accounts, m365Accounts }),
  });
  const m365Tokens = new M365Tokens({ accounts: m365Accounts, fetch: fetchToken, notifier, log });
  const m365 = new M365Service({ accounts: m365Accounts, tokens: m365Tokens, fetch: fetchToken, integrations, notifications, audit });
  const scanner = new NotificationScanner({
    accounts, inboundServices, messages, inbound, integrations, deliveries, notifications, notifier, jobs, log,
    release: () => pendingRelease(settings), mailIn,
  });
  const releases = new ReleaseChecker({ settings, notifier, log, enabled: config.updateCheck });
  const integrationEmit = { integrations, integrationEvents, guards, deliveries, jobs, engine, notifier, log, group: { accounts, apiKeys, messages, events, jobs, inbound } };

  const backups = new BackupScheduler({
    db, dir: join(config.dataDir, 'backups'), retentionDays: config.backupRetentionDays, log,
  });

  const mailInPoller = new MailInPoller({
    accounts, apiKeys, messages, events, jobs, inbound, integrations, integrationEvents, guards, engine,
    mailIn, connect: imapConnect, resolve: systemResolver, allowPrivateMail: config.mailAllowPrivate, notifier, notifications, log,
    m365: { tokens: m365Tokens, accounts: m365Accounts },
  });
  const worker = new Worker({
    accounts, apiKeys, messages, events, deliveries, packages, jobs, clients, inbound,
    reportsDir: join(config.dataDir, 'reports'), log, allowPrivateWebhooks: config.webhookAllowPrivate,
    integrationEmit, integrations, integrationEvents, guards, notifier, notifications, scanner, releases,
    mailIn: mailInPoller, mailInRepo: mailIn, m365: { tokens: m365Tokens, accounts: m365Accounts },
  });

  const receiver = new Receiver({
    accounts, apiKeys, inbound, services: inboundServices, messages, deliveries, jobs, clients,
    timeoutMs: config.inboundTimeoutMs, idleMs: config.inboundIdleMs, log,
    integrations, integrationEmit, notifier,
  });

  const api = buildApiServer({
    accounts, apiKeys, messages, events, packages, jobs, clients, inbound, rateLimiter: new RateLimiter(), log,
    inboundHealth: () => receiver.health(),
    integrations, integrationEvents, guards, engine, sources: new SourceMatcher(systemResolver),
    hookLimiter: new RateLimiter(), trustedProxies: config.trustedProxies, notifier,
    allowPrivateWebhooks: config.webhookAllowPrivate,
  });
  const admin = buildAdminServer({
    accounts, apiKeys, messages, events, jobs, users, audit, deliveries, packages, sessions, clients,
    inbound, inboundServices, integrations, receiver, inboundHealth: () => receiver.health(),
    integrationEvents, guards, mailIn, mailboxConnect: imapConnect, engine, notifications, settings, notifier, mailer: nodemailerMailer,
    masterKey: config.masterKey, allowPrivateWebhooks: config.webhookAllowPrivate, allowPrivateMail: config.mailAllowPrivate,
    log, install, nodeVersion, m365, m365Accounts, m365Tokens,
  });

  // Panel domyślnie zostaje na pętli zwrotnej (MIG_ADMIN_HOST); w kontenerze o wystawieniu
  // decyduje dodatkowo mapowanie portów w docker/docker-compose.yml.
  // Nasłuch i zapis wersji przed usługami w tle: błąd na tym etapie zamyka tylko serwery i bazę.
  try {
    await api.listen({ port: config.apiPort, host: config.apiHost });
    await admin.listen({ port: config.adminPort, host: config.adminHost });
    settings.setGateVersion(GATE_VERSION, new Date());
  } catch (error) {
    await api.close();
    await admin.close();
    clients.closeAll();
    db.close();
    throw error;
  }
  backups.start();
  worker.start();
  receiver.start();

  const portOf = (address: string | { port: number } | null): number =>
    typeof address === 'object' && address !== null ? address.port : 0;

  const running: RunningGate = {
    apiPort: portOf(api.server.address()),
    adminPort: portOf(admin.server.address()),
    apiHost: config.apiHost,
    adminHost: config.adminHost,
    mode: 'normal',
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
  const nodeMinimum = nodeUpdateNeeded(nodeVersion);
  if (nodeMinimum !== null) {
    log.warn('node.bez_poprawek', {
      installed: plainVersion(nodeVersion), minimum: nodeMinimum, unsupportedLine: unsupportedLine(nodeVersion, nodeMinimum), help: problemUrl('wersja-node'),
    });
  }
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
  const running = await startFromEnv();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { void running.stop().then(() => process.exit(0)); });
  }
}
