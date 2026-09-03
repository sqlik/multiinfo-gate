import { networkInterfaces } from 'node:os';
import { parseSourceEntry } from '../integrations/sources.ts';
import { LOG_LEVELS, type LogLevel } from '../log.ts';

export class MissingMasterKeyError extends Error {
  constructor(detail: string) {
    super(
      `Brak prawidłowego klucza głównego: ${detail}. ` +
      'Ustaw MIG_MASTER_KEY na 32 bajty zapisane w base64. ' +
      'Bez niego sekrety w bazie są nie do odczytania i proces nie może wystartować.',
    );
    this.name = 'MissingMasterKeyError';
  }
}

export interface AppConfig {
  masterKey: Buffer;
  apiPort: number;
  adminPort: number;
  /** Adres nasłuchu publicznego API. */
  apiHost: string;
  /**
   * Adres nasłuchu panelu. Domyślnie pętla zwrotna: panel ma nie wychodzić poza maszynę,
   * chyba że ktoś świadomie ustawi inaczej - np. w kontenerze, gdzie o wystawieniu
   * decyduje mapowanie portów.
   */
  adminHost: string;
  dataDir: string;
  logLevel: LogLevel;
  backupRetentionDays: number;
  /**
   * Zgoda na webhooki do sieci wewnętrznej (host bramki, sieć kontenerów, sieć firmowa).
   * Domyślnie bramka woła wyłącznie adresy publiczne - inaczej wpis w panelu mógłby
   * posłużyć do stukania w usługi, które z internetu nie są widoczne.
   */
  webhookAllowPrivate: boolean;
  /** Ile ms Multiinfo może trzymać getsms.aspx bez odpowiedzi (1..60000). Domyślnie 10000:
   *  pełne 60000 opóźnia wiadomość nadeszłą między pytaniami nawet o minutę. */
  inboundTimeoutMs: number;
  /** Przerwa po pustej odpowiedzi getsms.aspx; 0 to pytanie od razu. */
  inboundIdleMs: number;
  /**
   * MIG_TRUSTED_PROXIES: adresy odwrotnych proxy (IP albo CIDR, po przecinku), którym wolno podać
   * adres klienta w X-Forwarded-For. Bez listy adresem źródłowym jest adres gniazda.
   */
  trustedProxies: string[];
  /** MIG_UPDATE_CHECK: raz na dobę pytać GitHub o nowsze wydanie; `0` wyłącza. Domyślnie włączone. */
  updateCheck: boolean;
}

function intOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n)) throw new Error(`Wartość nie jest liczbą całkowitą: ${value}`);
  return n;
}

function boundedInt(variable: string, value: string | undefined, fallback: number, min: number, max: number): number {
  const n = intOr(value, fallback);
  if (n < min || n > max) throw new Error(`${variable} musi być w zakresie ${min}..${max}; podano ${n}`);
  return n;
}

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'tak';
}

function proxyList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  const entries = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const e of entries) {
    const parsed = parseSourceEntry(e);
    if (!parsed || parsed.kind === 'host') throw new Error(`MIG_TRUSTED_PROXIES: „${e}” nie jest adresem IP ani zakresem CIDR`);
  }
  return entries;
}

function logLevelOr(value: string | undefined, fallback: LogLevel): LogLevel {
  if (value === undefined || value === '') return fallback;
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new Error(`MIG_LOG_LEVEL musi być jednym z: ${LOG_LEVELS.join(', ')}; podano ${value}`);
}

/** Tyle z os.networkInterfaces(), ile potrzeba do wyboru adresu; osobny typ ułatwia testy. */
export type Interfaces = Record<string, { address: string; family: string; internal: boolean }[] | undefined>;

/**
 * Adres nasłuchu może być nazwą interfejsu (np. `eth0`) - wtedy nasłuch idzie na jego adres
 * IPv4. Potrzebne w kontenerze podłączonym do kilku sieci naraz (wariant Traefika): panel ma
 * być osiągalny z sieci własnej bramki, a niewidoczny z sieci wspólnej z innymi kontenerami.
 * Adresy IP i nazwy hostów przechodzą bez zmian - Docker nadaje interfejsom nazwy eth0, eth1...,
 * które nie kolidują z niczym, co ktoś wpisałby jako host.
 */
function listenAddress(variable: string, value: string, interfaces: Interfaces): string {
  if (!/^[a-z][a-z0-9]*\d$/i.test(value)) return value;
  const entries = interfaces[value];
  if (entries === undefined) {
    throw new Error(`${variable}: interfejs ${value} nie istnieje (dostępne: ${Object.keys(interfaces).join(', ') || 'brak'})`);
  }
  const ipv4 = entries.find((e) => e.family === 'IPv4');
  if (!ipv4) throw new Error(`${variable}: interfejs ${value} nie ma adresu IPv4`);
  return ipv4.address;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env, interfaces: Interfaces = networkInterfaces() as Interfaces): AppConfig {
  const raw = source.MIG_MASTER_KEY;
  if (!raw) throw new MissingMasterKeyError('zmienna MIG_MASTER_KEY nie jest ustawiona');

  const masterKey = Buffer.from(raw, 'base64');
  if (masterKey.length !== 32) {
    throw new MissingMasterKeyError(`oczekiwano 32 bajtów, otrzymano ${masterKey.length}`);
  }

  return {
    masterKey,
    apiPort: intOr(source.MIG_API_PORT, 8080),
    adminPort: intOr(source.MIG_ADMIN_PORT, 8081),
    apiHost: listenAddress('MIG_API_HOST', source.MIG_API_HOST || '0.0.0.0', interfaces),
    adminHost: listenAddress('MIG_ADMIN_HOST', source.MIG_ADMIN_HOST || '127.0.0.1', interfaces),
    dataDir: source.MIG_DATA_DIR ?? '/data',
    logLevel: logLevelOr(source.MIG_LOG_LEVEL, 'info'),
    backupRetentionDays: intOr(source.MIG_BACKUP_RETENTION_DAYS, 14),
    webhookAllowPrivate: flag(source.MIG_WEBHOOK_ALLOW_PRIVATE),
    inboundTimeoutMs: boundedInt('MIG_INBOUND_TIMEOUT_MS', source.MIG_INBOUND_TIMEOUT_MS, 10_000, 1, 60_000),
    inboundIdleMs: boundedInt('MIG_INBOUND_IDLE_MS', source.MIG_INBOUND_IDLE_MS, 0, 0, 3_600_000),
    trustedProxies: proxyList(source.MIG_TRUSTED_PROXIES),
    updateCheck: source.MIG_UPDATE_CHECK === undefined ? true : flag(source.MIG_UPDATE_CHECK),
  };
}
