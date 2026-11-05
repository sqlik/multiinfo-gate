import { M365_DOCS_URL } from '../../docs-links.ts';
import { hintFor } from '../../m365/oauth.ts';
import type { M365User } from '../../m365/service.ts';
import type { M365AccountRow, M365State } from '../../store/m365-accounts.ts';
import { warsawStamp } from '../../time/warsaw.ts';
import { FAVICON_LINK } from './favicon.ts';
import { esc } from './layout.ts';

export interface M365AccountView { row: M365AccountRow; users: M365User[] }

export interface M365FormValues { name: string; tenant: string; clientId: string }

const STATES: Record<M365State, { label: string; tone: 'ok' | 'fail' | 'wait' | 'dim' }> = {
  new: { label: 'Niezalogowane', tone: 'dim' },
  connected: { label: 'Połączone', tone: 'ok' },
  needs_login: { label: 'Wymaga logowania', tone: 'fail' },
  error: { label: 'Błąd połączenia', tone: 'wait' },
};

function statePill(state: M365State): string {
  const s = STATES[state];
  return `<span class="pill"><span class="dot dot-${s.tone}"></span>${esc(s.label)}</span>`;
}

/** „1 integracja”, „3 integracje”, „5 integracji”. */
export function integrationCount(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (n === 1) return '1 integracja';
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return `${n} integracje`;
  return `${n} integracji`;
}

/** Odbiorcy w jednej komórce listy: liczba skrzynek Mail2SMS i ustawienia SMTP powiadomień. */
function usersSummary(users: M365User[]): string {
  const integrations = users.filter((u) => u.kind === 'integration').length;
  const parts = [
    ...(integrations > 0 ? [integrationCount(integrations)] : []),
    ...(users.some((u) => u.kind === 'smtp') ? ['powiadomienia'] : []),
  ];
  return parts.length === 0 ? '<span class="dim">brak</span>' : esc(parts.join(', '));
}

const stamp = (iso: string | null) => (iso === null ? '<span class="dim">brak</span>' : esc(warsawStamp(iso)));

/** Konto, które było już kiedyś zalogowane, loguje się „ponownie”; nowe po raz pierwszy. */
const loginLabel = (row: M365AccountRow) =>
  (row.connectedAt === null && row.loginName === null && row.loginOid === null ? 'Zaloguj w Microsoft' : 'Zaloguj ponownie');

export function m365ListPage(views: M365AccountView[]): string {
  const rows = views.length === 0
    ? '<tr><td class="dim" colspan="6">Brak kont Microsoft 365. Dodaj konto techniczne, aby Mail2SMS odczytywał skrzynkę w Microsoft 365 albo bramka wysyłała przez nie maile powiadomień.</td></tr>'
    : views.map((v) => `<tr>
      <td><strong>${esc(v.row.name)}</strong></td>
      <td class="m">${v.row.address === null ? '<span class="dim">brak</span>' : esc(v.row.address)}</td>
      <td>${statePill(v.row.state)}</td>
      <td class="m">${stamp(v.row.lastRefreshAt)}</td>
      <td>${usersSummary(v.users)}</td>
      <td class="row-actions"><a href="/microsoft-365/${esc(v.row.id)}">Otwórz</a></td>
    </tr>`).join('');

  return `<div class="head">
    <div>
      <h1 class="h1">Konta Microsoft 365</h1>
      <p class="sub">Konta techniczne, przez które bramka odczytuje skrzynki Mail2SMS i wysyła maile powiadomień</p>
    </div>
    <a class="btn btn-p" href="/microsoft-365/nowe">Dodaj konto</a>
  </div>
  <div class="scroll">
    <div class="panel">
      <table>
        <tr>
          <th style="width: 180px;">Konto</th>
          <th style="width: 230px;">Adres skrzynki</th>
          <th style="width: 170px;">Stan</th>
          <th style="width: 170px;">Ostatnie odświeżenie</th>
          <th>Odbiorcy</th>
          <th></th>
        </tr>
        ${rows}
      </table>
    </div>
  </div>`;
}

/** Kroki 1-7 przygotowania po stronie Microsoftu (spec 3), zwinięte nad polami formularza. */
function instructions(): string {
  return `<details>
      <summary>Przygotowanie w Microsoft 365 i Entra ID</summary>
      <div class="guide" style="font-size: 12.5px; line-height: 1.55; padding-bottom: 10px;">
        <p>Przed dodaniem konta wykonaj w portalach Microsoftu poniższe kroki albo przekaż je administratorowi Microsoft 365:</p>
        <ol style="margin: 0 0 8px; padding-left: 18px;">
          <li>W centrum administracyjnym Microsoft 365 załóż konto techniczne z licencją obejmującą skrzynkę, na przykład alarmy@firma.pl</li>
          <li>W ustawieniach tego konta, na karcie Poczta, w zarządzaniu aplikacjami poczty zaznacz IMAP oraz SMTP z uwierzytelnianiem</li>
          <li>W centrum administracyjnym Microsoft Entra, w sekcji Rejestracje aplikacji, zarejestruj aplikację, na przykład „Multiinfo Gate”, z typem kont „Tylko dla jednej dzierżawy”</li>
          <li>W polu „Identyfikator URI przekierowania” wybierz platformę „Klient publiczny/natywny (mobilne i klasyczne)” i wklej adres podany niżej</li>
          <li>Dodaj uprawnienia delegowane IMAP.AccessAsUser.All, SMTP.Send, offline_access, openid, email i profile</li>
          <li>Kliknij „Wyraź zgodę administratora dla katalogu” i potwierdź</li>
          <li>Skopiuj z przeglądu aplikacji identyfikator katalogu i identyfikator aplikacji, a następnie wklej je w polach poniżej</li>
        </ol>
        <p>Pełny opis znajdziesz w <a href="${M365_DOCS_URL}" target="_blank" rel="noopener noreferrer">dokumentacji, w rozdziale 4.8</a>.</p>
      </div>
    </details>`;
}

/** Adres przekierowania tylko do odczytu, z przyciskiem „Kopiuj”. `null`: panel otwarto pod adresem bez poprawnej nazwy hosta. */
function redirectField(redirectUri: string | null): string {
  if (redirectUri === null) {
    return `<div class="field">
        <label>Adres przekierowania</label>
        <div class="warn">Nie można ustalić adresu przekierowania na podstawie adresu, pod którym otwarto panel. Otwórz panel pod jego zwykłym adresem.</div>
      </div>`;
  }
  return `<div class="field">
      <label>Adres przekierowania</label>
      <div class="keyline" style="padding: 0;">
        <div class="keybox" id="redirect-uri">${esc(redirectUri)}</div>
        <button class="btn btn-s" type="button" data-copy="#redirect-uri">Kopiuj</button>
      </div>
      <div class="hint">Ten adres należy dodać w rejestracji aplikacji w kroku 4. Panel tworzy go z adresu, pod którym jest otwarty, dlatego logowanie należy rozpoczynać spod tego samego adresu panelu.</div>
    </div>`;
}

export function m365FormPage(opts: {
  mode: 'new' | 'edit'; id?: number; values: M365FormValues; redirectUri: string | null; error?: string | null;
}): string {
  const v = opts.values;
  const action = opts.mode === 'new' ? '/microsoft-365' : `/microsoft-365/${esc(opts.id)}`;
  const title = opts.mode === 'new' ? 'Nowe konto Microsoft 365' : `Edycja konta ${v.name}`;
  const editNote = opts.mode === 'edit'
    ? '<div class="hint">Zmiana identyfikatora katalogu albo identyfikatora aplikacji rozłącza konto, dlatego po zapisie należy zalogować się ponownie.</div>'
    : '';

  return `<div class="head">
    <div>
      <h1 class="h1">${esc(title)}</h1>
      <p class="sub">Konto techniczne łączy się z bramką przez logowanie w przeglądarce, bez hasła zapisanego w bramce</p>
    </div>
  </div>
  <div class="scroll">
    ${opts.error ? `<div class="warn">${esc(opts.error)}</div>` : ''}
    <div class="panel">
      <form class="form" method="post" action="${action}" autocomplete="off">
        ${instructions()}
        <div class="field">
          <label for="name">Nazwa</label>
          <input id="name" name="name" value="${esc(v.name)}" maxlength="100" required>
          <div class="hint">Nazwa widoczna w panelu, na przykład Dyżur IT</div>
        </div>
        <div class="field">
          <label for="tenant">Identyfikator katalogu</label>
          <input id="tenant" name="tenant" value="${esc(v.tenant)}" required>
          <div class="hint">Identyfikator GUID z przeglądu aplikacji albo nazwa domeny, na przykład firma.onmicrosoft.com</div>
        </div>
        <div class="field">
          <label for="clientId">Identyfikator aplikacji</label>
          <input id="clientId" name="clientId" value="${esc(v.clientId)}" required>
          <div class="hint">Identyfikator GUID z przeglądu rejestracji aplikacji w Entra ID</div>
          ${editNote}
        </div>
        ${redirectField(opts.redirectUri)}
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-p" type="submit" name="action" value="zaloguj">Zapisz i zaloguj w Microsoft</button>
          <button class="btn btn-s" type="submit" name="action" value="zapisz">Zapisz</button>
        </div>
      </form>
    </div>
  </div>`;
}

function userLink(u: M365User): string {
  return u.kind === 'integration'
    ? `<a href="/integracje/${esc(u.id)}">${esc(u.name)}</a> <span class="dim">Mail2SMS</span>`
    : '<a href="/powiadomienia">Powiadomienia</a> <span class="dim">wysyłka maili przez SMTP</span>';
}

/** Pasek stanu nad szczegółami: zerwane logowanie z podpowiedzią albo błąd chwilowy. */
function stateAlert(row: M365AccountRow): string {
  if (row.state === 'needs_login') {
    return `<div class="alert stop" style="margin-bottom: 14px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div class="sq"></div>
          <div>${esc(hintFor(row.errorCode, 'account'))}. Skrzynki Mail2SMS i maile powiadomień korzystające z tego konta czekają na ponowne logowanie.</div>
        </div>
      </div>`;
  }
  if (row.state === 'error') {
    return `<div class="alert" style="margin-bottom: 14px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div class="sq"></div>
          <div>Ostatnie odświeżenie logowania nie powiodło się z powodu błędu sieci albo usługi Microsoftu. Bramka ponowi próbę przy następnym użyciu konta.</div>
        </div>
      </div>`;
  }
  return '';
}

export function m365DetailPage(v: M365AccountView, opts: { redirectUri: string | null }): string {
  const row = v.row;
  const mismatch = row.redirectUri !== null && opts.redirectUri !== null && opts.redirectUri !== row.redirectUri
    ? `<div class="warn">Bieżący adres przekierowania ${esc(opts.redirectUri)} różni się od adresu użytego przy ostatnim logowaniu. Microsoft odrzuci logowanie, jeżeli tego adresu nie ma w rejestracji aplikacji w Entra ID.</div>`
    : '';
  const error = row.errorCode === null && row.errorMessage === null
    ? '<span class="dim">brak</span>'
    // Komunikat z podpowiedzią zaczyna się zwykle od kodu, więc kod przed nim pojawia się tylko wtedy, gdy go tam brak.
    : `${row.errorCode === null || (row.errorMessage ?? '').startsWith(`AADSTS${row.errorCode}`) ? '' : `AADSTS${esc(row.errorCode)} · `}${esc(row.errorMessage ?? '')}`;
  const users = v.users.length === 0
    ? '<div class="dim">Konta nie używa jeszcze żadna skrzynka Mail2SMS ani wysyłka maili powiadomień.</div>'
    : `<ul style="margin: 0; padding-left: 18px;">${v.users.map((u) => `<li>${userLink(u)}</li>`).join('')}</ul>`;
  const disconnect = row.state === 'new' ? '' : `<form method="post" action="/microsoft-365/${esc(row.id)}/rozlacz"
        data-confirm="Rozłączyć konto „${esc(row.name)}”? Skrzynki Mail2SMS korzystające z tego konta zostaną wstrzymane do ponownego logowania, a maile powiadomień nie będą wysyłane." data-confirm-ok="Rozłącz">
        <button class="btn btn-s" type="submit">Rozłącz</button>
      </form>`;

  return `<div class="head">
    <div>
      <h1 class="h1">${esc(row.name)}</h1>
      <p class="sub">Konto Microsoft 365 · ${esc(row.tenant)}</p>
    </div>
    <div style="display: flex; gap: 8px;">
      <a class="btn btn-s" href="/microsoft-365/${esc(row.id)}/edycja">Edytuj</a>
      <form method="post" action="/microsoft-365/${esc(row.id)}/zaloguj">
        <button class="btn btn-p" type="submit">${esc(loginLabel(row))}</button>
      </form>
    </div>
  </div>
  <div class="scroll">
    ${mismatch}
    ${stateAlert(row)}
    <div class="cols">
      <div class="panel">
        <div class="panel-h"><div class="lab">Połączenie</div></div>
        <div class="kv">
          <div>Stan</div><div>${statePill(row.state)}</div>
          <div>Zalogowano jako</div><div class="m">${row.loginName === null ? '<span class="dim">brak</span>' : esc(row.loginName)}</div>
          <div>Adres skrzynki</div><div class="m">${row.address === null ? '<span class="dim">brak</span>' : esc(row.address)}${row.addressManual ? ' <span class="dim">ustawiony ręcznie</span>' : ''}</div>
          <div>Ostatnie logowanie</div><div>${row.connectedAt === null ? '<span class="dim">brak</span>' : `${esc(warsawStamp(row.connectedAt))}${row.connectedBy ? ` <span class="dim">· ${esc(row.connectedBy)}</span>` : ''}`}</div>
          <div>Ostatnie odświeżenie</div><div class="m">${stamp(row.lastRefreshAt)}</div>
          <div>Ostatni błąd</div><div class="m" style="word-break: break-word;">${error}</div>
          <div>Identyfikator katalogu</div><div class="m">${esc(row.tenant)}</div>
          <div>Identyfikator aplikacji</div><div class="m">${esc(row.clientId)}</div>
          <div style="border-bottom: none;">Adres przekierowania</div>
          <div style="border-bottom: none; word-break: break-all;" class="m">${row.redirectUri === null ? '<span class="dim">brak</span>' : esc(row.redirectUri)}</div>
        </div>
      </div>
      <div class="stack">
        <div class="panel">
          <div class="panel-h"><div class="lab">Adres skrzynki</div></div>
          <form class="form" method="post" action="/microsoft-365/${esc(row.id)}/adres">
            <div class="field">
              <label for="address">Adres skrzynki konta</label>
              <input id="address" name="address" value="${esc(row.address ?? '')}" required>
              <div class="hint">Zmiana jest potrzebna, gdy główny adres skrzynki różni się od nazwy logowania. Ponowne logowanie tym samym kontem zachowuje adres ustawiony ręcznie.</div>
            </div>
            <div><button class="btn btn-s" type="submit">Zapisz adres</button></div>
          </form>
        </div>
        <div class="panel">
          <div class="panel-h"><div class="lab">Odbiorcy</div></div>
          <div class="form">${users}</div>
        </div>
        <div class="panel">
          <div class="panel-h"><div class="lab">Rozłączenie i usunięcie</div></div>
          <div class="form">
            <div class="hint">Rozłączenie usuwa token z bramki. Zgodę aplikacji po stronie Microsoftu cofa się w centrum administracyjnym Microsoft Entra. Usunięcie jest możliwe dopiero wtedy, gdy konta nie używa żadna skrzynka Mail2SMS ani wysyłka maili powiadomień.</div>
            <div style="display: flex; gap: 8px;">
              ${disconnect}
              <form method="post" action="/microsoft-365/${esc(row.id)}/usun" data-confirm="Usunąć konto „${esc(row.name)}”?" data-confirm-ok="Usuń">
                <button class="btn btn-s" type="submit">Usuń</button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * Strona pośrednia powrotu z Microsoftu. Ciasteczko sesji panelu ma SameSite=Strict, więc przeglądarka
 * nie dołącza go do przekierowania z domeny Microsoftu. Przejście z tej strony odbywa się już w obrębie
 * panelu i niesie ciasteczko. Strona nie zależy od sesji ani od bazy.
 */
export function m365ReturnPage(target: string): string {
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<title>Logowanie Microsoft 365 - Multiinfo Gate</title>
<link rel="stylesheet" href="/style.css">
${FAVICON_LINK}
</head>
<body>
<div class="gate">
  <div class="gate-card">
    <div class="gate-brand">Multiinfo<span> / </span>Gate</div>
    <p>Logowanie w Microsoft zakończone. Panel bramki kończy łączenie konta.</p>
    <p><a class="btn btn-p" href="${esc(target)}">Kontynuuj</a></p>
  </div>
</div>
</body>
</html>`;
}
