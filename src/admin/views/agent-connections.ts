import { CODE_VALIDITY, CONNECTION_VALIDITY, type ConnectionState } from '../../agents/connections.ts';
import { AGENTS_DOCS_URL } from '../../docs-links.ts';
import type { AgentConnectionRow, ConnectionMethod } from '../../store/agent-connections.ts';
import type { IntegrationRow } from '../../store/integrations.ts';
import { warsawShort, warsawStamp } from '../../time/warsaw.ts';
import { gatewayAddressPanel, gatewayAddressWarning } from './agent.ts';
import { esc } from './layout.ts';

export type CodeValidity = keyof typeof CODE_VALIDITY;
export type ConnectionValidity = keyof typeof CONNECTION_VALIDITY;

export const CODE_VALIDITY_LABELS: Record<CodeValidity, string> = { '15m': '15 minut', '1h': '1 godzina', '24h': '24 godziny', '3d': '3 dni', '7d': '7 dni' };
export const CONNECTION_VALIDITY_LABELS: Record<ConnectionValidity, string> = { '30d': '30 dni', '90d': '90 dni', '365d': 'rok', none: 'bez terminu' };

/** Sposób połączenia słowami panelu, z przykładowymi aplikacjami. */
const METHODS: Record<ConnectionMethod, { label: string; apps: string; hint: string }> = {
  oauth: {
    label: 'Aplikacja z logowaniem',
    apps: 'claude.ai, ChatGPT, aplikacje Claude, Gemini Enterprise',
    hint: 'Przy dodawaniu łącznika aplikacja otwiera stronę bramki, na której pracownik wpisuje kod jednorazowy. Ten sposób wymaga bramki dostępnej z internetu pod adresem https:// z domeną.',
  },
  token: {
    label: 'Aplikacja z kluczem w nagłówku',
    apps: 'Copilot Studio, Claude Code, VS Code, n8n',
    hint: 'Aplikacja wysyła token połączenia w nagłówku Authorization przy każdym żądaniu. Panel pokazuje token jeden raz, a bramka przechowuje wyłącznie jego skrót.',
  },
};

const STATE_WORDS: Record<ConnectionState, { label: string; tone: 'ok' | 'wait' | 'fail' | 'dim' }> = {
  waiting: { label: 'czeka na kod', tone: 'wait' },
  active: { label: 'aktywne', tone: 'ok' },
  code_expired: { label: 'kod wygasł', tone: 'fail' },
  expired: { label: 'wygasłe', tone: 'fail' },
  revoked: { label: 'odwołane', tone: 'dim' },
};

/** Chwila w panelu z dokładnością do minuty, jak w pozostałych tabelach terminów. */
const minute = (iso: string): string => warsawStamp(iso).slice(0, 16);
const sub = (text: string) => `<div class="dim" style="font-size: 11.5px; margin-top: 2px;">${text}</div>`;
const hint = (text: string) => `<div class="hint">${esc(text)}</div>`;

/** Adres serwera MCP z adresu bramki; null, gdy panel nie zna adresu. */
export function mcpUrlOf(base: string | null): string | null {
  return base === null ? null : `${base}/mcp`;
}

export interface ConnectionListItem { row: AgentConnectionRow; state: ConnectionState; effectiveExpiry: string | null }

function stateCell(item: ConnectionListItem, now: Date): string {
  const { row, state } = item;
  const words = STATE_WORDS[state];
  let detail = '';
  if (state === 'waiting' && row.codeExpiresAt !== null) {
    detail = sub(`do ${esc(minute(row.codeExpiresAt))}`);
  } else if (state === 'revoked') {
    detail = row.revokedReason === 'reuse' ? sub('przez bramkę po ponownym użyciu tokenu') : row.revokedAt === null ? '' : sub(esc(minute(row.revokedAt)));
  } else if (state === 'active' && row.method === 'oauth' && row.codeUsedAt === null && row.codeExpiresAt !== null && Date.parse(row.codeExpiresAt) > now.getTime()) {
    // Połączenie działa dalej, a nowy kod przepnie je na aplikację, w której pracownik go wpisze.
    detail = sub(`nowy kod czeka do ${esc(minute(row.codeExpiresAt))}`);
  }
  return `<span class="st"><span class="dot dot-${words.tone}"></span>${esc(words.label)}</span>${detail}`;
}

function expiryCell(iso: string | null, now: Date): string {
  if (iso === null) return '<td class="m dim nw">bez terminu</td>';
  const left = Date.parse(iso) - now.getTime();
  const tone = left <= 0 ? ' fail' : left <= 7 * 86_400_000 ? ' wait' : '';
  return `<td class="m nw${tone}">${esc(minute(iso))}</td>`;
}

function actionsCell(item: ConnectionListItem, integration: IntegrationRow): string {
  const { row, state } = item;
  const base = `/integracje/${esc(integration.id)}/polaczenia/${esc(row.id)}`;
  const name = esc(row.name);
  const form = (action: string, label: string, confirm: string, ok: string) =>
    `<form method="post" action="${base}/${action}" style="display: inline;" data-confirm="${confirm}" data-confirm-ok="${ok}"><button class="btn btn-s" type="submit">${label}</button></form>`;
  if (state === 'revoked' || state === 'expired') return '';
  const renew = row.method === 'oauth'
    ? `<a class="btn btn-s" href="${base}/kod">Nowy kod</a>`
    : form('token', 'Nowy token', `Wygenerować nowy token połączenia „${name}”? Dotychczasowy token przestanie działać natychmiast, dlatego aplikację należy skonfigurować ponownie.`, 'Wygeneruj');
  const last = state === 'waiting' || state === 'code_expired'
    ? form('usun', 'Usuń', `Usunąć połączenie „${name}”? Kod przestanie działać.`, 'Usuń')
    : form('odwolaj', 'Odwołaj', `Odwołać połączenie „${name}”? Aplikacja natychmiast straci dostęp do bramki, a odwołanego połączenia nie można przywrócić.`, 'Odwołaj');
  return `${renew} ${last}`;
}

/** Sekcja „Połączenia” w szczegółach integracji agenta: stan każdego połączenia i działania według stanu. */
export function connectionsSection(rows: ConnectionListItem[], integration: IntegrationRow, now: Date): string {
  const body = rows.length === 0
    ? '<tr><td class="dim" colspan="6">Integracja nie zawiera jeszcze połączeń. Każdy pracownik otrzymuje własne połączenie, a jego nazwa wyświetla się w źródle wiadomości.</td></tr>'
    : rows.map((item) => {
      const { row } = item;
      const app = row.method === 'token' ? '<span class="dim">klucz w nagłówku</span>' : row.clientName === null ? '<span class="dim">-</span>' : esc(row.clientName);
      return `<tr${item.state === 'revoked' || item.state === 'expired' ? ' class="revoked"' : ''}>
        <td><strong>${esc(row.name)}</strong>${sub(`dodane ${esc(minute(row.createdAt).slice(0, 10))} · ${esc(row.createdBy)}`)}</td>
        <td class="txt">${app}</td>
        <td>${stateCell(item, now)}</td>
        <td class="m nw${row.lastUsedAt === null ? ' dim' : ''}">${row.lastUsedAt === null ? 'jeszcze nieużywane' : esc(minute(row.lastUsedAt))}</td>
        ${expiryCell(item.effectiveExpiry, now)}
        <td class="row-actions">${actionsCell(item, integration)}</td>
      </tr>`;
    }).join('');
  const disabled = integration.enabled === 1 ? ''
    : '<div class="notice notice-wait" style="margin: 12px 16px 0;">Integracja jest wyłączona, dlatego jej połączenia nie działają. Po ponownym włączeniu integracji połączenia działają bez nowego kodu.</div>';
  return `<div class="panel" id="polaczenia">
      <div class="panel-h"><div class="lab">Połączenia</div><a class="btn btn-s" href="/integracje/${esc(integration.id)}/polaczenia/nowe">Dodaj połączenie</a></div>
      ${disabled}
      <table style="table-layout: fixed;">
        <tr>
          <th>Nazwa</th>
          <th style="width: 104px;">Aplikacja</th>
          <th style="width: 140px;">Stan</th>
          <th class="nw" style="width: 116px;">Ostatnie użycie</th>
          <th class="nw" style="width: 116px;">Ważne do</th>
          <th style="width: 180px;"></th>
        </tr>
        ${body}
      </table>
    </div>`;
}

const select = (name: string, labels: Record<string, string>, current: string) =>
  `<select id="${name}" name="${name}" style="width: 200px;">${Object.entries(labels)
    .map(([value, label]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;

function crumb(integration: IntegrationRow, tail: string): string {
  return `<div class="crumb"><a href="/integracje">Integracje</a> / <a href="/integracje/${esc(integration.id)}">${esc(integration.name)}</a> / ${tail}</div>`;
}

export interface NewConnectionValues { name: string; method: ConnectionMethod; codeValidity: CodeValidity; validity: ConnectionValidity }

export const NEW_CONNECTION_DEFAULTS: NewConnectionValues = { name: '', method: 'oauth', codeValidity: '24h', validity: '90d' };

/** Formularz „Dodaj połączenie”: nazwa, sposób połączenia, ważność kodu i połączenia. */
export function newConnectionPage(v: { integration: IntegrationRow; values: NewConnectionValues; keyExpiresAt: string | null; error?: string }): string {
  const { integration, values } = v;
  const methods = (Object.keys(METHODS) as ConnectionMethod[]).map((m) => `<div class="scope">
        <label class="choice"><input type="radio" name="method" value="${m}"${values.method === m ? ' checked' : ''}> ${esc(METHODS[m].label)}</label>
        <div class="hint">${esc(METHODS[m].apps)}</div>
        ${hint(METHODS[m].hint)}
      </div>`).join('');
  const keyLimit = v.keyExpiresAt === null
    ? 'Połączenie nigdy nie trwa dłużej niż klucz API integracji'
    : `Połączenie nigdy nie trwa dłużej niż klucz API integracji, który jest ważny do ${minute(v.keyExpiresAt)}`;
  return `<div class="head">
    <div>
      ${crumb(integration, 'nowe połączenie')}
      <h1 class="h1">Dodaj połączenie</h1>
      <p class="sub">${esc(integration.name)}</p>
    </div>
  </div>
  <div class="scroll">
    ${v.error ? `<div class="warn">${esc(v.error)}</div>` : ''}
    <div class="panel" style="max-width: 760px;">
      <form class="form" method="post" action="/integracje/${esc(integration.id)}/polaczenia" autocomplete="off">
        <div class="field">
          <label for="name">Nazwa</label>
          <input id="name" name="name" maxlength="80" required value="${esc(values.name)}">
          ${hint('Imię i nazwisko pracownika albo nazwa systemu, na przykład „Ewa Nowak”. Nazwa wyświetla się w źródle wiadomości i w dzienniku integracji.')}
        </div>
        <div class="field scopes">
          <label>Sposób połączenia</label>
          ${methods}
        </div>
        <div class="field">
          <label for="codeValidity">Ważność kodu</label>
          ${select('codeValidity', CODE_VALIDITY_LABELS, values.codeValidity)}
          ${hint('Dotyczy wyłącznie aplikacji z logowaniem. Po terminie kod przestaje działać, a panel pozwala wygenerować nowy.')}
        </div>
        <div class="field">
          <label for="validity">Ważność połączenia</label>
          ${select('validity', CONNECTION_VALIDITY_LABELS, values.validity)}
          ${hint(keyLimit)}
        </div>
        <div class="bar">
          <button class="btn btn-p" type="submit">Dodaj połączenie</button>
          <a class="btn btn-s" href="/integracje/${esc(integration.id)}#polaczenia">Anuluj</a>
        </div>
      </form>
    </div>
  </div>`;
}

/** Formularz nowego kodu: wybór ważności. Nowy kod zastępuje poprzedni, a w aktywnym połączeniu przepina aplikację. */
export function newCodePage(v: { integration: IntegrationRow; connection: AgentConnectionRow; state: ConnectionState }): string {
  const { integration, connection } = v;
  const note = v.state === 'active'
    ? 'Dotychczasowe połączenie działa do użycia nowego kodu. Użycie kodu przepina połączenie na aplikację, w której pracownik go wpisze, a wcześniejsze tokeny przestają działać.'
    : 'Nowy kod zastępuje poprzedni, który przestaje działać';
  return `<div class="head">
    <div>
      ${crumb(integration, 'nowy kod')}
      <h1 class="h1">Nowy kod - ${esc(connection.name)}</h1>
      <p class="sub">${esc(integration.name)}</p>
    </div>
  </div>
  <div class="scroll">
    <div class="panel" style="max-width: 760px;">
      <form class="form" method="post" action="/integracje/${esc(integration.id)}/polaczenia/${esc(connection.id)}/kod" autocomplete="off">
        <div class="field">
          <label for="codeValidity">Ważność kodu</label>
          ${select('codeValidity', CODE_VALIDITY_LABELS, '24h')}
          ${hint(note)}
        </div>
        <div class="bar">
          <button class="btn btn-p" type="submit">Wygeneruj kod</button>
          <a class="btn btn-s" href="/integracje/${esc(integration.id)}#polaczenia">Anuluj</a>
        </div>
      </form>
    </div>
  </div>`;
}

/** Strona błędu działania na połączeniu, na przykład usunięcia połączenia, które było używane. */
export function connectionErrorPage(integration: IntegrationRow, message: string): string {
  return `<div class="head">
    <div>
      ${crumb(integration, 'połączenia')}
      <h1 class="h1">Połączenia</h1>
    </div>
  </div>
  <div class="scroll">
    <div class="warn">${esc(message)}</div>
    <div class="bar"><a class="btn btn-s" href="/integracje/${esc(integration.id)}#polaczenia">Wróć do integracji</a></div>
  </div>`;
}

const validityWords = (effectiveExpiry: string | null): string =>
  effectiveExpiry === null ? 'Połączenie jest ważne bezterminowo.' : `Połączenie będzie ważne do ${warsawShort(effectiveExpiry).slice(0, 10)}.`;

/** Gotowa wiadomość dla pracownika: adres serwera MCP, kod albo nagłówek, terminy i odnośnik do artykułu. */
export function handoffText(v: { method: ConnectionMethod; mcpUrl: string; secret: string; secretExpiresAt: string | null; effectiveExpiry: string | null }): string {
  if (v.method === 'oauth') {
    const code = v.secretExpiresAt === null ? 'Kod działa tylko raz.' : `Kod jest ważny do ${warsawShort(v.secretExpiresAt)} i działa tylko raz.`;
    return [
      'Przekazuję dane do połączenia aplikacji AI z bramką SMS.',
      '',
      `Adres serwera MCP: ${v.mcpUrl}`,
      `Kod jednorazowy: ${v.secret}`,
      '',
      `Dodaj w aplikacji łącznik MCP z podanym adresem. Aplikacja otworzy stronę bramki, na której należy wpisać kod. ${code} ${validityWords(v.effectiveExpiry)}`,
      '',
      `Instrukcję dla claude.ai, ChatGPT i pozostałych aplikacji znajdziesz na stronie ${AGENTS_DOCS_URL}`,
    ].join('\n');
  }
  return [
    'Przekazuję dane do połączenia aplikacji AI z bramką SMS.',
    '',
    `Adres serwera MCP: ${v.mcpUrl}`,
    `Nagłówek: Authorization: Bearer ${v.secret}`,
    '',
    `Dodaj w aplikacji serwer MCP z podanym adresem i nagłówkiem. Token należy chronić jak hasło, ponieważ każda osoba, która go zna, może korzystać z tego połączenia. ${validityWords(v.effectiveExpiry)}`,
    '',
    `Instrukcję dla Copilot Studio, Claude Code i pozostałych aplikacji znajdziesz na stronie ${AGENTS_DOCS_URL}`,
  ].join('\n');
}

/** Krótka instrukcja dla najczęstszych aplikacji danego sposobu połączenia. */
function appGuide(method: ConnectionMethod, mcpUrl: string | null, secret: string): string {
  const url = mcpUrl ?? '<adres bramki>/mcp';
  const items = method === 'oauth'
    ? [
      '<strong>claude.ai i aplikacje Claude:</strong> w menu Customize → Connectors wybierz Add custom connector i wklej adres serwera MCP',
      '<strong>ChatGPT:</strong> w menu Wtyczki wybierz Dodaj, a następnie Dołącz niestandardowy serwer MCP i wklej adres serwera MCP',
      '<strong>Pozostałe aplikacje z logowaniem:</strong> dodaj łącznik MCP z adresem serwera, a aplikacja otworzy stronę bramki do wpisania kodu',
    ]
    : [
      `<strong>Claude Code:</strong> uruchom polecenie <code>${esc(`claude mcp add --transport http multiinfo-gate ${url} --header "Authorization: Bearer ${secret}"`)}</code>`,
      '<strong>Copilot Studio:</strong> w agencie wybierz Narzędzia → Dodaj → Protokół kontekstu modelu, podaj adres serwera MCP i token w nagłówku Authorization',
      '<strong>VS Code:</strong> dodaj w pliku mcp.json serwer typu http z adresem serwera MCP i nagłówkiem Authorization',
      '<strong>n8n:</strong> w węźle MCP Client Tool podaj adres serwera MCP i wybierz uwierzytelnianie Bearer z tokenem',
    ];
  return `<div class="panel" style="max-width: 760px;">
      <div class="panel-h"><div class="lab">Jak połączyć aplikację</div></div>
      <div class="guide" style="padding: 12px 16px; font-size: 12.5px; line-height: 1.55;">
        <ul style="margin: 0; padding-left: 18px;">${items.map((i) => `<li>${i}</li>`).join('')}</ul>
        <p style="margin: 10px 0 0;">Szczegółową instrukcję dla każdej aplikacji znajdziesz w artykule <a href="${esc(AGENTS_DOCS_URL)}" target="_blank" rel="noopener noreferrer">„Agenci AI”</a>.</p>
      </div>
    </div>`;
}

/**
 * Strona po zapisie połączenia albo po nowym kodzie lub tokenie. Sekret istnieje wyłącznie w tej odpowiedzi: bramka
 * zapisuje skrót, a ponowne wejście pod ten adres metodą GET prowadzi do szczegółów integracji.
 */
export function connectionSecretPage(v: {
  integration: IntegrationRow; connection: AgentConnectionRow; secret: string; secretExpiresAt: string | null; effectiveExpiry: string | null;
  mcpUrl: string | null; apiUrl: string | null;
}): string {
  const { integration, connection } = v;
  const oauth = connection.method === 'oauth';
  const back = `/integracje/${integration.id}#polaczenia`;
  const note = oauth
    ? 'Kod wyświetla się tylko raz, a bramka przechowuje wyłącznie jego skrót. Pracownik wpisuje kod na stronie bramki, która otwiera się przy dodawaniu łącznika w aplikacji.'
    : 'Token wyświetla się tylko raz, a bramka przechowuje wyłącznie jego skrót. Token należy przekazać pracownikowi bezpiecznym kanałem, ponieważ każda osoba, która go zna, może korzystać z połączenia.';
  const row = (label: string, value: string) => `<div>${esc(label)}</div><div class="m">${value}</div>`;
  const mcp = v.mcpUrl === null
    ? '<span class="dim">nieznany, ponieważ panel nie zna adresu bramki</span>'
    : `<span id="mcp-url">${esc(v.mcpUrl)}</span> <button class="btn btn-s" type="button" data-copy="#mcp-url" style="margin-left: 8px;">Kopiuj</button>`;
  const handoff = v.mcpUrl === null
    ? `<div style="padding: 12px 16px; font-size: 12.5px;" class="dim">Tekst do przekazania wymaga adresu bramki. Po ustawieniu adresu wygeneruj nowy ${oauth ? 'kod' : 'token'}, a panel przygotuje gotową wiadomość.</div>`
    : `<pre class="m" id="handoff" style="white-space: pre-wrap; margin: 0; padding: 12px 16px; font-size: 12.5px; line-height: 1.55;">${esc(handoffText({
      method: connection.method, mcpUrl: v.mcpUrl, secret: v.secret, secretExpiresAt: v.secretExpiresAt, effectiveExpiry: v.effectiveExpiry,
    }))}</pre>`;
  return `<div class="head">
    <div>
      ${crumb(integration, 'połączenie')}
      <h1 class="h1">${esc(connection.name)}</h1>
      <p class="sub">${esc(METHODS[connection.method].label)} · ${esc(integration.name)}</p>
    </div>
  </div>
  <div class="scroll">
    ${oauth ? gatewayAddressWarning(v.apiUrl, 'na dole strony') : ''}
    <div class="reveal" style="max-width: 760px;">
      <div class="reveal-h"><div class="lab" style="color: var(--signal);">${oauth ? 'Kod jednorazowy' : 'Token połączenia'} - „${esc(connection.name)}”</div></div>
      <div class="keyline">
        <div class="keybox" id="connection-secret">${esc(v.secret)}</div>
        <button class="btn btn-s" type="button" data-copy="#connection-secret">Kopiuj</button>
      </div>
      <div style="padding: 0 16px 12px; font-size: 12.5px; line-height: 1.5;">${esc(note)}</div>
      <div class="kv" style="grid-template-columns: 190px minmax(0, 1fr); border-top: 1px solid var(--rule-soft);">
        ${row('Adres serwera MCP', mcp)}
        ${oauth && v.secretExpiresAt !== null ? row('Kod ważny do', esc(minute(v.secretExpiresAt))) : ''}
        ${row('Połączenie ważne do', v.effectiveExpiry === null ? '<span class="dim">bez terminu</span>' : esc(minute(v.effectiveExpiry)))}
      </div>
    </div>
    <div class="panel" style="max-width: 760px;">
      <div class="panel-h"><div class="lab">Tekst do przekazania</div>${v.mcpUrl === null ? '' : '<button class="btn btn-s" type="button" data-copy="#handoff">Kopiuj tekst</button>'}</div>
      ${handoff}
    </div>
    ${appGuide(connection.method, v.mcpUrl, v.secret)}
    <div class="bar"><a class="btn btn-s" href="${back}">Wróć do integracji</a></div>
    ${oauth || v.mcpUrl === null ? gatewayAddressPanel(v.apiUrl, back) : ''}
  </div>`;
}
