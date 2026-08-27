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
}

function intOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n)) throw new Error(`Wartość nie jest liczbą całkowitą: ${value}`);
  return n;
}

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'tak';
}

function logLevelOr(value: string | undefined, fallback: LogLevel): LogLevel {
  if (value === undefined || value === '') return fallback;
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new Error(`MIG_LOG_LEVEL musi być jednym z: ${LOG_LEVELS.join(', ')}; podano ${value}`);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
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
    apiHost: source.MIG_API_HOST || '0.0.0.0',
    adminHost: source.MIG_ADMIN_HOST || '127.0.0.1',
    dataDir: source.MIG_DATA_DIR ?? '/data',
    logLevel: logLevelOr(source.MIG_LOG_LEVEL, 'info'),
    backupRetentionDays: intOr(source.MIG_BACKUP_RETENTION_DAYS, 14),
    webhookAllowPrivate: flag(source.MIG_WEBHOOK_ALLOW_PRIVATE),
  };
}
