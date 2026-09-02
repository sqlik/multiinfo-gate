import { OUTBOUND_EVENTS, defaultInboundConfig, defaultOutboundConfig, type InboundConfig, type IntegrationConfig, type IntegrationKind, type OutboundConfig } from '../../integrations/config.ts';
import { RULE_OPS, ruleOpLabel, type RuleOp } from '../../integrations/conditions.ts';
import type { Preset } from '../../integrations/presets/index.ts';
import type { EventResult, IntegrationEventRow } from '../../store/integration-events.ts';
import type { IntegrationRow } from '../../store/integrations.ts';
import { warsawStamp } from '../../time/warsaw.ts';
import { esc } from './layout.ts';

export interface IntegrationView {
  row: IntegrationRow;
  keyName: string;
  accountName: string;
  presetName: string;
  counts: { sent: number; errors: number };
  lastEvent: IntegrationEventRow | null;
}

export interface IntegrationsFilter { kind: 'in' | 'out' | null; keyId: number | null }

/** Klucz do wyboru w formularzu: czynne klucze z usługami i nadpisami, po których wybiera się usługę i nadawcę. */
export interface KeyOption { id: number; name: string; accountName: string; serviceIds: string[]; origs: string[] }

const KIND_LABEL: Record<IntegrationKind, string> = { webhook_in: 'do SMS', webhook_out: 'z SMS-a' };
export const kindLabel = (kind: IntegrationKind): string => KIND_LABEL[kind];

const RESULT_LABELS: Record<EventResult, string> = {
  sent: 'wysłano', skipped: 'pominięto', rejected: 'odrzucono', throttled: 'limit', error: 'błąd',
  delivered: 'dostarczono', undelivered: 'niedostarczone', duplicate: 'duplikat',
};
export const resultLabel = (result: EventResult): string => RESULT_LABELS[result];

export function resultTone(result: EventResult): 'ok' | 'wait' | 'fail' {
  if (result === 'sent' || result === 'delivered') return 'ok';
  if (result === 'skipped' || result === 'duplicate') return 'wait';
  return 'fail';
}

export const resultBadge = (result: EventResult): string =>
  `<span class="st"><span class="dot dot-${resultTone(result)}"></span>${esc(resultLabel(result))}</span>`;

/** Ścieżka adresu wejściowego; host to adres API bramki, którego panel nie zna. */
export const hookPath = (hookId: string): string => `/hooks/${hookId}`;

const EVENT_LABELS: Record<(typeof OUTBOUND_EVENTS)[number], string> = {
  'message.received': 'odebrany SMS', 'message.sent': 'przyjęty do wysyłki', 'message.delivered': 'doręczony', 'message.failed': 'niedoręczony',
};

function stateCell(v: IntegrationView): string {
  if (v.row.enabled === 0) return '<span class="st"><span class="dot dot-dim"></span>wyłączona</span>';
  if (v.counts.errors > 0) return '<span class="st"><span class="dot dot-fail"></span>błąd</span>';
  return '<span class="st"><span class="dot dot-ok"></span>włączona</span>';
}

function filterLink(f: IntegrationsFilter, patch: Partial<IntegrationsFilter>): string {
  const kind = patch.kind === undefined ? f.kind : patch.kind;
  const keyId = patch.keyId === undefined ? f.keyId : patch.keyId;
  const p = new URLSearchParams();
  if (kind !== null) p.set('rodzaj', kind);
  if (keyId !== null) p.set('klucz', String(keyId));
  const q = p.toString();
  return q === '' ? '/integracje' : `/integracje?${q}`;
}

/** Ramka z adresem wejściowym pokazywana po utworzeniu albo wymianie adresu. */
export interface CreatedHook { name: string; hookId: string }

export function hookReveal(created: CreatedHook): string {
  return `<div class="reveal">
      <div class="reveal-h"><div class="lab" style="color: var(--signal);">Adres wejściowy - „${esc(created.name)}”</div></div>
      <div class="keyline">
        <div class="keybox" id="hook-path">${esc(hookPath(created.hookId))}</div>
        <button class="btn btn-s" type="button" data-copy="#hook-path">Kopiuj</button>
      </div>
      <div style="padding: 0 16px 16px; font-size: 12.5px; line-height: 1.5;">Doklej ścieżkę do adresu API bramki (port API, nie panelu),
        np. https://sms.firma.example${esc(hookPath(created.hookId))}. Aplikacja ma wysyłać tam żądania POST z JSON-em albo formularzem.
        Wygenerowanie nowego adresu unieważnia ten natychmiast.</div>
    </div>`;
}

export function integrationsPage(views: IntegrationView[], filter: IntegrationsFilter, keys: Array<{ id: number; name: string }>,
                                 created: CreatedHook | null = null): string {
  const kinds: Array<{ key: IntegrationsFilter['kind']; label: string }> = [
    { key: null, label: 'Wszystkie' }, { key: 'in', label: 'Do SMS' }, { key: 'out', label: 'Z SMS-a' },
  ];
  const tabs = kinds.map((k) => `<a href="${filterLink(filter, { kind: k.key })}"${k.key === filter.kind ? ' class="on"' : ''}>${esc(k.label)}</a>`).join('');
  const keyOptions = ['<option value="">wszystkie klucze</option>', ...keys.map((k) =>
    `<option value="${esc(k.id)}"${filter.keyId === k.id ? ' selected' : ''}>${esc(k.name)}</option>`)].join('');

  const rows = views.length === 0
    ? '<tr><td class="dim" colspan="7">Brak integracji pasujących do filtrów.</td></tr>'
    : views.map((v) => `<tr${v.row.enabled === 0 ? ' class="revoked"' : ''}>
      <td>
        <strong><a href="/integracje/${esc(v.row.id)}">${esc(v.row.name)}</a></strong>
        <div class="dim" style="font-size: 11.5px; margin-top: 2px;">${esc(v.presetName)}</div>
      </td>
      <td><span class="tag">${esc(kindLabel(v.row.kind))}</span></td>
      <td>${esc(v.keyName)} <span class="dim">· ${esc(v.accountName)}</span></td>
      <td>${stateCell(v)}</td>
      <td class="nw">${v.lastEvent === null ? '<span class="dim">jeszcze nic</span>'
        : `<span class="m dim">${esc(warsawStamp(v.lastEvent.at))}</span> ${resultBadge(v.lastEvent.result)}`}</td>
      <td class="m">${esc(v.counts.sent)} / <span class="${v.counts.errors > 0 ? 'fail' : 'dim'}">${esc(v.counts.errors)}</span></td>
      <td class="row-actions"><a href="/integracje/${esc(v.row.id)}">Otwórz</a> <a href="/integracje/${esc(v.row.id)}/edytuj">Edytuj</a></td>
    </tr>`).join('');

  return `<div class="head">
    <div>
      <h1 class="h1">Integracje</h1>
      <p class="sub">Aplikacje, które wysyłają SMS-y własnym formatem, i aplikacje, do których trafiają odebrane SMS-y i statusy</p>
    </div>
    <a class="btn btn-p" href="/integracje/nowa">Dodaj integrację</a>
  </div>
  <div class="scroll">
    ${created === null ? '' : hookReveal(created)}
    <form method="get" action="/integracje" class="bar" style="gap: 8px; margin-bottom: 12px;">
      <div class="seg">${tabs}</div>
      ${filter.kind === null ? '' : `<input type="hidden" name="rodzaj" value="${esc(filter.kind)}">`}
      <select class="inp" name="klucz">${keyOptions}</select>
      <button class="btn btn-s" type="submit">Filtruj</button>
    </form>
    <div class="panel">
      <div class="panel-h">
        <div class="lab">Integracje</div>
        <div class="m dim">${esc(views.length)}</div>
      </div>
      <table>
        <tr>
          <th style="width: 220px;">Nazwa</th>
          <th style="width: 90px;">Kierunek</th>
          <th style="width: 200px;">Klucz · konto</th>
          <th style="width: 110px;">Stan</th>
          <th style="width: 260px;">Ostatnie zdarzenie</th>
          <th style="width: 120px;">24 h: wysłane / błędy</th>
          <th></th>
        </tr>
        ${rows}
      </table>
    </div>
  </div>`;
}

/** Krok pierwszy: kierunek. Bez niego nie wiadomo, które ustawienia pokazać. */
export function chooseKindPage(): string {
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/integracje">Integracje</a> / nowa</div>
      <h1 class="h1">Nowa integracja</h1>
      <p class="sub">W którą stronę mają iść wiadomości?</p>
    </div>
  </div>
  <div class="scroll">
    <div class="tiles" style="grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 760px;">
      <a class="tile" href="/integracje/nowa?rodzaj=webhook_in">
        <div class="lab">Do SMS</div>
        <div style="font-size: 15px; font-weight: 600; margin-top: 6px;">Aplikacja wysyła SMS</div>
        <div class="d">Aplikacja woła adres wejściowy bramki własnym formatem, np. Uptime Kuma, Grafana, Zabbix, helpdesk</div>
      </a>
      <a class="tile" href="/integracje/nowa?rodzaj=webhook_out">
        <div class="lab">Z SMS-a</div>
        <div style="font-size: 15px; font-weight: 600; margin-top: 6px;">SMS albo status trafia do aplikacji</div>
        <div class="d">Odebrany SMS albo status wysyłki idzie do aplikacji w jej formacie, np. Slack, Teams, ntfy, helpdesk</div>
      </a>
    </div>
  </div>`;
}

/** Krok drugi: gotowe ustawienie; „Własne” ma być ostatnie - lista `presetsFor` już tak je układa. */
export function choosePresetPage(kind: IntegrationKind, presets: Preset[]): string {
  const tiles = presets.map((p) => `<a class="tile" href="/integracje/nowa?rodzaj=${esc(kind)}&amp;ustawienie=${esc(p.id)}">
        <div style="font-size: 15px; font-weight: 600;">${esc(p.name)}</div>
        <div class="d">${esc(p.blurb)}</div>
      </a>`).join('');
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/integracje">Integracje</a> / <a href="/integracje/nowa">nowa</a> / ${esc(kindLabel(kind))}</div>
      <h1 class="h1">Z jaką aplikacją?</h1>
      <p class="sub">Ustawienie wypełnia formularz; wszystko da się potem zmienić</p>
    </div>
  </div>
  <div class="scroll">
    <div class="tiles" style="grid-template-columns: repeat(3, minmax(0, 1fr)); max-width: 980px;">${tiles}</div>
  </div>`;
}

// --- formularz ---------------------------------------------------------------------------

export interface RuleValues { path: string; op: string; value: string }
export interface HeaderValues { name: string; value: string; secret: boolean }
export interface FormFieldValues { name: string; template: string }

/** Pola formularza w postaci tekstowej - tak przychodzą z przeglądarki i tak wracają po błędzie. */
export interface IntegrationFormValues {
  name: string; apiKeyId: string; serviceId: string; orig: string; enabled: boolean; preset: string;
  storePayloads: boolean; throttleLimit: string; throttleWindow: string; eventLogLimit: string;
  conditionMode: 'builder' | 'liquid'; rules: RuleValues[]; conditionExpr: string;
  authHeaderName: string; authHeaderValue: string; authBasicUser: string; authBasicPass: string; sources: string;
  toPath: string; toFallback: string; ticketRefPath: string; eventIdPath: string;
  textMode: 'path' | 'liquid'; textPath: string; textTemplate: string; maxParts: string; overflow: 'truncate' | 'reject';
  events: string[]; url: string; method: string; headers: HeaderValues[]; bodyMode: 'json' | 'form' | 'text';
  bodyTemplate: string; formFields: FormFieldValues[]; responseRefPath: string; sign: boolean;
  /** Próbka ładunku do „Sprawdź szablon” (JSON). */
  sample: string;
}

/** Nazwy sekretów integracji przychodzącej - stałe, bo formularz ma po jednym polu na każdy. */
export const INBOUND_TOKEN_REF = 'token';
export const INBOUND_BASIC_REF = 'basicPass';

/** Przykładowe zdarzenie wychodzące - próbka dla integracji z SMS-a, gdy nie ma przechowanego ładunku. */
export const OUTBOUND_SAMPLE = {
  event: 'message.received', id: 'in_01J8Z3M9K2QW4E7R', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text',
  text: 'Pomocy, nie działa', receivedAt: '2026-09-02T10:00:00.000Z', relatedMessageId: null,
};

export function configToValues(kind: IntegrationKind, config: IntegrationConfig, base: Pick<IntegrationFormValues, 'name' | 'apiKeyId' | 'serviceId' | 'orig' | 'enabled' | 'preset' | 'storePayloads' | 'sample'>): IntegrationFormValues {
  const inbound = kind === 'webhook_in' ? config as InboundConfig : defaultInboundConfig();
  const outbound = kind === 'webhook_out' ? config as OutboundConfig : defaultOutboundConfig();
  return {
    ...base,
    throttleLimit: String(config.throttle.limit), throttleWindow: String(config.throttle.windowMinutes), eventLogLimit: String(config.eventLogLimit),
    conditionMode: config.condition.mode,
    rules: config.condition.mode === 'builder' ? config.condition.rules.map((r) => ({ path: r.path, op: r.op, value: r.value })) : [],
    conditionExpr: config.condition.mode === 'liquid' ? config.condition.expr : '',
    authHeaderName: inbound.auth.header?.name ?? '', authHeaderValue: '', authBasicUser: inbound.auth.basic?.user ?? '', authBasicPass: '',
    sources: inbound.auth.sources.join('\n'),
    toPath: inbound.to.path ?? '', toFallback: inbound.to.fallback.join('\n'), ticketRefPath: inbound.ticketRefPath ?? '', eventIdPath: inbound.eventIdPath ?? '',
    textMode: inbound.text.mode, textPath: inbound.text.mode === 'path' ? inbound.text.path : '',
    textTemplate: inbound.text.mode === 'liquid' ? inbound.text.template : '', maxParts: String(inbound.maxParts), overflow: inbound.overflow,
    events: [...outbound.events], url: outbound.url, method: outbound.method,
    headers: outbound.headers.map((h) => ({ name: h.name, value: h.valueRef === undefined ? h.value ?? '' : '', secret: h.valueRef !== undefined })),
    bodyMode: outbound.body.mode, bodyTemplate: outbound.body.mode === 'form' ? '' : outbound.body.template,
    formFields: outbound.body.mode === 'form' ? outbound.body.fields.map((f) => ({ name: f.name, template: f.template })) : [],
    responseRefPath: outbound.responseRefPath ?? '', sign: outbound.sign,
  };
}

export const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

/** Wartości początkowe z ustawienia: domyślna konfiguracja rodzaju przykryta polami ustawienia. */
export function valuesFromPreset(kind: IntegrationKind, preset: Preset): IntegrationFormValues {
  const config: IntegrationConfig = kind === 'webhook_in'
    ? { ...defaultInboundConfig(), ...preset.inbound }
    : { ...defaultOutboundConfig(), ...preset.outbound };
  const sample = kind === 'webhook_in' ? preset.sample ?? {} : OUTBOUND_SAMPLE;
  return configToValues(kind, config, {
    name: preset.id === 'custom' ? '' : preset.name, apiKeyId: '', serviceId: '', orig: '', enabled: true, preset: preset.id,
    storePayloads: false, sample: prettyJson(sample),
  });
}

export function valuesOf(row: IntegrationRow, sample: string | null): IntegrationFormValues {
  return configToValues(row.kind, row.config, {
    name: row.name, apiKeyId: String(row.apiKeyId), serviceId: row.serviceId ?? '', orig: row.orig ?? '', enabled: row.enabled === 1,
    preset: row.preset, storePayloads: row.storePayloads === 1,
    sample: sample ?? prettyJson(row.kind === 'webhook_in' ? {} : OUTBOUND_SAMPLE),
  });
}

/** Wynik „Sprawdź szablon”: przychodząca ma odbiorców i treść, wychodząca nagłówki i body. */
export interface FormPreview {
  matches: boolean; error: string | null;
  recipients?: string[]; text?: string; parts?: number;
  /** Odbiorca wyjdzie z wątku: nadawca odebranego SMS-a dopasowanego po identyfikatorze zgłoszenia. */
  threadRecipient?: boolean;
  headers?: Record<string, string>; body?: string;
}

export interface FormContext {
  kind: IntegrationKind;
  preset: Preset;
  keys: KeyOption[];
  /** Sekrety już zapisane - przy nich pole może zostać puste. */
  secretNames: string[];
  /** Edycja: istniejący wiersz (adres wejściowy, klucz na stałe). */
  row?: IntegrationRow;
}

const MAX_RULE_ROWS = 20;
const MAX_HEADER_ROWS = 20;
const MAX_FORM_FIELD_ROWS = 30;
const SPARE_ROWS = 3;

const textarea = (name: string, value: string, rows: number, extra = '') =>
  `<textarea id="${esc(name)}" name="${esc(name)}" rows="${rows}"${extra}>${esc(value)}</textarea>`;

const checkbox = (name: string, checked: boolean, label: string, value = '1') =>
  `<label class="choice"><input type="checkbox" name="${esc(name)}" value="${esc(value)}"${checked ? ' checked' : ''}> ${esc(label)}</label>`;

const radio = (name: string, value: string, current: string, label: string) =>
  `<label class="choice"><input type="radio" name="${esc(name)}" value="${esc(value)}"${current === value ? ' checked' : ''}> ${esc(label)}</label>`;

/** Wiersze do edycji list: istniejące plus kilka pustych, nigdy ponad limit schematu. */
function withSpare<T>(items: T[], empty: T, max: number): T[] {
  const count = Math.min(max, items.length + SPARE_ROWS);
  return Array.from({ length: count }, (_, i) => items[i] ?? empty);
}

/** Skromny Markdown z instrukcji ustawienia: pogrubienie, kod, listy i akapity - reszta jako tekst. */
export function guideHtml(markdown: string): string {
  const inline = (line: string) => esc(line)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const blocks = markdown.split(/\n\s*\n/);
  return blocks.map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => l.startsWith('- '))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

function sectionBasics(ctx: FormContext, v: IntegrationFormValues): string {
  const services = [...new Set(ctx.keys.flatMap((k) => k.serviceIds))];
  const origs = [...new Set(ctx.keys.flatMap((k) => k.origs))];
  const keyField = ctx.row
    ? `<div class="field">
      <label>Klucz API</label>
      <div class="box">${esc(ctx.keys.find((k) => k.id === ctx.row!.apiKeyId)?.name ?? `klucz ${ctx.row.apiKeyId}`)}</div>
      <div class="hint">Klucz jest przypisany na stałe - integracja pod innym kluczem to nowa integracja.</div>
    </div>`
    : `<div class="field">
      <label for="apiKeyId">Klucz API</label>
      <select id="apiKeyId" name="apiKeyId">
        ${ctx.keys.map((k) => `<option value="${esc(k.id)}"${v.apiKeyId === String(k.id) ? ' selected' : ''}>${esc(k.name)} · ${esc(k.accountName)}</option>`).join('')}
      </select>
      <div class="hint">Integracja działa w imieniu klucza: konto, usługi, nadpisy i limity klucza obowiązują tak samo jak w API.</div>
    </div>`;
  return `<details open>
    <summary>Podstawy</summary>
    <div class="field">
      <label for="name">Nazwa</label>
      <input id="name" name="name" value="${esc(v.name)}" required>
    </div>
    ${keyField}
    <div class="field">
      <label for="serviceId">ID usługi</label>
      <select id="serviceId" name="serviceId">
        <option value="">domyślne klucza</option>
        ${services.map((s) => `<option value="${esc(s)}"${v.serviceId === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <div class="hint">Musi być jedną z usług wybranego klucza.</div>
    </div>
    <div class="field">
      <label for="orig">Nadpis nadawcy</label>
      <select id="orig" name="orig">
        <option value="">domyślny klucza</option>
        ${origs.map((o) => `<option value="${esc(o)}"${v.orig === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
      </select>
    </div>
    <div class="field">${checkbox('enabled', v.enabled, 'Włączona')}</div>
  </details>`;
}

function sectionInput(ctx: FormContext, v: IntegrationFormValues): string {
  const secretHint = (ref: string, what: string) => ctx.secretNames.includes(ref)
    ? `${what} jest zapisany. Puste pole zostawia dotychczasowy.`
    : `${what} zapisujemy zaszyfrowany; nie da się go potem odczytać w panelu.`;
  return `<details open>
    <summary>Wejście</summary>
    ${ctx.row ? '' : '<div class="field"><label>Adres wejściowy</label><div class="box ph">pojawi się po zapisie</div></div>'}
    <div class="field">
      <label for="authHeaderName">Nagłówek z tokenem</label>
      <div class="inline">
        <input id="authHeaderName" name="authHeaderName" value="${esc(v.authHeaderName)}" placeholder="nazwa, np. Authorization" style="width: 40%;">
        <input id="authHeaderValue" name="authHeaderValue" type="password" autocomplete="off" placeholder="wartość, np. Bearer …" style="flex: 1;">
      </div>
      <div class="hint">Opcjonalny. ${esc(secretHint(INBOUND_TOKEN_REF, 'Token'))} Pusta nazwa nagłówka zdejmuje tę warstwę i kasuje token.</div>
    </div>
    <div class="field">
      <label for="authBasicUser">Basic auth</label>
      <div class="inline">
        <input id="authBasicUser" name="authBasicUser" value="${esc(v.authBasicUser)}" placeholder="login" style="width: 40%;">
        <input id="authBasicPass" name="authBasicPass" type="password" autocomplete="off" placeholder="hasło" style="flex: 1;">
      </div>
      <div class="hint">Opcjonalny. ${esc(secretHint(INBOUND_BASIC_REF, 'Hasło'))} Pusty login zdejmuje tę warstwę i kasuje hasło.</div>
    </div>
    <div class="field">
      <label for="sources">Dozwolone źródła</label>
      ${textarea('sources', v.sources, 3, ' placeholder="203.0.113.7&#10;203.0.113.0/24&#10;nas.firma.example"')}
      <div class="hint">Jedna pozycja na linię: adres IP, zakres CIDR albo nazwa (rozwiązywana przy żądaniu). Pusta lista wpuszcza każdy adres.</div>
    </div>
  </details>`;
}

function sectionOutput(ctx: FormContext, v: IntegrationFormValues): string {
  const headers = withSpare(v.headers, { name: '', value: '', secret: false }, MAX_HEADER_ROWS);
  const headerRows = headers.map((h, i) => `<div class="inline" style="margin-bottom: 6px;">
        <input name="headerName" value="${esc(h.name)}" placeholder="nazwa" style="width: 32%;">
        <input name="headerValue" value="${esc(h.secret ? '' : h.value)}" type="${h.secret ? 'password' : 'text'}" autocomplete="off"
          placeholder="${h.secret && ctx.secretNames.includes(`h${i}`) ? 'zapisany - puste zostawia' : 'wartość albo szablon'}" style="flex: 1;">
        <select name="headerSecret" style="width: 110px;">
          <option value="0"${h.secret ? '' : ' selected'}>jawny</option>
          <option value="1"${h.secret ? ' selected' : ''}>sekret</option>
        </select>
      </div>`).join('');
  const events = OUTBOUND_EVENTS.map((e) => checkbox('events', v.events.includes(e), `${e} (${EVENT_LABELS[e]})`, e)).join('');
  return `<details open>
    <summary>Wyjście</summary>
    <div class="field">
      <label for="url">Adres</label>
      <input id="url" name="url" type="url" value="${esc(v.url)}" placeholder="https://…" required>
      <div class="hint">Adresy w sieci wewnętrznej wymagają MIG_WEBHOOK_ALLOW_PRIVATE=1 w środowisku bramki.</div>
    </div>
    <div class="field">
      <label for="method">Metoda</label>
      <select id="method" name="method">
        ${['POST', 'PUT', 'PATCH'].map((m) => `<option${v.method === m ? ' selected' : ''}>${m}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Nagłówki</label>
      ${headerRows}
      <div class="hint">Wartość jawna może być szablonem Liquid. Sekret zapisujemy zaszyfrowany i podstawiamy poza szablonem; pusta nazwa usuwa wiersz.</div>
    </div>
    <div class="field">
      <label>Zdarzenia</label>
      <div class="choices" style="flex-direction: column; gap: 6px;">${events}</div>
    </div>
    <div class="field">
      ${checkbox('sign', v.sign, 'Podpisuj żądania nagłówkiem X-MIG-Signature (sekret webhooka klucza)')}
      <div class="hint">Włącz, gdy odbiorcą jest własna aplikacja sprawdzająca podpis; gotowe aplikacje go nie znają.</div>
    </div>
  </details>`;
}

function sectionCondition(v: IntegrationFormValues): string {
  const rules = withSpare(v.rules, { path: '', op: 'eq', value: '' }, MAX_RULE_ROWS);
  const rows = rules.map((r) => `<div class="inline" style="margin-bottom: 6px;">
        <input name="rulePath" value="${esc(r.path)}" placeholder="ścieżka, np. heartbeat.status" style="width: 38%;">
        <select name="ruleOp" style="width: 170px;">
          ${RULE_OPS.map((op) => `<option value="${op}"${r.op === op ? ' selected' : ''}>${esc(ruleOpLabel(op as RuleOp))}</option>`).join('')}
        </select>
        <input name="ruleValue" value="${esc(r.value)}" placeholder="wartość" style="flex: 1;">
      </div>`).join('');
  return `<details${v.conditionMode === 'liquid' || v.rules.length > 0 ? ' open' : ''}>
    <summary>Warunek</summary>
    <div class="field">
      <div class="choices">${radio('conditionMode', 'builder', v.conditionMode, 'Reguły')}${radio('conditionMode', 'liquid', v.conditionMode, 'Wyrażenie Liquid')}</div>
      <div class="hint">Bez reguł każde zdarzenie idzie dalej. Wszystkie reguły muszą być spełnione; pusta ścieżka pomija wiersz.</div>
    </div>
    <div class="field">
      <label>Reguły</label>
      ${rows}
    </div>
    <div class="field">
      <label for="conditionExpr">Wyrażenie</label>
      ${textarea('conditionExpr', v.conditionExpr, 2, ' placeholder="{% if p.heartbeat.status == 0 %}tak{% endif %}"')}
      <div class="hint">Pusty wynik, false albo 0 oznacza „nie wysyłaj”.</div>
    </div>
  </details>`;
}

function sectionRecipient(v: IntegrationFormValues): string {
  return `<details open>
    <summary>Odbiorca</summary>
    <div class="field">
      <label for="toPath">Ścieżka numeru w ładunku</label>
      <input id="toPath" name="toPath" value="${esc(v.toPath)}" placeholder="np. customer.phones[0].value">
      <div class="hint">Pole z numerem albo listą numerów. Bez numeru w ładunku bramka bierze nadawcę odebranego SMS-a dopasowanego po identyfikatorze zgłoszenia, a na końcu listę zapasową.</div>
    </div>
    <div class="field">
      <label for="toFallback">Lista zapasowa</label>
      ${textarea('toFallback', v.toFallback, 3, ' placeholder="601000001&#10;+48 602 000 002"')}
      <div class="hint">Jeden numer na linię. Dziewięć cyfr dostaje kod kraju konta.</div>
    </div>
    <div class="field">
      <label for="ticketRefPath">Ścieżka identyfikatora zgłoszenia</label>
      <input id="ticketRefPath" name="ticketRefPath" value="${esc(v.ticketRefPath)}" placeholder="np. id">
      <div class="hint">Gdy identyfikator pasuje do odebranego SMS-a, odpowiedź idzie w jego wątku.</div>
    </div>
    <div class="field">
      <label for="eventIdPath">Ścieżka identyfikatora zdarzenia</label>
      <input id="eventIdPath" name="eventIdPath" value="${esc(v.eventIdPath)}" placeholder="np. alert.id">
      <div class="hint">To samo zdarzenie w ciągu doby przychodzi raz - powtórka dostaje odpowiedź „duplikat” bez SMS-a.</div>
    </div>
  </details>`;
}

function fieldsHint(preset: Preset): string {
  if (preset.fields.length === 0) return '<div class="hint">Ładunek dostępny pod <code>p</code>, np. <code>{{ p.message }}</code>; do tego <code>now</code> i <code>integration.name</code>.</div>';
  const items = preset.fields.map((f) => `<code>{{ p.${esc(f.path)} }}</code> <span class="dim">${esc(f.label)}</span>`).join('<br>');
  return `<div class="hint">Pola z ustawienia:<br>${items}</div>`;
}

function sectionTextInbound(ctx: FormContext, v: IntegrationFormValues): string {
  return `<details open>
    <summary>Treść</summary>
    <div class="field">
      <div class="choices">${radio('textMode', 'liquid', v.textMode, 'Szablon Liquid')}${radio('textMode', 'path', v.textMode, 'Pole z ładunku')}</div>
    </div>
    <div class="field">
      <label for="textTemplate">Szablon</label>
      ${textarea('textTemplate', v.textTemplate, 4)}
      ${fieldsHint(ctx.preset)}
      <div class="hint">Filtry bramki: <code>gsm</code> (bez polskich znaków), <code>sms_truncate: 100</code>, <code>phone</code>, <code>date_pl</code>, <code>html_text</code> (HTML na tekst).</div>
    </div>
    <div class="field">
      <label for="textPath">Ścieżka pola z treścią</label>
      <input id="textPath" name="textPath" value="${esc(v.textPath)}" placeholder="np. msg">
    </div>
    <div class="field">
      <label for="maxParts">Limit części (1-9)</label>
      <input id="maxParts" name="maxParts" type="number" min="1" max="9" value="${esc(v.maxParts)}" required>
    </div>
    <div class="field">
      <label for="overflow">Gdy treść nie mieści się w limicie</label>
      <select id="overflow" name="overflow">
        <option value="truncate"${v.overflow === 'truncate' ? ' selected' : ''}>przytnij z wielokropkiem</option>
        <option value="reject"${v.overflow === 'reject' ? ' selected' : ''}>odrzuć zdarzenie</option>
      </select>
    </div>
  </details>`;
}

function sectionBodyOutbound(v: IntegrationFormValues): string {
  const fields = withSpare(v.formFields, { name: '', template: '' }, MAX_FORM_FIELD_ROWS);
  const rows = fields.map((f) => `<div class="inline" style="margin-bottom: 6px;">
        <input name="formFieldName" value="${esc(f.name)}" placeholder="pole" style="width: 32%;">
        <input name="formFieldTemplate" value="${esc(f.template)}" placeholder="szablon, np. {{ text }}" style="flex: 1;">
      </div>`).join('');
  return `<details open>
    <summary>Żądanie</summary>
    <div class="field">
      <label for="bodyMode">Body</label>
      <select id="bodyMode" name="bodyMode">
        <option value="json"${v.bodyMode === 'json' ? ' selected' : ''}>JSON z szablonu</option>
        <option value="form"${v.bodyMode === 'form' ? ' selected' : ''}>formularz (pola)</option>
        <option value="text"${v.bodyMode === 'text' ? ' selected' : ''}>surowy tekst z szablonu</option>
      </select>
    </div>
    <div class="field">
      <label for="bodyTemplate">Szablon body</label>
      ${textarea('bodyTemplate', v.bodyTemplate, 6)}
      <div class="hint">Zmienne: <code>from</code>, <code>to</code>, <code>text</code>, <code>receivedAt</code>, <code>serviceId</code>, <code>id</code>, <code>event</code>;
        przy statusach <code>status</code>, <code>error</code>, <code>miStatus</code>. W JSON-ie pola tekstowe przez filtr <code>json</code>, np. <code>{{ text | json }}</code>.</div>
    </div>
    <div class="field">
      <label>Pola formularza</label>
      ${rows}
    </div>
    <div class="field">
      <label for="responseRefPath">Ścieżka identyfikatora w odpowiedzi</label>
      <input id="responseRefPath" name="responseRefPath" value="${esc(v.responseRefPath)}" placeholder="np. id">
      <div class="hint">Identyfikator zgłoszenia z odpowiedzi aplikacji trafia do odebranego SMS-a - odpowiedź agenta wróci wtedy w wątku.</div>
    </div>
  </details>`;
}

function sectionGuard(v: IntegrationFormValues): string {
  return `<details>
    <summary>Ochrona i dziennik</summary>
    <div class="field">
      <label>Limit burzy</label>
      <div class="inline">
        <input name="throttleLimit" type="number" min="1" max="1000" value="${esc(v.throttleLimit)}" style="width: 110px;"> <span class="dim">zdarzeń na</span>
        <input name="throttleWindow" type="number" min="1" max="1440" value="${esc(v.throttleWindow)}" style="width: 110px;"> <span class="dim">minut</span>
      </div>
      <div class="hint">Nadmiar w oknie dostaje wpis „limit” bez SMS-a; pierwszy raz w oknie idzie mail do administratora.</div>
    </div>
    <div class="field">
      <label for="eventLogLimit">Wpisów w dzienniku</label>
      <input id="eventLogLimit" name="eventLogLimit" type="number" min="20" max="2000" value="${esc(v.eventLogLimit)}">
    </div>
    <div class="field">
      ${checkbox('storePayloads', v.storePayloads, 'Przechowuj ładunki w dzienniku (7 dni, zaszyfrowane)')}
      <div class="hint">Przydatne przy uruchamianiu: ładunek z dziennika da się użyć jako próbki. Ładunki bywają wrażliwe - włącz na czas strojenia.</div>
    </div>
  </details>`;
}

function previewPanel(kind: IntegrationKind, p: FormPreview): string {
  const rows: string[] = [];
  rows.push(`<div>Warunek</div><div>${p.matches ? '<span class="st"><span class="dot dot-ok"></span>spełniony</span>' : '<span class="st"><span class="dot dot-wait"></span>niespełniony - zdarzenie zostałoby pominięte</span>'}</div>`);
  if (kind === 'webhook_in') {
    const recipients = p.recipients ?? [];
    rows.push(`<div>Odbiorcy</div><div class="m">${recipients.length > 0 ? esc(recipients.join(', '))
      : p.threadRecipient ? '<span class="dim">nadawca odebranego SMS-a, do którego pasuje identyfikator zgłoszenia</span>' : '<span class="fail">brak</span>'}</div>`);
    rows.push(`<div>Treść</div><div>${p.text ? `<div class="ruler" style="padding: 0 0 4px;">${esc(p.text)}</div>` : '<span class="dim">pusta</span>'}</div>`);
    rows.push(`<div>Części</div><div class="m">${esc(p.parts ?? 0)}</div>`);
  } else {
    const headers = Object.entries(p.headers ?? {}).map(([k, val]) => `${esc(k)}: ${esc(val)}`).join('<br>');
    rows.push(`<div>Nagłówki</div><div class="m">${headers || '<span class="dim">brak</span>'}</div>`);
    rows.push(`<div>Body</div><div><pre class="m" style="white-space: pre-wrap; margin: 0;">${esc(p.body ?? '')}</pre></div>`);
  }
  return `<div class="panel" style="max-width: 760px;">
    <div class="panel-h"><div class="lab">Podgląd z próbki</div><div class="m dim">bez zapisu i bez wysyłki</div></div>
    ${p.error === null ? '' : `<div class="warn">${esc(p.error)}</div>`}
    <div class="kv">${rows.join('')}</div>
  </div>`;
}

export interface FormPageOptions { error?: string | null; preview?: FormPreview | null; created?: CreatedHook | null }

export function integrationFormPage(ctx: FormContext, v: IntegrationFormValues, opts: FormPageOptions = {}): string {
  const edit = ctx.row !== undefined;
  const action = edit ? `/integracje/${ctx.row!.id}/edytuj` : '/integracje';
  const inbound = ctx.kind === 'webhook_in';
  const sections = inbound
    ? [sectionBasics(ctx, v), sectionInput(ctx, v), sectionCondition(v), sectionRecipient(v), sectionTextInbound(ctx, v), sectionGuard(v)]
    : [sectionBasics(ctx, v), sectionOutput(ctx, v), sectionCondition(v), sectionBodyOutbound(v), sectionGuard(v)];

  const address = edit && inbound && ctx.row!.hookId !== null && !opts.created ? `<div class="panel" style="max-width: 760px;">
      <div class="panel-h"><div class="lab">Adres wejściowy</div>
        <form method="post" action="/integracje/${esc(ctx.row!.id)}/nowy-adres" data-confirm="Wygenerować nowy adres? Stary przestanie działać natychmiast - trzeba go podmienić w aplikacji." data-confirm-ok="Wygeneruj">
          <button class="btn btn-s" type="submit">Wygeneruj nowy</button>
        </form>
      </div>
      <div class="keyline">
        <div class="keybox" id="hook-path">${esc(hookPath(ctx.row!.hookId))}</div>
        <button class="btn btn-s" type="button" data-copy="#hook-path">Kopiuj</button>
      </div>
    </div>` : '';

  const guide = ctx.preset.guide === '' ? '' : `<details class="panel" style="max-width: 760px; padding: 0;">
      <summary style="padding: 12px 16px;">Co ustawić w aplikacji: ${esc(ctx.preset.name)}</summary>
      <div class="guide" style="padding: 0 16px 12px; font-size: 12.5px; line-height: 1.55;">${guideHtml(ctx.preset.guide)}</div>
    </details>`;

  const crumbTail = edit ? 'edycja' : `<a href="/integracje/nowa">nowa</a> / ${esc(kindLabel(ctx.kind))} / ${esc(ctx.preset.name)}`;
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/integracje">Integracje</a> / ${crumbTail}</div>
      <h1 class="h1">${edit ? esc(ctx.row!.name) : 'Nowa integracja'}</h1>
      <p class="sub">${esc(kindLabel(ctx.kind))} · ustawienie ${esc(ctx.preset.name)}</p>
    </div>
  </div>
  <div class="scroll">
    ${opts.error ? `<div class="warn">${esc(opts.error)}</div>` : ''}
    ${opts.created ? hookReveal(opts.created) : ''}
    ${address}
    ${guide}
    ${opts.preview ? previewPanel(ctx.kind, opts.preview) : ''}
    <div class="panel" style="max-width: 760px;">
      <form class="form" method="post" action="${action}">
        <input type="hidden" name="kind" value="${esc(ctx.kind)}">
        <input type="hidden" name="preset" value="${esc(ctx.preset.id)}">
        ${sections.join('')}
        <details open>
          <summary>Próbka do sprawdzenia</summary>
          <div class="field">
            <label for="sample">Przykładowy ładunek (JSON)</label>
            ${textarea('sample', v.sample, 8)}
            <div class="hint">${inbound
              ? 'To, co aplikacja wyśle na adres wejściowy. Przy włączonym przechowywaniu ładunków dziennik podpowie prawdziwy.'
              : 'Zdarzenie bramki w takiej postaci, w jakiej trafia do szablonu.'}</div>
          </div>
        </details>
        <div class="bar">
          <button class="btn btn-s" type="submit" name="action" value="sprawdz">Sprawdź szablon</button>
          <button class="btn btn-p" type="submit" name="action" value="zapisz">${edit ? 'Zapisz integrację' : 'Utwórz integrację'}</button>
        </div>
      </form>
    </div>
  </div>`;
}

// --- szczegół ---------------------------------------------------------------------------

export interface DetailEvent { row: IntegrationEventRow; /** Dostawa nieudana, którą da się ponowić. */ retryable: boolean }

export interface IntegrationDetail { view: IntegrationView; events: DetailEvent[] }

/** Warunek w słowach: „heartbeat.status równe 0; monitor.name zawiera prod” albo wyrażenie Liquid. */
export function conditionWords(condition: IntegrationConfig['condition']): string {
  if (condition.mode === 'liquid') return `Liquid: ${condition.expr}`;
  if (condition.rules.length === 0) return 'brak - każde zdarzenie idzie dalej';
  return condition.rules.map((r) => {
    const op = ruleOpLabel(r.op as RuleOp);
    return r.op === 'exists' || r.op === 'missing' ? `${r.path} ${op}` : `${r.path} ${op} ${r.value}`;
  }).join('; ');
}

const kvRow = (label: string, value: string, mono = false) => `<div>${esc(label)}</div><div${mono ? ' class="m"' : ''}>${value}</div>`;
const dimOr = (value: string | undefined | null, fallback = 'brak') => (value ? esc(value) : `<span class="dim">${esc(fallback)}</span>`);

function configRows(row: IntegrationRow): string {
  const rows: string[] = [];
  const c = row.config;
  if (row.kind === 'webhook_in') {
    const cfg = c as InboundConfig;
    rows.push(kvRow('Adres wejściowy', row.hookId === null ? '<span class="dim">brak</span>' : `<div class="inline"><span class="m" id="hook-path">${esc(hookPath(row.hookId))}</span>
      <button class="btn btn-s" type="button" data-copy="#hook-path" style="padding: 3px 9px; font-size: 12px;">Kopiuj</button></div>`));
    const auth: string[] = [];
    if (cfg.auth.header) auth.push(`nagłówek ${cfg.auth.header.name} (sekret)`);
    if (cfg.auth.basic) auth.push(`basic auth, login ${cfg.auth.basic.user}`);
    if (cfg.auth.sources.length > 0) auth.push(`źródła: ${cfg.auth.sources.join(', ')}`);
    rows.push(kvRow('Uwierzytelnianie', auth.length === 0 ? '<span class="dim">tylko sekret w adresie</span>' : esc(auth.join(' · '))));
    const to = cfg.to.path ? `ścieżka ${cfg.to.path}` : '';
    const fallback = cfg.to.fallback.length > 0 ? `lista zapasowa: ${cfg.to.fallback.join(', ')}` : '';
    rows.push(kvRow('Odbiorcy', dimOr([to, fallback].filter((x) => x !== '').join(' · '))));
    rows.push(kvRow('Treść', cfg.text.mode === 'path' ? `pole ${esc(cfg.text.path)}` : `szablon Liquid · do ${esc(cfg.maxParts)} części, nadmiar: ${cfg.overflow === 'truncate' ? 'przycięcie' : 'odrzucenie'}`));
    if (cfg.ticketRefPath) rows.push(kvRow('Identyfikator zgłoszenia', esc(cfg.ticketRefPath), true));
    if (cfg.eventIdPath) rows.push(kvRow('Identyfikator zdarzenia', esc(cfg.eventIdPath), true));
  } else {
    const cfg = c as OutboundConfig;
    rows.push(kvRow('Adres docelowy', `${esc(cfg.method)} ${esc(cfg.url)}`, true));
    rows.push(kvRow('Zdarzenia', esc(cfg.events.join(', ')), true));
    const headers = cfg.headers.map((h) => (h.valueRef !== undefined ? `${h.name}: (sekret)` : `${h.name}: ${h.value ?? ''}`));
    rows.push(kvRow('Nagłówki', headers.length === 0 ? '<span class="dim">brak</span>' : headers.map(esc).join('<br>'), true));
    rows.push(kvRow('Body', cfg.body.mode === 'json' ? 'JSON z szablonu' : cfg.body.mode === 'form' ? `formularz (${cfg.body.fields.map((f) => f.name).join(', ')})` : 'surowy tekst'));
    if (cfg.responseRefPath) rows.push(kvRow('Identyfikator z odpowiedzi', esc(cfg.responseRefPath), true));
    rows.push(kvRow('Podpis X-MIG-Signature', cfg.sign ? 'tak' : 'nie'));
  }
  rows.push(kvRow('Warunek', esc(conditionWords(c.condition))));
  rows.push(kvRow('Limit burzy', `${esc(c.throttle.limit)} zdarzeń na ${esc(c.throttle.windowMinutes)} minut`));
  rows.push(kvRow('Ładunki', row.storePayloads === 1 ? 'przechowywane 7 dni, zaszyfrowane' : 'nieprzechowywane'));
  rows.push(kvRow('Dziennik', `do ${esc(c.eventLogLimit)} wpisów`));
  return rows.join('');
}

function relatedCell(e: IntegrationEventRow): string {
  const links: string[] = [];
  if (e.messageId !== null) links.push(`<a href="/wiadomosci/${esc(e.messageId)}">${esc(e.messageId)}</a>`);
  if (e.inboundId !== null) links.push(`<a href="/odebrane/${esc(e.inboundId)}">${esc(e.inboundId)}</a>`);
  return links.length === 0 ? '<span class="dim">-</span>' : links.join('<br>');
}

function eventRow(integrationId: number, d: DetailEvent): string {
  const e = d.row;
  const payload = e.payload === null ? '' : `<details style="margin-top: 4px;">
        <summary class="dim" style="cursor: pointer; font-size: 11.5px;">ładunek${e.response === null ? '' : ' i odpowiedź'}</summary>
        <pre class="m" style="white-space: pre-wrap; margin: 6px 0; font-size: 11.5px;">${esc(e.payload)}</pre>
        ${e.response === null ? '' : `<pre class="m dim" style="white-space: pre-wrap; margin: 0 0 6px; font-size: 11.5px;">${esc(e.response)}</pre>`}
        <a href="/integracje/${esc(integrationId)}/edytuj?probka=${esc(e.id)}">Użyj jako próbki</a>
      </details>`;
  const retry = d.retryable && e.deliveryId !== null
    ? `<form method="post" action="/dostawy/${esc(e.deliveryId)}/ponow"><button class="btn btn-s" type="submit" style="padding: 4px 9px; font-size: 12px;">Ponów</button></form>` : '';
  return `<tr>
      <td class="m dim nw">${esc(warsawStamp(e.at))}</td>
      <td class="nw">${resultBadge(e.result)}</td>
      <td class="txt">${dimOr(e.reason, '')}${payload}</td>
      <td class="m">${relatedCell(e)}</td>
      <td class="m dim">${esc(e.sourceIp ?? '')}</td>
      <td>${retry}</td>
    </tr>`;
}

export function integrationDetailPage(d: IntegrationDetail): string {
  const { row } = d.view;
  const toggle = row.enabled === 1
    ? `<form method="post" action="/integracje/${esc(row.id)}/wylacz" style="display: inline;"><button class="btn btn-s" type="submit">Wyłącz</button></form>`
    : `<form method="post" action="/integracje/${esc(row.id)}/wlacz" style="display: inline;"><button class="btn btn-s" type="submit">Włącz</button></form>`;
  const remove = `<form method="post" action="/integracje/${esc(row.id)}/usun" style="display: inline;"
      data-confirm="Usunąć integrację „${esc(row.name)}”? Dziennik zniknie razem z nią; aplikacja przestanie mieć dokąd wysyłać." data-confirm-ok="Usuń">
      <button class="btn btn-s" type="submit">Usuń</button></form>`;
  const events = d.events.length === 0
    ? '<tr><td class="dim" colspan="6">Dziennik jest pusty - integracja nie dostała jeszcze żadnego zdarzenia.</td></tr>'
    : d.events.map((e) => eventRow(row.id, e)).join('');
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/integracje">Integracje</a> / szczegół</div>
      <h1 class="h1">${esc(row.name)}</h1>
      <p class="sub"><span class="tag">${esc(kindLabel(row.kind))}</span> ${esc(d.view.presetName)} · klucz ${esc(d.view.keyName)} · ${stateCell(d.view)}</p>
    </div>
    <div class="bar">
      <a class="btn btn-s" href="/integracje/${esc(row.id)}/edytuj">Edytuj</a>
      ${toggle}
      ${remove}
    </div>
  </div>
  <div class="scroll">
    <div class="panel">
      <div class="panel-h"><div class="lab">Konfiguracja</div><div class="m dim">24 h: ${esc(d.view.counts.sent)} wysłane · ${esc(d.view.counts.errors)} błędy</div></div>
      <div class="kv">${configRows(row)}</div>
    </div>
    <div class="panel">
      <div class="panel-h"><div class="lab">Dziennik</div>
        <div class="m dim">${row.storePayloads === 1 ? 'ładunki przechowywane 7 dni' : 'Ładunki nieprzechowywane - włącz w edycji na czas strojenia'}</div></div>
      <table style="table-layout: fixed;">
        <tr>
          <th class="nw" style="width: 134px;">Czas</th>
          <th style="width: 120px;">Wynik</th>
          <th>Powód</th>
          <th style="width: 180px;">Powiązanie</th>
          <th style="width: 130px;">Adres źródłowy</th>
          <th style="width: 76px;"></th>
        </tr>
        ${events}
      </table>
    </div>
  </div>`;
}
