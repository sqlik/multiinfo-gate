import type { InstallKind } from '../../config/install.ts';
import { problemUrl, REASON_ANCHOR } from '../../docs-links.ts';
import type { StartupReason } from '../../startup/reason.ts';
import { envFile, logSearch, restartCommand } from './commands.ts';
import { esc } from './layout.ts';
import { gate } from './login.ts';

export interface StartupFailure {
  reason: StartupReason;
  /** Identyfikator wpisu `bramka.awaria_startu` w dzienniku. */
  id: string;
}

interface Explanation {
  headline: string;
  /** Co się stało i co to oznacza, akapity HTML. */
  about: string;
  /** Co zrobić, akapity i polecenia HTML. */
  steps: string;
}

const pre = (lines: string[]) => `<pre class="m cmd">${esc(lines.join('\n'))}</pre>`;

function explain(reason: StartupReason, install: InstallKind | null): Explanation {
  const env = envFile(install);
  switch (reason) {
    case 'key_mismatch':
      return {
        headline: 'Klucz główny nie pasuje do bazy danych',
        about: `<p>Bramka szyfruje hasła, certyfikaty i sekrety kluczem głównym z pliku ${env}. Żadnego
          z zapisanych sekretów nie można odszyfrować bieżącym kluczem. Najczęstszą przyczyną jest nadpisanie
          pliku nowym kluczem, na przykład przez ponowne wykonanie polecenia z instalacji.</p>`,
        steps: `<p>Wpisz w pliku ${env} poprzedni klucz, na przykład z menedżera haseł. Kopie bazy są
          zaszyfrowane tym samym kluczem, dlatego bez niego nie pomogą.</p>
          <p>Jeżeli poprzedniego klucza nie ma, bazę trzeba założyć od nowa. Sposób opisuje dokumentacja.</p>`,
      };
    case 'key_invalid':
      return {
        headline: 'Brak klucza głównego albo klucz ma nieprawidłową postać',
        about: `<p>Wartość <code>MIG_MASTER_KEY</code> w pliku ${env} musi mieć 44 znaki w zapisie base64
          i kończyć się znakiem <code>=</code>. Najczęstsze przyczyny to obcięta wartość, dodatkowa spacja
          albo cudzysłów.</p>`,
        steps: `<p>Popraw wiersz w pliku ${env}. Poprawny wiersz ma postać <code>MIG_MASTER_KEY=</code>
          i 44 znaki bez spacji.</p>`,
      };
    case 'backup_failed':
      return {
        headline: 'Nie udało się zapisać kopii bazy przed aktualizacją',
        about: `<p>Nowe wydanie zmienia schemat bazy. Przed zmianą bramka zapisuje kopię w katalogu
          <code>backups</code>. Zapis się nie powiódł, dlatego schemat pozostał bez zmian. Najczęstszą
          przyczyną jest brak miejsca na dysku.</p>`,
        steps: `<p>Sprawdź wolne miejsce na serwerze:</p>${pre(['df -h'])}
          ${install === 'lxc' ? '' : '<p>W Dockerze obrazy poprzednich wersji usuwa polecenie:</p>' + pre(['docker image prune'])}`,
      };
    case 'newer_database':
      return {
        headline: 'Baza pochodzi z nowszego wydania bramki',
        about: `<p>Schemat bazy został zmieniony przez wydanie nowsze niż uruchomione. Dzieje się tak po
          powrocie do poprzedniej wersji bez przywrócenia kopii. Bramka nie zmienia takiej bazy.</p>`,
        steps: `<p>Uruchom ponownie nowsze wydanie albo przywróć kopię
          <code>przed-aktualizacja-&lt;WERSJA&gt;.sqlite</code> z katalogu <code>backups</code>. Sposób
          przywrócenia kopii opisuje dokumentacja.</p>`,
      };
    case 'disk_full':
      return {
        headline: 'Brak miejsca na dysku',
        about: '<p>Bramka nie może zapisać danych, ponieważ na dysku serwera zabrakło miejsca.</p>',
        steps: `<p>Sprawdź wolne miejsce na serwerze:</p>${pre(['df -h'])}
          ${install === 'lxc' ? '' : '<p>W Dockerze obrazy poprzednich wersji usuwa polecenie:</p>' + pre(['docker image prune'])}`,
      };
    case 'permissions':
      return {
        headline: 'Brak uprawnień do bazy danych',
        about: `<p>Proces bramki nie ma prawa zapisu do pliku bazy albo do katalogu danych. Najczęstszą
          przyczyną jest plik bazy przywrócony z kopii z konta <code>root</code> bez zmiany właściciela.</p>`,
        steps: `<p>Przywróć właściciela plików bramki:</p>${permissionsFix(install)}`,
      };
    case 'corrupt':
      return {
        headline: 'Plik bazy danych jest nieczytelny',
        about: '<p>Plik bazy jest uszkodzony albo nie jest bazą danych bramki.</p>',
        steps: `<p>Przywróć najnowszą kopię z katalogu <code>backups</code>. Sposób przywrócenia kopii
          opisuje dokumentacja.</p>`,
      };
    case 'migration_failed':
      return {
        headline: 'Aktualizacja schematu bazy nie powiodła się',
        about: `<p>Nowe wydanie zmienia schemat bazy. Zmiana została przerwana i wycofana, dlatego baza
          pozostała w poprzedniej postaci.</p>`,
        steps: `<p>Wróć do poprzedniej wersji bramki według dokumentacji i zgłoś problem. Do zgłoszenia
          dołącz identyfikator z tej strony.</p>`,
      };
    case 'unknown':
      return {
        headline: 'Wystąpił nieoczekiwany błąd podczas uruchamiania',
        about: '<p>Przyczyny nie udało się rozpoznać automatycznie. Szczegóły zawiera wpis w dzienniku bramki.</p>',
        steps: `<p>Odszukaj wpis poleceniem z sekcji niżej. Najczęstsze przyczyny i sposób zgłoszenia
          problemu opisuje dokumentacja.</p>`,
      };
  }
}

function permissionsFix(install: InstallKind | null): string {
  const docker = ['cd ~/multiinfo-gate/docker', 'docker compose run --rm --user root multiinfo-gate chown -R node:node /data'];
  const lxc = ['chown -R multiinfo-gate:multiinfo-gate /var/lib/multiinfo-gate'];
  if (install === 'docker') return pre(docker);
  if (install === 'lxc') return pre(lxc);
  return `<p class="sub">Docker</p>${pre(docker)}<p class="sub">Kontener LXC na Proxmoxie</p>${pre(lxc)}`;
}

/**
 * Strona podawana na każdą ścieżkę panelu, gdy bramka nie rozpoczęła pracy. Bez treści wyjątku,
 * nazw kont i fragmentów klucza: strona jest dostępna bez logowania.
 */
export function emergencyPage(failure: StartupFailure, install: InstallKind | null): string {
  const e = explain(failure.reason, install);
  return gate('Bramka nie rozpoczęła pracy', `<div class="help-body">
    <h1>Bramka nie rozpoczęła pracy</h1>
    <div class="warn">${esc(e.headline)}</div>
    <p>Panel i API są niedostępne. Bramka nie wysyła ani nie odbiera wiadomości.</p>
    ${e.about}
    <h2>Co zrobić</h2>
    ${e.steps}
    <p>Po usunięciu przyczyny uruchom bramkę ponownie:</p>
    ${restartCommand(install)}
    <h2>Wpis w dzienniku</h2>
    <p>Identyfikator zdarzenia: <code>${esc(failure.id)}</code>. Wpis odnajduje polecenie:</p>
    ${logSearch(install, failure.id)}
    <p><a href="${esc(problemUrl(REASON_ANCHOR[failure.reason]))}">Opis tego przypadku w dokumentacji</a></p>
  </div>`, 'help');
}
