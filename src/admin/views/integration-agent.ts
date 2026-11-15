import type { AgentFormValues } from '../agent-form.ts';
import { SCOPE_LABELS } from '../../agents/scopes.ts';
import { AGENTS_DOCS_URL } from '../../docs-links.ts';
import { AGENT_SCOPES, defaultAgentConfig, PA_RECIPIENT_LIMIT_MAX, type AgentScope } from '../../integrations/config.ts';
import { countForms, guideHtml, kindLabel, radio, sectionBasics, sectionGuard, type FormContext, type GuardWords } from './integrations.ts';
import { esc } from './layout.ts';
import { gatewayAddressPanel, gatewayAddressWarning } from './agent.ts';

export interface AgentFormOptions {
  mode: 'prosty' | 'zaawansowany';
  error?: string;
  /** Adres bramki: aplikacje z logowaniem łączą się wyłącznie przez `https://`. */
  apiUrl: string | null;
}

const hint = (text: string) => `<div class="hint">${esc(text)}</div>`;

/** Co zakres pozwala agentowi zrobić, słowami administratora. */
const SCOPE_HINTS: Record<AgentScope, string> = {
  send: 'Agent przygotowuje SMS-y na dowolne numery oraz rozsyłki do 5000 odbiorców. Może też anulować wiadomość, której bramka nie przekazała jeszcze abonentowi.',
  send_group: 'Agent przygotowuje SMS do grup SMS klucza tej integracji, na przykład SERWIS i FLOTA. Nie wyśle SMS-a na numer spoza list grup.',
  read_sent: 'Agent odczytuje wysłane wiadomości, przebieg doręczenia oraz stan i raport rozsyłek. Widzi także wysyłki innych integracji i aplikacji tego klucza.',
  campaigns: 'Agent odczytuje listę kampanii, otwarcia i kliknięcia linków oraz listę odbiorców z otwarciem albo bez otwarcia',
  read_inbound: 'Agent odczytuje SMS-y odebrane w usługach klucza tej integracji. Treść trafia do agenta oznaczona jako tekst od zewnętrznego nadawcy.',
  reply: 'Agent przygotowuje odpowiedź wyłącznie do autora odebranego SMS-a. Zakres wymaga odczytu odebranych, dlatego zapis zaznacza go samodzielnie.',
};

const SCOPE_WARNING = 'Wysyłka SMS-ów razem z odczytem odebranych wymaga rozwagi. Odebrany SMS może zawierać polecenie dla agenta, na przykład prośbę o wysłanie wiadomości na inny numer. Bramka oznacza taką treść jako tekst od zewnętrznego nadawcy, a każdą wysyłkę zatwierdza pracownik. Do obsługi klientów zalecany jest zakres „Odpowiedź nadawcy” zamiast „Wysyłka SMS-ów”. Zapis takiej integracji odnotowuje dziennik zdarzeń.';

/**
 * Element widoczny przy zaznaczeniu zakresów według `data-scopes` („a,b,!c”): `panel.js` przełącza go po każdej
 * zmianie, a serwer ustawia stan początkowy, dzięki czemu bez skryptu wyświetla się to, co dotyczy zapisanych zakresów.
 */
function whenScopes(rule: string, scopes: readonly AgentScope[], cls: string, text: string, style = ''): string {
  const shown = rule.split(',').every((r) => (r.startsWith('!') ? !scopes.includes(r.slice(1) as AgentScope) : scopes.includes(r as AgentScope)));
  return `<div class="${cls}" data-scopes="${esc(rule)}"${style ? ` style="${style}"` : ''}${shown ? '' : ' hidden'}>${esc(text)}</div>`;
}

/** Adres formularza w bieżącym trybie, także jako powrót z panelu adresu bramki. */
function formUrl(ctx: FormContext, mode?: 'prosty' | 'zaawansowany'): string {
  const base = ctx.row ? `/integracje/${ctx.row.id}/edytuj` : `/integracje/nowa?rodzaj=agent&ustawienie=${ctx.preset.id}`;
  if (mode === undefined) return base;
  return `${base}${base.includes('?') ? '&' : '?'}tryb=${mode}`;
}

function modeSwitch(ctx: FormContext, mode: 'prosty' | 'zaawansowany'): string {
  return `<div class="bar" style="gap: 10px; margin-bottom: 12px; align-items: center;">
    <div class="seg">
      <a href="${esc(formUrl(ctx, 'prosty'))}"${mode === 'prosty' ? ' class="on"' : ''}>Prosty</a>
      <a href="${esc(formUrl(ctx, 'zaawansowany'))}"${mode === 'zaawansowany' ? ' class="on"' : ''}>Zaawansowany</a>
    </div>
    <span class="dim" style="font-size: 12px;">${mode === 'prosty'
      ? 'Podstawy, zakresy i limit części. Tryb zaawansowany udostępnia ochronę przed burzą, dziennik i ładunki.'
      : 'Ochrona przed burzą, dziennik i ładunki.'}</span>
  </div>`;
}

function sectionScopes(v: AgentFormValues): string {
  const rows = AGENT_SCOPES.map((scope) => {
    const extra = scope !== 'reply' ? '' : [
      whenScopes('reply,!read_inbound', v.scopes, 'hint', 'Zapis zaznaczy także „Odczyt odebranych”, ponieważ agent musi widzieć SMS, na który odpowiada', 'margin-left: 22px; color: var(--wait-ink);'),
      whenScopes('reply,read_inbound', v.scopes, 'notice', 'Agent z odpowiedzią nadawcy nie wyśle SMS-a na obcy numer, ponieważ odpowiedź trafia wyłącznie do autora odebranego SMS-a', 'margin: 6px 0 0 22px;'),
    ].join('');
    return `<div class="scope">
        <label class="choice"><input type="checkbox" name="scopes" value="${scope}"${v.scopes.includes(scope) ? ' checked' : ''}> ${esc(SCOPE_LABELS[scope])}</label>
        ${hint(SCOPE_HINTS[scope])}${extra}
      </div>`;
  }).join('');
  return `<details open>
    <summary>Zakresy</summary>
    <div class="field" style="margin-bottom: 10px;">
      ${hint('Zakresy obowiązują wszystkie połączenia tej integracji. Pracownicy o różnych uprawnieniach wymagają osobnych integracji, na przykład „Agent AI - marketing” i „Agent AI - dyspozytornia”. Narzędzie „Co mogę?” działa w każdym połączeniu i pokazuje pracownikowi jego zakresy.')}
    </div>
    <div class="field scopes">${rows}</div>
    ${whenScopes('send,read_inbound', v.scopes, 'notice notice-wait', SCOPE_WARNING)}
  </details>`;
}

function sectionText(v: AgentFormValues): string {
  return `<details open>
    <summary>Treść</summary>
    <div class="field">
      <label>Limit części</label>
      <div class="inline">
        <input name="maxParts" type="number" min="1" max="9" value="${esc(v.maxParts)}" style="width: 90px;">
        <div class="choices">${radio('overflow', 'truncate', v.overflow, 'skróć i wyślij')}${radio('overflow', 'reject', v.overflow, 'nie wysyłaj, poproś agenta o krótszą treść')}</div>
      </div>
      ${hint('Limit obowiązuje SMS-y, rozsyłki i odpowiedzi agenta, a SMS do grupy podlega limitowi części grupy. Przy odrzuceniu agent otrzymuje w podglądzie informację o liczbie części i skraca treść.')}
    </div>
  </details>`;
}

const GUARD: GuardWords = {
  unit: 'wysyłek',
  throttleHint: 'Liczy wysyłki zatwierdzone w oknie, także odpowiedzi i SMS-y do grup. Wysyłka ponad limit kończy się błędem z czasem do ponowienia i wpisem „limit”, bez wysłania SMS-a. Odczyty, na przykład lista wiadomości i wyniki kampanii, nie wliczają się do limitu. Pierwsze przekroczenie w oknie jest zgłaszane mailem do administratora.',
  payloadHint: 'Przydatne podczas uruchamiania: dziennik pokazuje treść i odbiorców każdej wysyłki agenta. Ładunki zawierają numery i treści, dlatego opcję zaleca się włączać tylko na czas konfiguracji.',
};

/** Limit odbiorców w oknie ochrony przed burzą, w tym samym oknie co limit wysyłek. */
function recipientLimitField(v: AgentFormValues): string {
  return `<div class="field">
      <label for="throttleRecipients">Limit odbiorców</label>
      <div class="inline">
        <input id="throttleRecipients" name="throttleRecipients" type="number" min="1" max="${PA_RECIPIENT_LIMIT_MAX}" value="${esc(v.throttleRecipients)}" style="width: 110px;"> <span class="dim">odbiorców w tym samym oknie</span>
      </div>
      ${hint('Liczy numery ze wszystkich wysyłek w oknie. SMS do jednego numeru zajmuje jedno miejsce, a rozsyłka i SMS do grupy tyle miejsc, ilu obejmują odbiorców. Podgląd wysyłki pokazuje, ile miejsc pozostało, a wysyłka ponad limit zostaje odrzucona już przy przygotowaniu.')}
    </div>`;
}

/** Tryb prosty ukrywa ochronę przed burzą; zmienioną w trybie zaawansowanym pokazuje słowami przed ponownym zapisem. */
function guardSummary(v: AgentFormValues): string {
  const d = defaultAgentConfig().throttle;
  if (v.throttleLimit === String(d.limit) && v.throttleWindow === String(d.windowMinutes) && v.throttleRecipients === String(d.recipients)) return '';
  const n = (raw: string) => Number.parseInt(raw, 10) || 0;
  const limit = countForms(n(v.throttleLimit), 'wysyłka', 'wysyłki', 'wysyłek');
  const recipients = countForms(n(v.throttleRecipients), 'odbiorca', 'odbiorców', 'odbiorców');
  const window = countForms(n(v.throttleWindow), 'minuty', 'minut', 'minut');
  return hint(`Ochrona przed burzą: najwyżej ${limit} i ${recipients} w ciągu ${window}. Wartości zmienia tryb zaawansowany.`);
}

export function agentFormPage(ctx: FormContext, v: AgentFormValues, opts: AgentFormOptions): string {
  const edit = ctx.row !== undefined;
  const advanced = opts.mode === 'zaawansowany';
  const action = edit ? `/integracje/${ctx.row!.id}/edytuj` : '/integracje';
  const guide = `<details class="panel" style="max-width: 760px; padding: 0;">
      <summary style="padding: 12px 16px;">Jak działa Agent AI</summary>
      <div class="guide" style="padding: 0 16px 12px; font-size: 12.5px; line-height: 1.55;">${guideHtml(ctx.preset.guide)
    .replace('„Agenci AI”', `<a href="${esc(AGENTS_DOCS_URL)}" target="_blank" rel="noopener noreferrer">„Agenci AI”</a>`)}</div>
    </details>`;
  const hidden = `<input type="hidden" name="throttleLimit" value="${esc(v.throttleLimit)}"><input type="hidden" name="throttleWindow" value="${esc(v.throttleWindow)}"><input type="hidden" name="throttleRecipients" value="${esc(v.throttleRecipients)}"><input type="hidden" name="eventLogLimit" value="${esc(v.eventLogLimit)}">${v.storePayloads ? '<input type="hidden" name="storePayloads" value="1">' : ''}${guardSummary(v)}`;
  const crumbTail = edit ? 'edycja' : `<a href="/integracje/nowa">nowa</a> / <a href="/integracje/nowa?rodzaj=webhook_in">${esc(kindLabel('agent'))}</a>`;
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/integracje">Integracje</a> / ${crumbTail}</div>
      <h1 class="h1">${edit ? esc(ctx.row!.name) : 'Nowa integracja'}</h1>
      <p class="sub">${esc(kindLabel('agent'))} · ${esc(ctx.preset.name)}</p>
    </div>
  </div>
  <div class="scroll">
    ${modeSwitch(ctx, opts.mode)}
    ${opts.error ? `<div class="warn">${esc(opts.error)}</div>` : ''}
    ${gatewayAddressWarning(opts.apiUrl, 'pod formularzem')}
    ${guide}
    <div class="panel" style="max-width: 760px;">
      <form class="form" method="post" action="${action}" autocomplete="off">
        <input type="hidden" name="kind" value="agent">
        <input type="hidden" name="preset" value="${esc(ctx.preset.id)}">
        <input type="hidden" name="tryb" value="${opts.mode}">
        ${sectionBasics(ctx, v, {
    nameHint: 'Pod tą nazwą integracja pojawia się na stronie połączenia aplikacji i w źródle wiadomości wysłanych przez agenta',
    serviceHint: 'Domyślna usługa wysyłek agenta, jedna z usług wybranego klucza. Agent może wybrać inną usługę tego klucza, a podgląd wysyłki ją pokazuje.',
    origHint: 'Domyślny nadawca wysyłek agenta. Agent może wybrać inny nadpis tego klucza, a podgląd wysyłki go pokazuje.',
  })}
        ${sectionScopes(v)}
        ${sectionText(v)}
        ${advanced ? sectionGuard(v, { ...GUARD, extraField: recipientLimitField(v) }) : hidden}
        <div class="bar">
          <button class="btn btn-p" type="submit">${edit ? 'Zapisz integrację' : 'Utwórz integrację'}</button>
        </div>
      </form>
    </div>
    ${gatewayAddressPanel(opts.apiUrl, formUrl(ctx, opts.mode))}
  </div>`;
}
