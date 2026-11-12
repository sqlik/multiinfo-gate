import type { PaFormValues } from '../power-automate-form.ts';
import { defaultPowerAutomateConfig, PA_RECIPIENT_LIMIT_MAX } from '../../integrations/config.ts';
import { countForms, guideHtml, kindLabel, radio, sectionBasics, sectionGuard, textarea, type FormContext, type GuardWords } from './integrations.ts';
import { esc } from './layout.ts';
import { powerAutomatePanel } from './power-automate.ts';

export interface PaFormOptions {
  mode: 'prosty' | 'zaawansowany';
  error?: string;
  /** Adres bramki do pola panelu konektora. */
  apiUrl: string | null;
}

const hint = (text: string) => `<div class="hint">${esc(text)}</div>`;

/** Adres formularza w bieżącym trybie, także jako powrót z panelu konektora. */
function formUrl(ctx: FormContext, mode?: 'prosty' | 'zaawansowany'): string {
  const base = ctx.row ? `/integracje/${ctx.row.id}/edytuj` : `/integracje/nowa?rodzaj=power_automate&ustawienie=${ctx.preset.id}`;
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
      ? 'Podstawy, lista odbiorców grupy i limit części. Tryb zaawansowany udostępnia ochronę przed burzą, dziennik i ładunki.'
      : 'Ochrona przed burzą, dziennik i ładunki.'}</span>
  </div>`;
}

function sectionRecipients(v: PaFormValues): string {
  return `<details open>
    <summary>Odbiorcy grupy</summary>
    <div class="field">
      <label for="recipients">Numery odbiorców</label>
      ${textarea('recipients', v.recipients, 6, ' placeholder="601 000 011 Marek Kowalski\n601 000 012\n601 000 013 Jan Wiśniewski"')}
      ${hint('Lista służy wyłącznie akcji „Wyślij SMS do grupy”. Jeden numer w wierszu, po numerze opcjonalna nazwa, do 500 numerów. Pole nie jest wymagane. Przy pustej liście akcja „Wyślij SMS do grupy” kończy się błędem, a pozostałe akcje działają.')}
    </div>
  </details>`;
}

function sectionText(v: PaFormValues): string {
  return `<details open>
    <summary>Treść</summary>
    <div class="field">
      <label>Limit części</label>
      <div class="inline">
        <input name="maxParts" type="number" min="1" max="9" value="${esc(v.maxParts)}" style="width: 90px;">
        <div class="choices">${radio('overflow', 'truncate', v.overflow, 'skróć i wyślij')}${radio('overflow', 'reject', v.overflow, 'nie wysyłaj, zapisz błąd i powiadom')}</div>
      </div>
      ${hint('Limit obowiązuje SMS do jednego numeru, każdą treść w rozsyłce oraz SMS do grupy. Treść przygotowuje przepływ. Przy odrzuceniu przepływ otrzymuje błąd z liczbą części, a administrator powiadomienie.')}
    </div>
  </details>`;
}

const GUARD: GuardWords = {
  unit: 'wywołań',
  throttleHint: 'Wywołania ponad limit w oknie kończą się błędem i wpisem „limit”, bez wysłania SMS-a. Ochrona zabezpiecza konto przed skutkami zapętlonego przepływu. Pierwsze przekroczenie w oknie jest zgłaszane mailem do administratora',
  payloadHint: 'Przydatne podczas uruchamiania: dziennik pokazuje, co przysłał przepływ. Ładunki zawierają numery i treści, dlatego opcję zaleca się włączać tylko na czas konfiguracji.',
};

/** Limit odbiorców w oknie ochrony przed burzą, w tym samym oknie co limit wywołań. */
function recipientLimitField(v: PaFormValues): string {
  return `<div class="field">
      <label for="throttleRecipients">Limit odbiorców</label>
      <div class="inline">
        <input id="throttleRecipients" name="throttleRecipients" type="number" min="1" max="${PA_RECIPIENT_LIMIT_MAX}" value="${esc(v.throttleRecipients)}" style="width: 110px;"> <span class="dim">odbiorców w tym samym oknie</span>
      </div>
      ${hint('Liczy numery ze wszystkich wywołań w oknie. SMS do jednego numeru zajmuje jedno miejsce, a rozsyłka i SMS do grupy tyle miejsc, ilu obejmują odbiorców. Wywołanie, które przekroczyłoby limit, kończy się błędem i wpisem „limit”.')}
    </div>`;
}

/**
 * Tryb prosty ukrywa ochronę przed burzą. Gdy ktoś zmienił ją w trybie zaawansowanym, administrator
 * edytujący integrację w trybie prostym widzi bieżące wartości, zanim zapisze je ponownie.
 */
function guardSummary(v: PaFormValues): string {
  const d = defaultPowerAutomateConfig().throttle;
  if (v.throttleLimit === String(d.limit) && v.throttleWindow === String(d.windowMinutes) && v.throttleRecipients === String(d.recipients)) return '';
  const n = (raw: string) => Number.parseInt(raw, 10) || 0;
  return hint(`Ochrona przed burzą: najwyżej ${countForms(n(v.throttleLimit), 'wywołanie', 'wywołania', 'wywołań')} i ${countForms(n(v.throttleRecipients), 'odbiorca', 'odbiorców', 'odbiorców')} w ciągu ${countForms(n(v.throttleWindow), 'minuty', 'minut', 'minut')}. Wartości zmienia tryb zaawansowany`);
}

export function paFormPage(ctx: FormContext, v: PaFormValues, opts: PaFormOptions): string {
  const edit = ctx.row !== undefined;
  const advanced = opts.mode === 'zaawansowany';
  const action = edit ? `/integracje/${ctx.row!.id}/edytuj` : '/integracje';
  const guide = `<details class="panel" style="max-width: 760px; padding: 0;">
      <summary style="padding: 12px 16px;">Jak działa Power Automate</summary>
      <div class="guide" style="padding: 0 16px 12px; font-size: 12.5px; line-height: 1.55;">${guideHtml(ctx.preset.guide)}</div>
    </details>`;
  const hidden = `<input type="hidden" name="throttleLimit" value="${esc(v.throttleLimit)}"><input type="hidden" name="throttleWindow" value="${esc(v.throttleWindow)}"><input type="hidden" name="throttleRecipients" value="${esc(v.throttleRecipients)}"><input type="hidden" name="eventLogLimit" value="${esc(v.eventLogLimit)}">${v.storePayloads ? '<input type="hidden" name="storePayloads" value="1">' : ''}${guardSummary(v)}`;
  const crumbTail = edit ? 'edycja' : `<a href="/integracje/nowa">nowa</a> / <a href="/integracje/nowa?rodzaj=webhook_in">${esc(kindLabel('power_automate'))}</a>`;
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/integracje">Integracje</a> / ${crumbTail}</div>
      <h1 class="h1">${edit ? esc(ctx.row!.name) : 'Nowa integracja'}</h1>
      <p class="sub">${esc(kindLabel('power_automate'))} · ${esc(ctx.preset.name)}</p>
    </div>
  </div>
  <div class="scroll">
    ${modeSwitch(ctx, opts.mode)}
    ${opts.error ? `<div class="warn">${esc(opts.error)}</div>` : ''}
    ${guide}
    <div class="panel" style="max-width: 760px;">
      <form class="form" method="post" action="${action}" autocomplete="off">
        <input type="hidden" name="kind" value="power_automate">
        <input type="hidden" name="preset" value="${esc(ctx.preset.id)}">
        <input type="hidden" name="tryb" value="${opts.mode}">
        ${sectionBasics(ctx, v, { nameHint: 'Pod tą nazwą integracja pojawia się w Power Automate w polu „Integracja”' })}
        ${sectionRecipients(v)}
        ${sectionText(v)}
        ${advanced ? sectionGuard(v, { ...GUARD, extraField: recipientLimitField(v) }) : hidden}
        <div class="bar">
          <button class="btn btn-p" type="submit">${edit ? 'Zapisz integrację' : 'Utwórz integrację'}</button>
        </div>
      </form>
    </div>
    ${powerAutomatePanel(opts.apiUrl, formUrl(ctx, opts.mode))}
  </div>`;
}
