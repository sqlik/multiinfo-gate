import type { IntegrationKind } from '../../integrations/config.ts';
import type { Preset } from '../../integrations/presets/index.ts';
import type { SimpleValues } from '../simple-form.ts';
import { esc } from './layout.ts';
import { guideHtml, hookPath, hookReveal, kindLabel, type CreatedHook, type FormContext } from './integrations.ts';
import { fullUrl } from './settings.ts';

/** Co formularz prosty ma pokazać poza polami: błąd, świeży adres, podglądy wariantów treści. */
export interface SimplePageOptions {
  error?: string;
  created?: CreatedHook;
  /** Wynik każdego wariantu „co w SMS-ie” na próbce ustawienia - użytkownik wybiera po wyniku, nie po szablonie. */
  textPreviews: Record<string, string>;
}

const radio = (name: string, value: string, current: string, label: string, example = '') =>
  `<label class="choice" style="align-items: flex-start;"><input type="radio" name="${esc(name)}" value="${esc(value)}"${current === value ? ' checked' : ''} style="margin-top: 3px;">
    <span>${esc(label)}${example === '' ? '' : `<span class="dim" style="display: block; font-size: 11.5px; margin-top: 2px;">Przykład: <span class="m" style="color: var(--ink);">${esc(example)}</span></span>`}</span></label>`;

/** Przełącznik trybu: odnośniki GET, bo zmiana trybu rysuje inny formularz z tych samych zapisanych danych. */
export function modeSwitch(ctx: FormContext, mode: 'prosty' | 'zaawansowany'): string {
  const base = ctx.row ? `/integracje/${ctx.row.id}/edytuj` : `/integracje/nowa?rodzaj=${ctx.kind}&ustawienie=${ctx.preset.id}`;
  const join = base.includes('?') ? '&' : '?';
  return `<div class="bar" style="gap: 10px; margin-bottom: 12px; align-items: center;">
    <div class="seg">
      <a href="${esc(`${base}${join}tryb=prosty`)}"${mode === 'prosty' ? ' class="on"' : ''}>Prosty</a>
      <a href="${esc(`${base}${join}tryb=zaawansowany`)}"${mode === 'zaawansowany' ? ' class="on"' : ''}>Zaawansowany</a>
    </div>
    <span class="dim" style="font-size: 12px;">${mode === 'prosty'
      ? 'Wybór z list, bez szablonów. Tryb zaawansowany pokazuje te same ustawienia w polach silnika.'
      : 'Pola silnika: ścieżki w ładunku, szablony Liquid, reguły. Tryb prosty pokazuje je jako listy wyboru, jeśli się w nich mieszczą.'}</span>
  </div>`;
}

function keyField(ctx: FormContext, sv: SimpleValues): string {
  if (ctx.row) {
    const key = ctx.keys.find((k) => k.id === ctx.row!.apiKeyId);
    return `<div class="field"><label>Konto i klucz API</label><div class="box">${esc(key ? `${key.name} · ${key.accountName}` : `klucz ${ctx.row.apiKeyId}`)}</div></div>`;
  }
  return `<div class="field">
      <label for="apiKeyId">Konto i klucz API</label>
      <select id="apiKeyId" name="apiKeyId">
        ${ctx.keys.map((k) => `<option value="${esc(k.id)}"${sv.apiKeyId === String(k.id) ? ' selected' : ''}>${esc(k.name)} · ${esc(k.accountName)}</option>`).join('')}
      </select>
      <div class="hint">SMS-y pójdą z konta Multiinfo tego klucza, z jego domyślnej usługi i nadpisu nadawcy</div>
    </div>`;
}

function secretField(ctx: FormContext, label: string, where: string): string {
  const saved = ctx.secretNames.length > 0;
  return `<div class="field">
      <label for="secret">${esc(label)}</label>
      <div class="inline">
        <input id="secret" name="secret" type="password" autocomplete="off" placeholder="${saved ? 'zapisane - puste pole zostawia dotychczasowe' : 'wpisz albo wygeneruj'}" style="flex: 1;">
        <button class="btn btn-s" type="button" data-generate="#secret">Wygeneruj</button>
      </div>
      <div class="hint">To samo hasło wpisz ${esc(where)}. Bramka odrzuca żądania bez niego. Zapisujemy je zaszyfrowane; potem da się tylko ustawić nowe.</div>
    </div>`;
}

function inboundSections(ctx: FormContext, sv: SimpleValues, opts: SimplePageOptions): string {
  const simple = ctx.preset.simple!.inbound!;
  const numbers = `<div class="field">
      <label for="numbers">${simple.recipients.source === 'list' ? 'Numery telefonów' : 'Numery zapasowe'}</label>
      <textarea id="numbers" name="numbers" rows="3" placeholder="601 000 001&#10;+48 602 000 002">${esc(sv.numbers)}</textarea>
      <div class="hint">${esc(simple.recipients.note)} Jeden numer na linię; dziewięć cyfr dostaje kod kraju konta</div>
    </div>`;
  const when = simple.when.map((w) => radio('whenId', w.id, sv.whenId, w.label)).join('');
  const texts = simple.text.map((t) => radio('textId', t.id, sv.textId, t.label, opts.textPreviews[t.id] ?? '')).join('');
  const auth = simple.auth.kind === 'none'
    ? `<div class="field"><label>Zabezpieczenie</label><div class="hint" style="margin-top: 0;">${esc(simple.auth.note)}</div></div>`
    : secretField(ctx, simple.auth.label, simple.auth.where);
  return `<details open><summary>1. Nazwa i konto</summary>
      <div class="field"><label for="name">Nazwa integracji</label><input id="name" name="name" value="${esc(sv.name)}" required></div>
      ${keyField(ctx, sv)}
      ${ctx.row ? `<div class="field"><label class="choice"><input type="checkbox" name="enabled" value="1"${sv.enabled ? ' checked' : ''}> Włączona</label></div>` : '<input type="hidden" name="enabled" value="1">'}
    </details>
    <details open><summary>2. Kto ma dostać SMS</summary>${numbers}</details>
    <details open><summary>3. Kiedy wysyłać SMS</summary>
      <div class="field"><div class="choices" style="flex-direction: column; gap: 8px;">${when}</div></div>
    </details>
    <details open><summary>4. Co ma być w SMS-ie</summary>
      <div class="field"><div class="choices" style="flex-direction: column; gap: 10px;">${texts}</div>
      <div class="hint">Przykłady policzone z prawdziwego zdarzenia z ${esc(ctx.preset.name)}; inną treść ustawisz w trybie zaawansowanym</div></div>
    </details>
    <details open><summary>5. Zabezpieczenie</summary>${auth}</details>`;
}

function outboundSections(ctx: FormContext, sv: SimpleValues): string {
  const simple = ctx.preset.simple!.outbound!;
  const secrets = simple.secrets.map((s) => {
    const saved = ctx.secretNames.length > 0;
    return `<div class="field">
      <label for="secret_${esc(s.ref)}">${esc(s.label)}</label>
      <input id="secret_${esc(s.ref)}" name="secret_${esc(s.ref)}" type="password" autocomplete="off" placeholder="${saved ? 'zapisany - puste pole zostawia dotychczasowy' : ''}">
      <div class="hint">${esc(s.hint)}. Zapisujemy zaszyfrowany; potem da się tylko ustawić nowy.</div>
    </div>`;
  }).join('');
  const params = simple.params.map((p) => `<div class="field">
      <label for="param_${esc(p.key)}">${esc(p.label)}</label>
      <input id="param_${esc(p.key)}" name="param_${esc(p.key)}" value="${esc(sv.params[p.key] ?? '')}"${p.digits ? ' inputmode="numeric"' : ''} style="max-width: 200px;">
      <div class="hint">${esc(p.hint)}</div>
    </div>`).join('');
  return `<details open><summary>1. Nazwa i konto</summary>
      <div class="field"><label for="name">Nazwa integracji</label><input id="name" name="name" value="${esc(sv.name)}" required></div>
      ${keyField(ctx, sv)}
      ${ctx.row ? `<div class="field"><label class="choice"><input type="checkbox" name="enabled" value="1"${sv.enabled ? ' checked' : ''}> Włączona</label></div>` : '<input type="hidden" name="enabled" value="1">'}
      <div class="hint">${esc(simple.note)}</div>
    </details>
    <details open><summary>2. Gdzie wysyłać</summary>
      <div class="field">
        <label for="url">${esc(simple.address.label)}</label>
        <input id="url" name="url" type="url" value="${esc(sv.url)}" placeholder="${esc(simple.address.placeholder)}" required>
        <div class="hint">${esc(simple.address.hint)}</div>
      </div>
      ${params}
    </details>
    ${secrets === '' ? '' : `<details open><summary>3. Dostęp do aplikacji</summary>${secrets}</details>`}`;
}

export function simpleFormPage(ctx: FormContext, sv: SimpleValues, opts: SimplePageOptions): string {
  const edit = ctx.row !== undefined;
  const action = edit ? `/integracje/${ctx.row!.id}/edytuj` : '/integracje';
  const inbound = ctx.kind === 'webhook_in';
  const addressField = ctx.preset.simple?.inbound?.addressField;
  const address = edit && inbound && ctx.row!.hookId !== null && !opts.created ? `<div class="panel" style="max-width: 760px;">
      <div class="panel-h"><div class="lab">Adres do wklejenia ${esc(addressField ?? 'w aplikacji')}</div>
        <form method="post" action="/integracje/${esc(ctx.row!.id)}/nowy-adres" data-confirm="Wygenerować nowy adres? Stary przestanie działać natychmiast - trzeba go podmienić w aplikacji." data-confirm-ok="Wygeneruj">
          <button class="btn btn-s" type="submit">Wygeneruj nowy</button>
        </form>
      </div>
      <div class="keyline">
        <div class="keybox" id="hook-path">${esc(fullUrl(ctx.apiUrl, hookPath(ctx.row!.hookId)))}</div>
        <button class="btn btn-s" type="button" data-copy="#hook-path">Kopiuj</button>
      </div>
      ${ctx.apiUrl === null ? '<div class="hint" style="padding: 0 16px 12px;">To sama ścieżka - panel nie zna jeszcze adresu bramki. Podaj go na ekranie Klucze API, a tu pojawi się pełny adres.</div>' : ''}
    </div>` : '';
  const guide = ctx.preset.guide === '' ? '' : `<details class="panel" style="max-width: 760px; padding: 0;">
      <summary style="padding: 12px 16px;">Co ustawić po stronie ${esc(ctx.preset.name)}</summary>
      <div class="guide" style="padding: 0 16px 12px; font-size: 12.5px; line-height: 1.55;">${guideHtml(ctx.preset.guide)}</div>
    </details>`;
  const crumbTail = edit ? 'edycja' : `<a href="/integracje/nowa">nowa</a> / ${esc(kindLabel(ctx.kind))} / ${esc(ctx.preset.name)}`;
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/integracje">Integracje</a> / ${crumbTail}</div>
      <h1 class="h1">${edit ? esc(ctx.row!.name) : esc(ctx.preset.name)}</h1>
      <p class="sub">${esc(ctx.preset.blurb)}</p>
    </div>
  </div>
  <div class="scroll">
    ${modeSwitch(ctx, 'prosty')}
    ${opts.error ? `<div class="warn">${esc(opts.error)}</div>` : ''}
    ${opts.created ? hookReveal(opts.created, ctx.apiUrl, addressField) : ''}
    ${address}
    ${guide}
    ${inbound && !edit ? `<div class="dim" style="max-width: 760px; margin-bottom: 12px; font-size: 12.5px;">Po zapisaniu dostaniesz adres do wklejenia ${esc(addressField ?? 'w aplikacji')} i instrukcję krok po kroku</div>` : ''}
    <div class="panel" style="max-width: 760px;">
      <form class="form" method="post" action="${action}">
        <input type="hidden" name="kind" value="${esc(ctx.kind)}">
        <input type="hidden" name="preset" value="${esc(ctx.preset.id)}">
        <input type="hidden" name="tryb" value="prosty">
        ${inbound ? inboundSections(ctx, sv, opts) : outboundSections(ctx, sv)}
        <div class="bar">
          <button class="btn btn-p" type="submit" name="action" value="zapisz">${edit ? 'Zapisz integrację' : 'Utwórz integrację'}</button>
        </div>
      </form>
    </div>
  </div>`;
}
