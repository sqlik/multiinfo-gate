import type { AccountRow } from '../../store/accounts.ts';
import type { ApiKeyRow } from '../../store/api-keys.ts';
import { lastValidDay, warsawStamp } from '../../time/warsaw.ts';
import { esc } from './layout.ts';

export interface KeyView {
  row: ApiKeyRow;
  accountName: string;
}

/** Ramka pokazywana raz: nowy klucz, nowy sekret webhooka albo oba naraz. */
export interface CreatedKey {
  name: string;
  key: string | null;
  webhookSecret: string | null;
}

export interface AccountChoice {
  row: AccountRow;
  serviceIds: string[];
  origs: string[];
}

/** Pola formularza klucza w postaci tekstowej - tak, jak przychodzą z przeglądarki i wracają do niej po błędzie. */
export interface KeyFormValues {
  name: string; serviceIds: string[]; defaultServiceId: string; origs: string[]; defaultOrig: string;
  maxParts: string; ratePerMin: string; webhookUrl: string; expiresOn: string; noExpiry: boolean;
}

export const NEW_KEY_VALUES = (choice: AccountChoice): KeyFormValues => ({
  name: '', serviceIds: choice.serviceIds, defaultServiceId: choice.serviceIds[0] ?? '', origs: [],
  defaultOrig: '', maxParts: '5', ratePerMin: '60', webhookUrl: '', expiresOn: '', noExpiry: false,
});

export function valuesOf(row: ApiKeyRow): KeyFormValues {
  return {
    name: row.name, serviceIds: row.allowedServiceIds, defaultServiceId: row.defaultServiceId ?? '',
    origs: row.allowedOrigs, defaultOrig: row.defaultOrig ?? '', maxParts: String(row.maxParts),
    ratePerMin: String(row.ratePerMin), webhookUrl: row.webhookUrl ?? '',
    expiresOn: row.expiresAt === null ? '' : lastValidDay(row.expiresAt), noExpiry: row.expiresAt === null,
  };
}

const OSTRZEZENIE =
  'Pokazujemy go wyłącznie teraz. W bazie zostaje sam skrót, więc nie da się go odczytać ' +
  'później - jeśli zginie, wygeneruj nowy i odwołaj ten.';

const OSTRZEZENIE_SEKRET =
  'Sekret podpisuje każde wywołanie webhooka nagłówkiem X-MIG-Signature. Pokazujemy go tylko teraz - ' +
  'zmiana adresu wydaje nowy sekret.';

/** Ile dni przed wygaśnięciem data na liście zmienia kolor na ostrzegawczy. */
const EXPIRY_WARNING_DAYS = 7;

/** Host adresu webhooka - cała ścieżka bywa długa i nic nie wnosi na liście. */
function webhookHost(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Prefiks wystarcza, żeby rozpoznać klucz na liście; reszta wartości nie istnieje poza chwilą utworzenia. */
const shortened = (prefix: string) => `mig_live_${prefix}…`;

function stamp(iso: string | null, fallback: string): string {
  return iso === null ? fallback : warsawStamp(iso);
}

const isExpired = (row: ApiKeyRow, now: Date) =>
  row.expiresAt !== null && Date.parse(row.expiresAt) <= now.getTime();

function expiryCell(row: ApiKeyRow, now: Date): string {
  if (row.expiresAt === null) return '<td class="m dim">-</td>';
  const day = lastValidDay(row.expiresAt);
  const msLeft = Date.parse(row.expiresAt) - now.getTime();
  if (msLeft <= 0) return `<td class="m fail">${esc(day)}</td>`;
  const soon = msLeft <= EXPIRY_WARNING_DAYS * 86_400_000;
  return `<td class="m${soon ? ' wait' : ''}">${esc(day)}</td>`;
}

function actionsCell(row: ApiKeyRow, now: Date): string {
  if (row.revokedAt !== null) return '<span class="tag">odwołany</span>';
  return `${isExpired(row, now) ? '<span class="tag">wygasł</span> ' : ''}<a href="/klucze/${esc(row.id)}/edytuj">Edytuj</a>
           <form method="post" action="/klucze/${esc(row.id)}/odwolaj" style="display: inline;">
             <button class="btn btn-s" type="submit">Odwołaj</button>
           </form>`;
}

export type KeysFilter = 'czynne' | 'odwolane';

/**
 * Odwołane klucze nie znikają z bazy - wiadomości, zdarzenia i dziennik wskazują na nie,
 * a API odróżnia klucz odwołany od nieznanego. Na liście schodzą jednak do osobnej zakładki.
 */
export function keysPage(all: KeyView[], now: Date, filter: KeysFilter = 'czynne',
                         created: CreatedKey | null = null, notice: string | null = null): string {
  const active = all.filter((v) => v.row.revokedAt === null);
  const revoked = all.filter((v) => v.row.revokedAt !== null);
  const views = filter === 'czynne' ? active : revoked;
  const accountCount = new Set(views.map((v) => v.row.accountId)).size;

  const tabs = `<div class="seg">
        <a href="/klucze"${filter === 'czynne' ? ' class="on"' : ''}>Czynne</a>
        <a href="/klucze?status=odwolane"${filter === 'odwolane' ? ' class="on"' : ''}>Odwołane (${esc(revoked.length)})</a>
      </div>`;

  const rows = views.length === 0
    ? `<tr><td class="dim" colspan="10">${filter === 'czynne' ? 'Brak czynnych kluczy.' : 'Brak odwołanych kluczy.'}</td></tr>`
    : views.map((v) => {
    const host = webhookHost(v.row.webhookUrl);
    return `<tr${v.row.revokedAt === null && !isExpired(v.row, now) ? '' : ' class="revoked"'}>
      <td>
        <strong>${esc(v.row.name)}</strong>
        <div class="dim" style="font-size: 11.5px; margin-top: 2px;">utworzony ${esc(stamp(v.row.createdAt, ''))}</div>
      </td>
      <td class="m">${esc(shortened(v.row.keyPrefix))}</td>
      <td>${esc(v.accountName)}</td>
      <td class="m">${esc(v.row.allowedServiceIds.join(', '))}</td>
      <td class="m">${v.row.allowedOrigs.length === 0
        ? '<span class="dim" style="font-size: 12px;">tylko domyślny</span>'
        : esc(v.row.allowedOrigs.join(', '))}</td>
      <td class="m">${esc(v.row.ratePerMin)} / min</td>
      ${expiryCell(v.row, now)}
      <td>${host === null ? '<span class="dim">-</span>' : `<span class="m">${esc(host)}</span>`}</td>
      <td class="m">${v.row.lastUsedAt === null
        ? '<span class="dim" style="font-size: 12px;">jeszcze nieużywany</span>'
        : esc(stamp(v.row.lastUsedAt, ''))}</td>
      <td class="row-actions">${actionsCell(v.row, now)}</td>
    </tr>`;
    }).join('');

  const reveal = created === null ? '' : `<div class="reveal">
      <div class="reveal-h">
        <div class="lab" style="color: var(--signal);">${created.key === null
          ? `Nowy sekret webhooka - „${esc(created.name)}”`
          : `Nowy klucz - „${esc(created.name)}”`}</div>
      </div>
      ${created.key === null ? '' : `<div class="keyline">
        <div class="keybox">${esc(created.key)}</div>
      </div>
      <div style="padding: 0 16px 16px; font-size: 12.5px; line-height: 1.5;">${esc(OSTRZEZENIE)}</div>`}
      ${created.webhookSecret === null ? '' : `<div class="keyline">
        <div class="lab" style="width: 140px;">Sekret webhooka</div>
        <div class="keybox">${esc(created.webhookSecret)}</div>
      </div>
      <div style="padding: 0 16px 16px; font-size: 12.5px; line-height: 1.5;">${esc(OSTRZEZENIE_SEKRET)}</div>`}
    </div>`;

  return `<div class="head">
    <div>
      <h1 class="h1">Klucze API</h1>
      <p class="sub">Każdy klucz działa na jednym koncie Multiinfo i tylko na przypisanych ID usług</p>
    </div>
    <a class="btn btn-p" href="/klucze/nowy">Wygeneruj klucz</a>
  </div>
  <div class="scroll">
    ${notice === null ? '' : `<div class="warn">${esc(notice)}</div>`}
    ${reveal}
    <div class="bar" style="margin-bottom: 12px;">${tabs}</div>
    <div class="panel">
      <div class="panel-h">
        <div class="lab">${filter === 'czynne' ? 'Klucze' : 'Klucze odwołane'}</div>
        <div class="m dim">${esc(views.length)} · ${esc(accountCount)} konta</div>
      </div>
      <table>
        <tr>
          <th style="width: 190px;">Nazwa</th>
          <th style="width: 130px;">Prefiks</th>
          <th style="width: 130px;">Konto</th>
          <th style="width: 110px;">ID usług</th>
          <th style="width: 150px;">Nadpisy</th>
          <th style="width: 100px;">Limit</th>
          <th style="width: 110px;">Ważny do</th>
          <th style="width: 170px;">Webhook</th>
          <th style="width: 150px;">Ostatnie użycie</th>
          <th></th>
        </tr>
        ${rows}
      </table>
    </div>
  </div>`;
}

/** Wybór konta: bez niego nie wiadomo, z których usług i nadpisów można wybierać. */
export function chooseAccountPage(accounts: AccountRow[]): string {
  const items = accounts.map((a) => `<tr>
      <td><strong>${esc(a.name)}</strong></td>
      <td class="m dim">${esc(a.login)}</td>
      <td class="row-actions"><a href="/klucze/nowy?accountId=${esc(a.id)}">Wybierz</a></td>
    </tr>`).join('');

  return `<div class="head">
    <div>
      <h1 class="h1">Nowy klucz API</h1>
      <p class="sub">Wskaż konto Multiinfo, na którym klucz ma działać</p>
    </div>
  </div>
  <div class="scroll">
    <div class="panel"><table>${items}</table></div>
  </div>`;
}

/** Pola wspólne dla nowego klucza i edycji. `mode` steruje tylko podpowiedzią przy webhooku i polem sekretu. */
function keyFields(choice: AccountChoice, v: KeyFormValues, mode: 'new' | 'edit'): string {
  const services = choice.serviceIds.map((id) => `<label class="choice">
      <input type="checkbox" name="serviceIds" value="${esc(id)}"${v.serviceIds.includes(id) ? ' checked' : ''}> <span class="m">${esc(id)}</span>
    </label>`).join('');
  const serviceOptions = choice.serviceIds.map((id) =>
    `<option value="${esc(id)}"${v.defaultServiceId === id ? ' selected' : ''}>${esc(id)}</option>`).join('');

  const origs = choice.origs.length === 0
    ? `<div class="hint">Konto nie ma jeszcze słownika nadpisów. Nadpis uruchamia Polkomtel na wniosek
         złożony w panelu Multiinfo - uruchomione nadpisy wpisz na ekranie kont.</div>`
    : choice.origs.map((o) => `<label class="choice">
        <input type="checkbox" name="origs" value="${esc(o)}"${v.origs.includes(o) ? ' checked' : ''}> <span class="m">${esc(o)}</span>
      </label>`).join('');
  const origOptions = choice.origs.map((o) =>
    `<option value="${esc(o)}"${v.defaultOrig === o ? ' selected' : ''}>${esc(o)}</option>`).join('');

  const webhookHint = mode === 'new'
    ? 'Opcjonalny. Bramka będzie tam wysyłać zdarzenia doręczeń i niepowodzeń, podpisane sekretem, który pokażemy raz po utworzeniu klucza.'
    : 'Zmiana adresu bez podania sekretu wydaje nowy sekret i pokazuje go raz. Pusty adres wyłącza webhook.';

  return `<div class="field">
      <label for="name">Nazwa klucza</label>
      <input id="name" name="name" value="${esc(v.name)}" required>
      <div class="hint">Widoczna tylko w panelu - po niej rozpoznasz, która aplikacja go używa.</div>
    </div>
    <div class="field">
      <label>ID usług</label>
      <div class="choices">${services}</div>
    </div>
    <div class="field">
      <label for="defaultServiceId">Domyślne ID usługi</label>
      <select id="defaultServiceId" name="defaultServiceId">${serviceOptions}</select>
      <div class="hint">Używane, gdy żądanie nie podaje serviceId.</div>
    </div>
    <div class="field">
      <label>Nadpisy nadawcy</label>
      <div class="choices">${origs}</div>
      <div class="hint">Zaznacz nadpisy, których ta aplikacja może używać.
        Gdy w żądaniu nie pojawi się żadna ze zdefiniowanych pozycji, bramka użyje domyślnego nadpisu konta.</div>
    </div>
    <div class="field">
      <label for="defaultOrig">Domyślny nadpis klucza</label>
      <select id="defaultOrig" name="defaultOrig">
        <option value="">domyślny nadpis konta</option>
        ${origOptions}
      </select>
    </div>
    <div class="field">
      <label for="maxParts">Limit części jednej wiadomości (1-9)</label>
      <input id="maxParts" name="maxParts" type="number" min="1" max="9" value="${esc(v.maxParts)}" required>
      <div class="hint">Dłuższa treść zostanie odrzucona, nie przycięta.</div>
    </div>
    <div class="field">
      <label for="ratePerMin">Limit żądań na minutę</label>
      <input id="ratePerMin" name="ratePerMin" type="number" min="1" max="6000" value="${esc(v.ratePerMin)}" required>
    </div>
    <div class="field">
      <label for="webhookUrl">Adres webhooka</label>
      <input id="webhookUrl" name="webhookUrl" type="url" value="${esc(v.webhookUrl)}" placeholder="https://…">
      <div class="hint">${esc(webhookHint)}</div>
    </div>
    ${mode === 'edit' ? `<div class="field">
      <label for="webhookSecret">Sekret webhooka</label>
      <input id="webhookSecret" name="webhookSecret" type="password" autocomplete="off">
      <div class="hint">Puste pole zostawia dotychczasowy sekret.</div>
    </div>` : ''}
    <div class="field">
      <label for="expiresOn">Ważny do</label>
      <input id="expiresOn" name="expiresOn" type="date" value="${esc(v.expiresOn)}">
      <label class="choice"><input type="checkbox" name="noExpiry" value="1"${v.noExpiry ? ' checked' : ''}> Nie wygasa (nie rekomendowane)</label>
      <div class="hint">Po tej dacie żądania z kluczem dostają 401. Przedłużenie to zmiana daty - bez nowego klucza.</div>
    </div>`;
}

export function newKeyPage(choice: AccountChoice, error: string | null = null,
                           values: KeyFormValues = NEW_KEY_VALUES(choice)): string {
  return `<div class="head">
    <div>
      <h1 class="h1">Nowy klucz API</h1>
      <p class="sub">Konto ${esc(choice.row.name)} · ${esc(choice.row.login)}</p>
    </div>
  </div>
  <div class="scroll">
    ${error === null ? '' : `<div class="warn">${esc(error)}</div>`}
    <div class="panel" style="max-width: 560px;">
      <form class="form" method="post" action="/klucze">
        <input type="hidden" name="accountId" value="${esc(choice.row.id)}">
        ${keyFields(choice, values, 'new')}
        <div><button class="btn btn-p" type="submit">Wygeneruj klucz</button></div>
      </form>
    </div>
  </div>`;
}

export function editKeyPage(choice: AccountChoice, row: ApiKeyRow, error: string | null = null,
                            values: KeyFormValues = valuesOf(row)): string {
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/klucze">Klucze API</a> / edycja</div>
      <h1 class="h1">${esc(row.name)}</h1>
      <p class="sub">Konto ${esc(choice.row.name)} · prefiks ${esc(shortened(row.keyPrefix))}</p>
    </div>
  </div>
  <div class="scroll">
    ${error === null ? '' : `<div class="warn">${esc(error)}</div>`}
    <div class="panel" style="max-width: 560px;">
      <form class="form" method="post" action="/klucze/${esc(row.id)}/edytuj">
        ${keyFields(choice, values, 'edit')}
        <div><button class="btn btn-p" type="submit">Zapisz klucz</button></div>
      </form>
    </div>
  </div>`;
}
