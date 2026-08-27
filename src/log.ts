export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];

export type LogFields = Record<string, unknown>;

export interface Logger {
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
}

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/**
 * Wyjątek zapisujemy jako nazwę i komunikat. Stos wywołań zawiera ścieżki
 * z serwera, a komunikaty Multiinfo i tak nie niosą poświadczeń - te idą
 * w treści żądania, nie w adresie.
 */
function plain(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

/**
 * Jeden wiersz JSON na zdarzenie, na standardowe wyjście. Docker i systemd
 * zbierają je bez dodatkowej konfiguracji. Do dziennika nigdy nie trafia treść
 * wiadomości, hasło, klucz prywatny ani pełny klucz API - wywołujący podaje
 * wyłącznie identyfikatory i kody.
 */
export function createLogger(
  level: LogLevel,
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  const threshold = RANK[level];
  const write = (entryLevel: LogLevel, msg: string, fields: LogFields | undefined) => {
    if (RANK[entryLevel] > threshold) return;
    const entry: Record<string, unknown> = { at: now().toISOString(), level: entryLevel, msg };
    for (const [key, value] of Object.entries(fields ?? {})) entry[key] = plain(value);
    sink(JSON.stringify(entry));
  };
  return {
    error: (msg, fields) => write('error', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    debug: (msg, fields) => write('debug', msg, fields),
  };
}

/** Logger, który nic nie robi - dla testów i dla modułów bez wstrzykniętego dziennika. */
export const silentLogger: Logger = createLogger('silent', () => {});
