import type { InstallKind } from '../../config/install.ts';
import { esc } from './layout.ts';

/** Katalog z plikami Compose według instrukcji; polecenia Dockera wykonuje się w nim. */
const COMPOSE_DIR = 'cd ~/multiinfo-gate/docker';

const LXC_SHELL = 'Kontener LXC na Proxmoxie, w powłoce kontenera (pct enter &lt;NUMER-KONTENERA&gt; na hoście)';

const block = (lines: string[]) => `<pre class="m cmd">${esc(lines.join('\n'))}</pre>`;

/** Polecenie dla rozpoznanego wariantu; bez rozpoznania oba, każde z podpisem. */
function variants(install: InstallKind | null, docker: string[], lxc: string[]): string {
  if (install === 'docker') return block(docker);
  if (install === 'lxc') return `<p class="sub">${LXC_SHELL}</p>${block(lxc)}`;
  return `<p class="sub">Docker</p>${block(docker)}<p class="sub">${LXC_SHELL}</p>${block(lxc)}`;
}

/** Wyszukanie wpisu dziennika po identyfikatorze błędu. */
export function logSearch(install: InstallKind | null, id: string): string {
  return variants(install,
    [COMPOSE_DIR, `docker compose logs multiinfo-gate | grep ${id}`],
    [`journalctl -u multiinfo-gate | grep ${id}`]);
}

export function restartCommand(install: InstallKind | null): string {
  // `restart` zostawia zmienne z chwili utworzenia kontenera; po poprawce w .env kontener trzeba utworzyć od nowa.
  return variants(install, [COMPOSE_DIR, 'docker compose up -d --force-recreate'], ['systemctl restart multiinfo-gate']);
}

/** Plik z kluczem głównym jako tekst w `<code>`. */
export function envFile(install: InstallKind | null): string {
  if (install === 'docker') return '<code>~/multiinfo-gate/docker/.env</code>';
  if (install === 'lxc') return '<code>/etc/multiinfo-gate/env</code>';
  return '<code>~/multiinfo-gate/docker/.env</code> (Docker) albo <code>/etc/multiinfo-gate/env</code> (kontener LXC)';
}

/**
 * Pierwsze konto: w Dockerze polecenie z instrukcji; w LXC dane zapisane przez instalator,
 * a dla bazy założonej od nowa polecenie, którym instalator zakłada konto.
 */
export function addAdminCommand(install: InstallKind | null): string {
  return variants(install,
    [COMPOSE_DIR, 'docker compose exec multiinfo-gate npm run admin:dodaj -- <login>'],
    [
      'cat /root/multiinfo-gate.creds',
      '',
      '# baza założona od nowa: konto zakłada polecenie',
      `runuser -u multiinfo-gate -- sh -c 'set -a; . /etc/multiinfo-gate/env; set +a; exec /usr/bin/node /opt/multiinfo-gate/dist/cli/admin.js "$1"' sh <login>`,
    ]);
}
