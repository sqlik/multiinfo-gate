import type { SmsGroupPreview } from '../../integrations/pipeline.ts';
import type { GroupFormValues } from '../group-form.ts';
import { checkbox, guideHtml, kindLabel, radio, ruleRows, sectionBasics, sectionGuard, textarea, type FormContext } from './integrations.ts';
import { esc } from './layout.ts';

export interface GroupFormOptions {
  mode: 'prosty' | 'zaawansowany';
  error?: string;
  preview?: SmsGroupPreview;
  /** Dlaczego formularz otworzył się zaawansowany, choć proszono o prosty. */
  note?: string;
}

const hint = (text: string) => `<div class="hint">${esc(text)}</div>`;
const MEMBER_HINT = 'Jeden numer w wierszu, po numerze opcjonalna nazwa, np. 601 000 001 Ania';

function modeSwitch(ctx: FormContext, mode: 'prosty' | 'zaawansowany'): string {
  const base = ctx.row ? `/integracje/${ctx.row.id}/edytuj` : `/integracje/nowa?rodzaj=sms_group&ustawienie=${ctx.preset.id}`;
  const join = base.includes('?') ? '&' : '?';
  return `<div class="bar" style="gap: 10px; margin-bottom: 12px; align-items: center;">
    <div class="seg">
      <a href="${esc(`${base}${join}tryb=prosty`)}"${mode === 'prosty' ? ' class="on"' : ''}>Prosty</a>
      <a href="${esc(`${base}${join}tryb=zaawansowany`)}"${mode === 'zaawansowany' ? ' class="on"' : ''}>Zaawansowany</a>
    </div>
    <span class="dim" style="font-size: 12px;">${mode === 'prosty'
      ? 'Listy numerów, prefiks, treść, limit części i potwierdzenie. Tryb zaawansowany udostępnia warunek, szablon Liquid i ochronę przed burzą.'
      : 'Warunek, szablon Liquid, ochrona przed burzą, dziennik i próbka.'}</span>
  </div>`;
}

/** Spec 6.1 p. 2: tryb dwoma polami opcji, trzy listy; pola trybu nieaktywnego chowa skrypt panelu, bez skryptu wszystkie są widoczne. */
function sectionWho(v: GroupFormValues): string {
  return `<details open>
    <summary>Kto i do kogo</summary>
    <div class="field">
      <label>Tryb grupy</label>
      <div class="choices">${radio('mode', 'lists', v.mode, 'Osobne listy')}${radio('mode', 'closed', v.mode, 'Grupa zamknięta')}</div>
      ${hint('Osobne listy: wskazane numery piszą, inne numery odbierają. Grupa zamknięta: jedna lista członków, każdy pisze do pozostałych')}
    </div>
    <div data-show="mode=lists">
      <div class="field">
        <label for="senders">Numery uprawnione do pisania</label>
        ${textarea('senders', v.senders, 4, ' placeholder="601 000 001 Ania\n601 000 002"')}
        ${hint(`${MEMBER_HINT}. Do 100 numerów`)}
      </div>
      <div class="field">
        <label for="recipients">Numery odbiorców</label>
        ${textarea('recipients', v.recipients, 6, ' placeholder="601 000 003 Basia\n601 000 004\n601 000 005"')}
        ${hint(`${MEMBER_HINT}. Do 500 numerów`)}
      </div>
    </div>
    <div data-show="mode=closed">
      <div class="field">
        <label for="members">Numery członków</label>
        ${textarea('members', v.members, 6, ' placeholder="601 000 001 Ania\n601 000 002 Basia\n601 000 003"')}
        ${hint(`${MEMBER_HINT}. Od 2 do 500 numerów`)}
      </div>
    </div>
  </details>`;
}

function sectionPrefix(v: GroupFormValues): string {
  return `<details open>
    <summary>Prefiks</summary>
    <div class="field">
      <label for="prefix">Słowo wybierające grupę</label>
      <input id="prefix" name="prefix" value="${esc(v.prefix)}" placeholder="dzieci" maxlength="20" style="max-width: 240px;">
      ${hint('Słowo na początku SMS-a, które wybiera tę grupę. Wielkość liter bez znaczenia, po słowie spacja albo dwukropek. Puste pole oznacza każdy SMS od uprawnionego numeru')}
    </div>
  </details>`;
}

function sectionText(v: GroupFormValues, advanced: boolean): string {
  return `<details open>
    <summary>Treść</summary>
    <div class="field">
      <label>Co otrzymują odbiorcy</label>
      <div class="choices">
        ${radio('textMode', 'body', v.textMode, 'Sama treść')}<span class="dim m" style="font-size: 12px;">jutro zbiórka 8:00</span>
        ${radio('textMode', 'sender_body', v.textMode, 'Nadawca i treść')}<span class="dim m" style="font-size: 12px;">Ania: jutro zbiórka 8:00</span>
        ${advanced ? radio('textMode', 'liquid', v.textMode, 'Szablon Liquid') : ''}
      </div>
      ${hint('Nadawca to nazwa przy numerze na liście, a bez nazwy sam numer')}
    </div>
    ${advanced ? `<div class="field">
      <label for="textTemplate">Szablon Liquid</label>
      ${textarea('textTemplate', v.textTemplate, 3, ' placeholder="{{ sender }} do grupy: {{ body }}"')}
      ${hint('Zmienne: body, prefix, sender, sender_name, recipients, from, to, text, serviceId, receivedAt, id, now, integration.name. Filtr sms_truncate: n skraca do n znaków')}
    </div>` : ''}
    <div class="field">
      <label>Limit części</label>
      <div class="inline">
        <input name="maxParts" type="number" min="1" max="9" value="${esc(v.maxParts)}" style="width: 90px;">
        <div class="choices">${radio('overflow', 'truncate', v.overflow, 'skróć i wyślij')}${radio('overflow', 'reject', v.overflow, 'nie wysyłaj, zapisz błąd i powiadom')}</div>
      </div>
      ${hint('Każdy odbiorca dostaje tyle części, ile ma wiadomość. Przy odrzuceniu nadawca z włączonym potwierdzeniem otrzymuje informację o długości')}
    </div>
  </details>`;
}

function sectionConfirm(v: GroupFormValues): string {
  return `<details open>
    <summary>Potwierdzenie</summary>
    <div class="field">
      ${checkbox('confirmEnabled', v.confirmEnabled, 'Odsyłaj nadawcy potwierdzenie z liczbą odbiorców')}
      ${hint('Potwierdzenie jest zwykłą wiadomością konta i kosztuje jak każda. Idzie wyłącznie do numeru z listy, po rozesłaniu albo po odrzuceniu z powodu długości. SMS pominięty zostaje bez odpowiedzi')}
    </div>
  </details>`;
}

function sectionWhen(v: GroupFormValues): string {
  return `<details${v.rules.length > 0 || v.conditionMode === 'liquid' ? ' open' : ''}>
    <summary>Kiedy wysyłać</summary>
    <div class="field">
      <div class="choices">${radio('conditionMode', 'builder', v.conditionMode, 'Reguły')}${radio('conditionMode', 'liquid', v.conditionMode, 'Wyrażenie Liquid')}</div>
    </div>
    <div class="field">
      <label>Reguły</label>
      ${ruleRows(v.rules, 'pole, np. body albo sender')}
      ${hint('Bez reguł każdy SMS od uprawnionego numeru z prefiksem jest rozsyłany. Wszystkie reguły muszą być spełnione. Pola: body, prefix, sender, sender_name, from, text')}
    </div>
    <div class="field">
      <label for="conditionExpr">Wyrażenie</label>
      ${textarea('conditionExpr', v.conditionExpr, 2, ' placeholder="{% if body contains \'pilne\' %}tak{% endif %}"')}
      ${hint('Pusty wynik, false albo 0 oznacza „nie wysyłaj”')}
    </div>
  </details>`;
}

function sectionSample(v: GroupFormValues): string {
  return `<details open>
    <summary>Próbka do sprawdzenia</summary>
    <div class="field">
      <label for="sampleFrom">Numer nadawcy</label>
      <input id="sampleFrom" name="sampleFrom" value="${esc(v.sampleFrom)}" placeholder="pierwszy numer z listy" style="max-width: 240px;">
    </div>
    <div class="field">
      <label for="sampleText">Treść SMS-a</label>
      ${textarea('sampleText', v.sampleText, 2, ' placeholder="dzieci Jutro zbiórka o 8:00"')}
      ${hint('Przycisk „Sprawdź” pokazuje, czy nadawca jest na liście, czy prefiks pasuje, kto otrzyma SMS i jak będzie wyglądał. Niczego nie wysyła ani nie zapisuje. Puste pola oznaczają pierwszy numer z listy i przykładową treść z prefiksem')}
    </div>
  </details>`;
}

function previewPanel(p: SmsGroupPreview): string {
  const rows: string[] = [];
  rows.push(`<div>Nadawca</div><div>${p.senderAllowed ? '<span class="st"><span class="dot dot-ok"></span>Nadawca na liście</span>' : '<span class="st"><span class="dot dot-fail"></span>Nadawca spoza listy: wiadomość zostałaby pominięta</span>'}</div>`);
  rows.push(`<div>Prefiks</div><div>${p.prefixMatched ? '<span class="st"><span class="dot dot-ok"></span>Prefiks pasuje</span>' : '<span class="st"><span class="dot dot-fail"></span>Prefiks nie pasuje: wiadomość zostałaby pominięta</span>'}</div>`);
  rows.push(`<div>Treść po zdjęciu prefiksu</div><div>${p.body === '' ? '<span class="dim">pusta</span>' : `<pre class="m" style="white-space: pre-wrap; margin: 0;">${esc(p.body)}</pre>`}</div>`);
  rows.push(`<div>Odbiorcy</div><div class="m">${p.recipients.length > 0 ? `${esc(p.recipients.join(', '))} <span class="dim">(${esc(p.recipients.length)})</span>` : '<span class="fail">brak</span>'}</div>`);
  rows.push(`<div>SMS</div><div>${p.text ? `<div class="ruler" style="padding: 0 0 4px;">${esc(p.text)}</div>` : '<span class="dim">pusty</span>'}</div>`);
  rows.push(`<div>Części</div><div class="m">${esc(p.parts)}</div>`);
  rows.push(`<div>Potwierdzenie</div><div>${p.confirm === null ? '<span class="dim">wyłączone</span>' : `<span class="m">${esc(p.confirm)}</span>`}</div>`);
  return `<div class="panel" style="max-width: 760px;">
    <div class="panel-h"><div class="lab">Podgląd z próbki</div><div class="m dim">bez zapisu i bez wysyłki</div></div>
    ${p.error === null ? '' : `<div class="warn">${esc(p.error)}</div>`}
    <div class="kv">${rows.join('')}</div>
  </div>`;
}

export function groupFormPage(ctx: FormContext, v: GroupFormValues, opts: GroupFormOptions): string {
  const edit = ctx.row !== undefined;
  const advanced = opts.mode === 'zaawansowany';
  const action = edit ? `/integracje/${ctx.row!.id}/edytuj` : '/integracje';
  const guide = ctx.preset.guide === '' ? '' : `<details class="panel" style="max-width: 760px; padding: 0;">
      <summary style="padding: 12px 16px;">Jak działa SMS do grupy</summary>
      <div class="guide" style="padding: 0 16px 12px; font-size: 12.5px; line-height: 1.55;">${guideHtml(ctx.preset.guide)}</div>
    </details>`;
  const crumbTail = edit ? 'edycja' : `<a href="/integracje/nowa">nowa</a> / ${esc(kindLabel('sms_group'))}`;
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/integracje">Integracje</a> / ${crumbTail}</div>
      <h1 class="h1">${edit ? esc(ctx.row!.name) : 'Nowa grupa'}</h1>
      <p class="sub">${esc(kindLabel('sms_group'))} · ${esc(ctx.preset.name)}</p>
    </div>
  </div>
  <div class="scroll">
    ${modeSwitch(ctx, opts.mode)}
    ${opts.note ? `<div class="warn">${esc(opts.note)}</div>` : ''}
    ${opts.error ? `<div class="warn">${esc(opts.error)}</div>` : ''}
    ${guide}
    ${opts.preview ? previewPanel(opts.preview) : ''}
    <div class="panel" style="max-width: 760px;">
      <form class="form" method="post" action="${action}" autocomplete="off">
        <input type="hidden" name="kind" value="sms_group">
        <input type="hidden" name="preset" value="${esc(ctx.preset.id)}">
        <input type="hidden" name="tryb" value="${opts.mode}">
        ${sectionBasics(ctx, v)}
        ${sectionWho(v)}
        ${sectionPrefix(v)}
        ${sectionText(v, advanced)}
        ${sectionConfirm(v)}
        ${advanced ? sectionWhen(v) : '<input type="hidden" name="conditionMode" value="builder">'}
        ${advanced ? sectionGuard(v) : `<input type="hidden" name="throttleLimit" value="${esc(v.throttleLimit)}"><input type="hidden" name="throttleWindow" value="${esc(v.throttleWindow)}"><input type="hidden" name="eventLogLimit" value="${esc(v.eventLogLimit)}">${v.storePayloads ? '<input type="hidden" name="storePayloads" value="1">' : ''}`}
        ${advanced ? sectionSample(v) : ''}
        ${ctx.preset.warning ? `<div class="notice">${esc(ctx.preset.warning)}</div>` : ''}
        <div class="bar">
          <button class="btn btn-s" type="submit" name="action" value="sprawdz">Sprawdź</button>
          <button class="btn btn-p" type="submit" name="action" value="zapisz">${edit ? 'Zapisz grupę' : 'Utwórz grupę'}</button>
        </div>
      </form>
    </div>
  </div>`;
}
