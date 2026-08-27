import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { argv, exit, stderr, stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createAdminUser } from '../admin/users.ts';
import { loadEnv } from '../config/env.ts';
import { AdminUsersRepo } from '../store/admin-users.ts';
import { openDatabase } from '../store/db.ts';

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
  const db = openDatabase(join(config.dataDir, 'multiinfo-gate.sqlite'));
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
