import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { argv, exit, stderr, stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createAdminUser } from '../admin/users.ts';
import { loadEnv } from '../config/env.ts';
import { AdminUsersRepo } from '../store/admin-users.ts';
import { problemUrl } from '../docs-links.ts';
import { isKeyMismatch, verifyMasterKey } from '../startup/key-check.ts';
import { applyMigrations, migrationState, NewerDatabaseError, openDatabaseRaw, type Database } from '../store/db.ts';

/**
 * Baza dla polecenia zakładającego konto. Świeżej bazie zakłada schemat, ale bazy czekającej na
 * zmianę schematu nie rusza: kopię przed taką zmianą zapisuje bramka przy starcie. Odmawia też przy
 * kluczu niepasującym do bazy - nowe konto byłoby jedyną czytelną wartością, a reszta danych
 * pozostałaby nieczytelna, choć bramka uznałaby bazę za zgodną.
 */
export function openAdminDatabase(path: string, masterKey: Buffer): Database {
  const db = openDatabaseRaw(path);
  try {
    const { current, target } = migrationState(db);
    if (current > target) throw new NewerDatabaseError(current, target);
    if (current > 0 && current < target) {
      throw new Error('Baza wymaga aktualizacji schematu. Uruchom najpierw bramkę: przy starcie zapisze kopię bazy '
        + 'i zaktualizuje schemat. Potem wykonaj to polecenie ponownie.');
    }
    applyMigrations(db);
    if (isKeyMismatch(verifyMasterKey(db, masterKey))) {
      throw new Error(`Klucz główny nie pasuje do bazy. Opis i sposób naprawy: ${problemUrl('klucz-glowny')}`);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Hasło z potoku pozwala założyć konto skryptem wdrożeniowym; z terminala pytamy
 * bez wyświetlania wpisywanych znaków, żeby nie zostały na ekranie ani w historii powłoki.
 */
async function readPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const muted = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput: (s: string) => void };
  const answer = new Promise<string>((resolve) => rl.question(prompt, resolve));
  muted._writeToOutput = (s: string) => {
    if (s.includes(prompt)) muted.output.write(prompt);
  };
  const password = await answer;
  rl.close();
  stdout.write('\n');
  return password;
}

async function main(): Promise<void> {
  const login = argv[2];
  if (!login) {
    stderr.write('Użycie: npm run admin:dodaj -- <login>\n');
    exit(2);
  }

  const config = loadEnv();
  let db: Database;
  try {
    db = openAdminDatabase(join(config.dataDir, 'multiinfo-gate.sqlite'), config.masterKey);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  }
  const users = new AdminUsersRepo(db, config.masterKey);

  try {
    const password = await readPassword('Hasło do panelu: ');
    await createAdminUser(users, login, password);
    stdout.write(
      `Konto ${login} założone. Zaloguj się w panelu - pierwsze wejście poprosi o włączenie `
      + 'drugiego składnika i pokaże kody zapasowe.\n',
    );
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  } finally {
    db.close();
  }
}

function startedAsProgram(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsProgram()) await main();
