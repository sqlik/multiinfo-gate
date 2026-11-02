import type { InstallKind } from '../../config/install.ts';
import { problemUrl } from '../../docs-links.ts';
import { addAdminCommand } from './commands.ts';
import { esc } from './layout.ts';
import { FAVICON_LINK } from './favicon.ts';

/**
 * Ekran logowania stoi poza ramą panelu - bez szyny nawigacji i bez liczników. W tej samej ramie
 * stoją strony pomocy (`help`): awaria startu, błąd panelu - nie mogą zależeć od bazy ani układu panelu.
 */
export function gate(title: string, inner: string, wide: boolean | 'help' = false): string {
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Multiinfo Gate</title>
<link rel="stylesheet" href="/style.css">
${FAVICON_LINK}
</head>
<body>
<div class="gate">
  <div class="gate-card${wide === 'help' ? ' help' : wide ? ' wide' : ''}">
    <div class="gate-brand">Multiinfo<span> / </span>Gate</div>
    ${inner}
  </div>
</div>
</body>
</html>`;
}

const warning = (message: string | null) => (message === null ? '' : `<div class="warn">${esc(message)}</div>`);

/**
 * Przy pustej tabeli kont: bramka nie ma konta domyślnego, a pierwsze zakłada się na serwerze.
 * Bez tej podpowiedzi administrator próbował admin/admin i nie wiedział, gdzie szukać przyczyny.
 */
function firstAccountHint(install: InstallKind | null): string {
  return `<div class="help-body">
    <p>W bazie nie ma jeszcze żadnego konta panelu. Bramka nie ma konta domyślnego. Pierwsze konto
       zakłada się poleceniem na serwerze:</p>
    ${addAdminCommand(install)}
    <p class="sub"><a href="${esc(problemUrl('pierwsze-konto'))}">Opis w dokumentacji</a></p>
  </div>`;
}

export function loginPage(error: string | null = null, firstAccount: { install: InstallKind | null } | null = null): string {
  return gate('Logowanie', `${warning(error)}${firstAccount ? firstAccountHint(firstAccount.install) : ''}
    <form method="post" action="/zaloguj">
      <div class="field">
        <label for="login">Login</label>
        <input id="login" name="login" autocomplete="username" autofocus required>
      </div>
      <div class="field">
        <label for="haslo">Hasło</label>
        <input id="haslo" name="haslo" type="password" autocomplete="current-password" required>
      </div>
      <button class="btn btn-p" type="submit">Dalej</button>
    </form>`, firstAccount ? 'help' : false);
}

export function totpPage(error: string | null = null): string {
  return gate('Kod jednorazowy', `${warning(error)}
    <form method="post" action="/zaloguj/kod">
      <div class="field">
        <label for="kod">Kod z aplikacji</label>
        <input id="kod" name="kod" class="code" inputmode="numeric" autocomplete="one-time-code"
               maxlength="14" autofocus required>
      </div>
      <button class="btn btn-p" type="submit">Zaloguj</button>
    </form>
    <p class="sub">Kod zapasowy wpisz w to samo pole</p>`);
}
