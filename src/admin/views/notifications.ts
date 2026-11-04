import { eventDescription, eventLabel, type NotificationEvent } from '../../notifications/rules.ts';
import type { M365State } from '../../store/m365-accounts.ts';
import type { RuleRow, SmtpAuthMode, SmtpSecurity, SmtpSettings } from '../../store/notifications.ts';
import { M365_STATE_WORDS } from './integration-mail.ts';
import { radio } from './integrations.ts';
import { esc } from './layout.ts';

/** Pola formularza SMTP w postaci tekstowej - jak przychodzą z przeglądarki i wracają po błędzie. */
export interface SmtpFormValues {
  authMode: SmtpAuthMode; m365AccountId: string;
  host: string; port: string; security: SmtpSecurity; plainOk: boolean; user: string;
  fromAddress: string; fromName: string; recipients: string; instanceName: string; panelUrl: string;
}

export const EMPTY_SMTP: SmtpFormValues = {
  authMode: 'password', m365AccountId: '',
  host: '', port: '587', security: 'starttls', plainOk: false, user: '', fromAddress: '', fromName: 'Multiinfo Gate',
  recipients: '', instanceName: '', panelUrl: '',
};

/** W trybie Microsoft 365 pola serwera zostają puste: serwer Microsoftu nie jest ustawieniem administratora. */
export function smtpValuesOf(s: SmtpSettings): SmtpFormValues {
  const server = s.authMode === 'm365'
    ? { host: '', port: '587', security: 'starttls' as const, plainOk: false, user: '' }
    : { host: s.host, port: String(s.port), security: s.security, plainOk: s.security === 'none', user: s.user ?? '' };
  return {
    authMode: s.authMode, m365AccountId: s.m365AccountId === null ? '' : String(s.m365AccountId), ...server,
    fromAddress: s.fromAddress, fromName: s.fromName, recipients: s.recipients.join('\n'), instanceName: s.instanceName,
    panelUrl: s.panelUrl ?? '',
  };
}

export type NotificationsTab = 'konfiguracja' | 'reguly';

export interface NotificationsPageData {
  /** Zakładka: konfiguracja SMTP albo reguły; formularz i tabela nie mieszczą się obok siebie. */
  tab: NotificationsTab;
  smtp: SmtpSettings | null;
  smtpValues: SmtpFormValues;
  rules: RuleRow[];
  /** Błąd jednego z formularzy; `which` mówi, pod którym go pokazać. */
  error?: { which: 'smtp' | 'rules'; text: string } | null;
  /** Wartości reguł do ponownego narysowania po błędzie (surowe pola). */
  ruleValues?: Record<string, string> | null;
  /** Konta Microsoft 365 do wyboru przy logowaniu kontem organizacji. */
  m365Accounts?: Array<{ id: number; name: string; state: M365State }>;
}

const SECURITY: Array<{ value: SmtpSecurity; label: string }> = [
  { value: 'tls', label: 'TLS (zwykle port 465)' },
  { value: 'starttls', label: 'STARTTLS (zwykle port 587)' },
  { value: 'none', label: 'bez szyfrowania' },
];

/** Konto Microsoft 365 do wysyłki; bez kont odnośnik do ich dodania (spec 7.1). */
function m365AccountField(v: SmtpFormValues, accounts: NonNullable<NotificationsPageData['m365Accounts']>): string {
  if (accounts.length === 0) {
    return `<div class="field">
            <label>Konto Microsoft 365</label>
            <div class="notice">Panel nie zawiera jeszcze konta Microsoft 365. Wysyłka wymaga konta technicznego dodanego i zalogowanego na ekranie Konta Microsoft 365.</div>
            <div><a class="btn btn-s" href="/microsoft-365/nowe">Dodaj konto Microsoft 365</a></div>
          </div>`;
  }
  // Bez zapisanego konta lista wskazuje pierwsze połączone, jak formularz skrzynki Mail2SMS.
  const chosen = v.m365AccountId !== '' ? v.m365AccountId : String(accounts.find((a) => a.state === 'connected')?.id ?? '');
  const options = accounts.map((a) =>
    `<option value="${esc(a.id)}"${String(a.id) === chosen ? ' selected' : ''}>${esc(a.name)} · ${esc(M365_STATE_WORDS[a.state])}</option>`).join('');
  return `<div class="field">
            <label for="m365AccountId">Konto Microsoft 365</label>
            <select id="m365AccountId" name="m365AccountId">${options}</select>
            ${accounts.some((a) => a.state === 'connected')
    ? '<div class="hint">Konto, przez które bramka wysyła powiadomienia. Konta dodaje się i loguje na ekranie Konta Microsoft 365</div>'
    : '<div class="hint">Żadne z kont nie jest połączone, dlatego wysyłka zacznie działać po zalogowaniu konta na ekranie <a href="/microsoft-365">Konta Microsoft 365</a></div>'}
          </div>`;
}

const numbersText = (value: unknown): string => (Array.isArray(value) ? value.map((x) => String(x)).join(', ') : '');

/** Kolumna parametrów: tylko reguły, które je mają; reszta pusta. */
/** Parametr reguły: pole stałej szerokości w jednej linii z innymi, opis po prawej. */
function paramsCell(rule: RuleRow, raw: Record<string, string> | null | undefined, disabled: string): string {
  const val = (key: string, fallback: string) => esc(raw?.[key] ?? fallback);
  const cell = (input: string, label: string) => `${input} <span class="dim" style="font-size: 12px;">${esc(label)}</span>`;
  switch (rule.event) {
    case 'certificate_expiring':
      return cell(`<input class="cell" name="days_certificate_expiring" value="${val('days_certificate_expiring', numbersText(rule.params.days))}"${disabled}>`, 'dni przed wygaśnięciem, mail raz na każdy próg');
    case 'inbound_failure':
      return cell(`<input class="cell" name="afterMinutes_inbound_failure" type="number" min="1" max="1440" value="${val('afterMinutes_inbound_failure', String(rule.params.afterMinutes ?? 15))}"${disabled}>`, 'po ilu minutach niepowodzeń');
    case 'mailbox_failure':
      return cell(`<input class="cell" name="afterMinutes_mailbox_failure" type="number" min="1" max="1440" value="${val('afterMinutes_mailbox_failure', String(rule.params.afterMinutes ?? 15))}"${disabled}>`, 'po ilu minutach niepowodzeń, odrzucone logowanie natychmiast');
    case 'daily_summary':
      return cell(`<input class="cell" name="hour_daily_summary" type="number" min="0" max="23" value="${val('hour_daily_summary', String(rule.params.hour ?? 8))}"${disabled}>`, 'o której godzinie');
    default:
      return '<span class="dim">-</span>';
  }
}

function rulesTable(rules: RuleRow[], enabled: boolean, raw: Record<string, string> | null | undefined): string {
  const disabled = enabled ? '' : ' disabled';
  const rows = rules.map((r) => {
    const on = raw ? raw[`enabled_${r.event}`] === '1' : r.enabled === 1;
    const per = raw?.[`maxPerHour_${r.event}`] ?? String(r.maxPerHour);
    const group = raw?.[`groupHours_${r.event}`] ?? String(r.groupHours);
    return `<tr>
      <td>
        <strong>${esc(eventLabel(r.event as NotificationEvent))}</strong>
        <div class="dim" style="font-size: 11.5px; margin-top: 2px;">${esc(eventDescription(r.event as NotificationEvent))}</div>
      </td>
      <td><input type="checkbox" name="enabled_${esc(r.event)}" value="1"${on ? ' checked' : ''}${disabled}></td>
      <td><input class="cell" name="maxPerHour_${esc(r.event)}" type="number" min="1" max="100" value="${esc(per)}"${disabled}></td>
      <td><input class="cell" name="groupHours_${esc(r.event)}" type="number" min="0" max="24" value="${esc(group)}"${disabled}></td>
      <td><div class="inline" style="align-items: center; gap: 10px;">${paramsCell(r, raw, disabled)}</div></td>
    </tr>`;
  }).join('');
  return `<table>
      <tr>
        <th style="width: 250px;">Zdarzenie</th>
        <th style="width: 90px;">Włączone</th>
        <th style="width: 140px;">Maks. na godzinę</th>
        <th style="width: 140px;">Grupuj co (h)</th>
        <th style="min-width: 340px;">Parametry</th>
      </tr>
      ${rows}
    </table>`;
}

export function notificationsPage(d: NotificationsPageData): string {
  const v = d.smtpValues;
  const smtpError = d.error?.which === 'smtp' ? `<div class="warn">${esc(d.error.text)}</div>` : '';
  const rulesError = d.error?.which === 'rules' ? `<div class="warn">${esc(d.error.text)}</div>` : '';
  const configured = d.smtp !== null;
  return `<div class="head">
    <div>
      <h1 class="h1">Powiadomienia</h1>
      <p class="sub">Maile do administratora o błędach integracji, certyfikatach, kontach i odbiorze</p>
    </div>
  </div>
  <div class="scroll">
    <div class="bar" style="gap: 10px; margin-bottom: 12px; align-items: center;">
      <div class="seg">
        <a href="/powiadomienia"${d.tab === 'konfiguracja' ? ' class="on"' : ''}>Konfiguracja</a>
        <a href="/powiadomienia?zakladka=reguly"${d.tab === 'reguly' ? ' class="on"' : ''}>Reguły</a>
      </div>
      <span class="dim" style="font-size: 12px;">${d.tab === 'konfiguracja' ? 'Serwer SMTP, nadawca i odbiorcy maili' : 'Które zdarzenia są zgłaszane mailem, jak często i z jakimi progami'}</span>
    </div>
${d.tab === 'konfiguracja' ? `      <div class="panel" style="max-width: 760px;">
        <div class="panel-h"><div class="lab">Serwer SMTP</div>
          ${configured ? `<span class="m dim">zapisano ${esc(d.smtp!.updatedAt.slice(0, 10))}</span>` : '<span class="dim">nieskonfigurowany</span>'}</div>
        ${smtpError}
        <form class="form" id="smtp-form" method="post" action="/powiadomienia/smtp">
          <div class="field">
            <label>Sposób logowania</label>
            <div class="choices">${radio('authMode', 'password', v.authMode, 'Hasło')}${radio('authMode', 'm365', v.authMode, 'Microsoft 365')}</div>
            <div class="hint">Wariant Microsoft 365 wysyła powiadomienia przez konto techniczne organizacji, bez hasła zapisanego w bramce</div>
          </div>
          <div data-show="authMode=m365">
          ${m365AccountField(v, d.m365Accounts ?? [])}
          </div>
          <div data-show="authMode=password">
          <div class="field">
            <label for="host">Host</label>
            <input id="host" name="host" value="${esc(v.host)}" placeholder="smtp.firma.example">
          </div>
          <div class="field">
            <label for="port">Port</label>
            <input id="port" name="port" type="number" min="1" max="65535" value="${esc(v.port)}">
          </div>
          <div class="field">
            <label for="security">Szyfrowanie</label>
            <select id="security" name="security">
              ${SECURITY.map((s) => `<option value="${s.value}"${v.security === s.value ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
            </select>
            <label class="choice"><input type="checkbox" name="plainOk" value="1"${v.plainOk ? ' checked' : ''}> Rozumiem, że bez szyfrowania hasło jest przesyłane jawnie</label>
            <div class="hint">Połączenie bez szyfrowania jest dopuszczalne wyłącznie do serwera w tej samej sieci wewnętrznej</div>
          </div>
          <div class="field">
            <label for="user">Login</label>
            <input id="user" name="user" value="${esc(v.user)}" autocomplete="off">
            <div class="hint">Pusty login oznacza serwer bez uwierzytelniania</div>
          </div>
          <div class="field">
            <label for="password">Hasło</label>
            <input id="password" name="password" type="password" autocomplete="off">
            <div class="hint">${configured && d.smtp!.authMode === 'password' ? 'Puste pole zostawia dotychczasowe hasło' : 'Przechowywane w postaci zaszyfrowanej kluczem głównym'}</div>
          </div>
          </div>
          <div class="field">
            <label for="fromAddress">Adres nadawcy</label>
            <input id="fromAddress" name="fromAddress" value="${esc(v.fromAddress)}" placeholder="bramka@firma.example">
            <div class="hint" data-show="authMode=m365">Puste pole oznacza adres skrzynki wybranego konta. Inny adres wymaga, aby konto posiadało do niego uprawnienie „Wyślij jako”</div>
          </div>
          <div class="field">
            <label for="fromName">Nazwa wyświetlana nadawcy</label>
            <input id="fromName" name="fromName" value="${esc(v.fromName)}">
          </div>
          <div class="field">
            <label for="recipients">Odbiorcy</label>
            <textarea id="recipients" name="recipients" rows="3">${esc(v.recipients)}</textarea>
            <div class="hint">Jeden adres w wierszu, najwyżej 20</div>
          </div>
          <div class="field">
            <label for="instanceName">Nazwa instancji</label>
            <input id="instanceName" name="instanceName" value="${esc(v.instanceName)}" placeholder="np. Firma - produkcja">
            <div class="hint">Umieszczana w temacie każdego maila. Pozwala odróżnić powiadomienia z kilku bramek</div>
          </div>
          <div class="field">
            <label for="panelUrl">Adres panelu</label>
            <input id="panelUrl" name="panelUrl" value="${esc(v.panelUrl)}" placeholder="https://sms.firma.example:8081">
            <div class="hint">Opcjonalny. Powiadomienia zawierają ten adres jako odnośnik do panelu</div>
          </div>
          <div class="bar">
            <button class="btn btn-p" type="submit">Zapisz SMTP</button>
            <button class="btn btn-s" type="submit" form="smtp-test"${configured ? '' : ' disabled'}>Wyślij mail testowy</button>
          </div>
        </form>
        <form id="smtp-test" method="post" action="/powiadomienia/smtp/test"></form>
      </div>` : `      <div class="panel${configured ? '' : ' dim'}" style="max-width: 1180px;">
        ${configured ? '' : '<div class="warn">Reguły wymagają skonfigurowanego serwera SMTP. Konfiguracja znajduje się w zakładce Konfiguracja.</div>'}
        ${rulesError}
        <form method="post" action="/powiadomienia/reguly">
          ${rulesTable(d.rules, configured, d.ruleValues)}
          <div class="bar" style="padding: 12px 16px;">
            <button class="btn btn-p" type="submit"${configured ? '' : ' disabled'}>Zapisz reguły</button>
            <span class="hint dim" style="font-size: 11.5px;">Grupowanie 0 oznacza osobny mail dla każdego zdarzenia, do limitu na godzinę. Zdarzenia ponad limit są zliczane i podawane w następnym mailu</span>
          </div>
        </form>
      </div>`}
  </div>`;
}
