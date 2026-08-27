import type { AdminUserRow } from '../../store/admin-users.ts';
import { warsawStamp } from '../../time/warsaw.ts';
import { LOGIN_RULE, PASSWORD_RULE } from '../users.ts';
import { esc } from './layout.ts';

function actions(u: AdminUserRow, self: boolean): string {
  const reset = `<form method="post" action="/uzytkownicy/${esc(u.id)}/reset-2fa" style="display: inline;"
        data-confirm="Wyłączyć drugi składnik użytkownika ${esc(u.login)}? Przy następnym logowaniu włączy go od nowa, a otwarte sesje zostaną zamknięte."
        data-confirm-ok="Wyłącz">
        <button class="btn btn-s" type="submit">Reset 2FA</button>
      </form>`;
  if (self) return reset;
  return `${reset}
      <form method="post" action="/uzytkownicy/${esc(u.id)}/usun" style="display: inline;"
        data-confirm="Usunąć użytkownika ${esc(u.login)}? Jego sesje zostaną zamknięte, wpisy w dzienniku zostaną."
        data-confirm-ok="Usuń">
        <button class="btn btn-s" type="submit">Usuń</button>
      </form>`;
}

export function usersPage(rows: AdminUserRow[], currentUserId: number): string {
  const items = rows.map((u) => {
    const self = u.id === currentUserId;
    return `<tr>
      <td><strong>${esc(u.login)}</strong>${self ? ' <span class="tag">to Ty</span>' : ''}</td>
      <td>${u.totpEnabled === 1 ? 'włączony' : '<span class="dim">czeka na pierwsze logowanie</span>'}</td>
      <td class="m">${esc(warsawStamp(u.createdAt))}</td>
      <td class="m">${u.lastLoginAt === null
        ? '<span class="dim" style="font-size: 12px;">jeszcze bez logowania</span>'
        : esc(warsawStamp(u.lastLoginAt))}</td>
      <td class="row-actions">${actions(u, self)}</td>
    </tr>`;
  }).join('');

  return `<div class="head">
    <div>
      <h1 class="h1">Użytkownicy panelu</h1>
      <p class="sub">Każdy użytkownik może wszystko - ról nie ma. Czas polski</p>
    </div>
    <a class="btn btn-p" href="/uzytkownicy/nowy">Dodaj użytkownika</a>
  </div>
  <div class="scroll">
    <div class="panel">
      <div class="panel-h">
        <div class="lab">Użytkownicy</div>
        <div class="m dim">${esc(rows.length)}</div>
      </div>
      <table>
        <tr>
          <th style="width: 220px;">Login</th>
          <th style="width: 220px;">Drugi składnik</th>
          <th style="width: 170px;">Utworzony</th>
          <th style="width: 170px;">Ostatnie logowanie</th>
          <th></th>
        </tr>
        ${items}
      </table>
    </div>
  </div>`;
}

export function newUserPage(error: string | null = null, values: { login: string } = { login: '' }): string {
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/uzytkownicy">Użytkownicy</a> / nowy</div>
      <h1 class="h1">Nowy użytkownik panelu</h1>
      <p class="sub">Hasło startowe przekaż tej osobie osobiście - panel nie pokaże go ponownie</p>
    </div>
  </div>
  <div class="scroll">
    ${error === null ? '' : `<div class="warn">${esc(error)}</div>`}
    <div class="panel" style="max-width: 480px;">
      <form class="form" method="post" action="/uzytkownicy/nowy" autocomplete="off">
        <div class="field">
          <label for="login">Login</label>
          <input id="login" name="login" value="${esc(values.login)}" autocomplete="off" required>
          <div class="hint">${esc(LOGIN_RULE)}</div>
        </div>
        <div class="field">
          <label for="haslo">Hasło startowe</label>
          <input id="haslo" name="haslo" type="password" autocomplete="new-password" required>
          <div class="hint">${esc(PASSWORD_RULE)}; przy pierwszym logowaniu panel poprosi o włączenie drugiego składnika</div>
        </div>
        <div class="field">
          <label for="haslo2">Hasło startowe ponownie</label>
          <input id="haslo2" name="haslo2" type="password" autocomplete="new-password" required>
        </div>
        <div><button class="btn btn-p" type="submit">Dodaj użytkownika</button></div>
      </form>
    </div>
  </div>`;
}

export function passwordPage(error: string | null = null): string {
  return `<div class="head">
    <div>
      <h1 class="h1">Zmiana hasła</h1>
      <p class="sub">Po zapisie pozostałe sesje tego konta zostaną zamknięte, ta zostaje</p>
    </div>
  </div>
  <div class="scroll">
    ${error === null ? '' : `<div class="warn">${esc(error)}</div>`}
    <div class="panel" style="max-width: 480px;">
      <form class="form" method="post" action="/haslo">
        <div class="field">
          <label for="obecne">Obecne hasło</label>
          <input id="obecne" name="obecne" type="password" autocomplete="current-password" required>
        </div>
        <div class="field">
          <label for="nowe">Nowe hasło</label>
          <input id="nowe" name="nowe" type="password" autocomplete="new-password" required>
          <div class="hint">${esc(PASSWORD_RULE)}</div>
        </div>
        <div class="field">
          <label for="nowe2">Nowe hasło ponownie</label>
          <input id="nowe2" name="nowe2" type="password" autocomplete="new-password" required>
        </div>
        <div><button class="btn btn-p" type="submit">Zmień hasło</button></div>
      </form>
    </div>
  </div>`;
}
