import { esc } from './layout.ts';
import { gate } from './login.ts';

/** Sekret przepisuje się z ekranu ręcznie, więc rozbijamy go na czwórki znaków. */
function grouped(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

export function totpSetupPage(opts: { secret: string; otpauth: string; qr: string; error?: string | null }): string {
  const warning = opts.error ? `<div class="warn">${esc(opts.error)}</div>` : '';
  return gate('Drugi składnik', `${warning}
    <p class="sub setup-lead">Panel wpuszcza dopiero po włączeniu kodów jednorazowych.
       Zeskanuj kod aplikacją uwierzytelniającą albo przepisz sekret.</p>
    <div class="qr">${opts.qr}</div>
    <div class="secret" data-sekret="${esc(opts.secret)}">${esc(grouped(opts.secret))}</div>
    <p class="sub"><a href="${esc(opts.otpauth)}">Otwórz w aplikacji na tym urządzeniu</a></p>
    <form method="post" action="/drugi-skladnik">
      <div class="field">
        <label for="kod">Kod z aplikacji</label>
        <input id="kod" name="kod" class="code" inputmode="numeric" autocomplete="one-time-code"
               maxlength="6" autofocus required>
      </div>
      <button class="btn btn-p" type="submit">Włącz</button>
    </form>
    <p class="sub"><a href="/wyloguj">Wyloguj</a></p>`, true);
}

export function recoveryCodesPage(codes: string[]): string {
  const items = codes.map((code) => `<li class="code">${esc(code)}</li>`).join('');
  return gate('Kody zapasowe', `
    <p class="sub setup-lead">Drugi składnik jest włączony. Poniższe kody zastępują aplikację,
       gdy telefon jest niedostępny - każdy działa jeden raz. Panel nie pokaże ich ponownie.</p>
    <ul class="codes">${items}</ul>
    <a class="btn btn-p" href="/przeglad">Przejdź do panelu</a>`, true);
}
