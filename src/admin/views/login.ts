import { esc } from './layout.ts';

/** Ekran logowania stoi poza ramą panelu - bez szyny nawigacji i bez liczników. */
export function gate(title: string, inner: string, wide = false): string {
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Multiinfo Gate</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="gate">
  <div class="gate-card${wide ? ' wide' : ''}">
    <div class="gate-brand">Multiinfo<span> / </span>Gate</div>
    ${inner}
  </div>
</div>
</body>
</html>`;
}

const warning = (message: string | null) => (message === null ? '' : `<div class="warn">${esc(message)}</div>`);

export function loginPage(error: string | null = null): string {
  return gate('Logowanie', `${warning(error)}
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
    </form>`);
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
    <p class="sub">Kod zapasowy wpisz w to samo pole.</p>`);
}
