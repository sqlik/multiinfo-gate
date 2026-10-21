import { MAIL_IN_INTERVALS } from '../../integrations/config.ts';
import type { MailInPreview } from '../../integrations/pipeline.ts';
import type { checkMailbox } from '../../worker/mail-in.ts';
import type { MailFieldValues, MailFormValues } from '../mail-form.ts';
import { checkbox, guideHtml, intervalWords, kindLabel, radio, ruleRows, sectionBasics, sectionGuard, textarea, type FormContext } from './integrations.ts';
import { esc } from './layout.ts';

export type MailConnection = Awaited<ReturnType<typeof checkMailbox>>;

export interface MailFormOptions {
  mode: 'prosty' | 'zaawansowany';
  hasPassword: boolean;
  error?: string;
  connection?: MailConnection;
  preview?: MailInPreview;
  warnings?: string[];
  /** Dlaczego formularz otworzył się zaawansowany, choć proszono o prosty. */
  note?: string;
  /** SMTP nieskonfigurowane: odpowiedzi do nadawcy nie zadziałają. */
  smtpConfigured: boolean;
}

const MAX_FIELD_ROWS = 20;
const SPARE_FIELD_ROWS = 2;
const EMPTY_FIELD: MailFieldValues = { name: '', mode: 'between', after: '', until: '', pattern: '', flags: '' };

const hint = (text: string) => `<div class="hint">${esc(text)}</div>`;

function modeSwitch(ctx: FormContext, mode: 'prosty' | 'zaawansowany'): string {
  const base = ctx.row ? `/integracje/${ctx.row.id}/edytuj` : `/integracje/nowa?rodzaj=mail_in&ustawienie=${ctx.preset.id}`;
  const join = base.includes('?') ? '&' : '?';
  return `<div class="bar" style="gap: 10px; margin-bottom: 12px; align-items: center;">
    <div class="seg">
      <a href="${esc(`${base}${join}tryb=prosty`)}"${mode === 'prosty' ? ' class="on"' : ''}>Prosty</a>
      <a href="${esc(`${base}${join}tryb=zaawansowany`)}"${mode === 'zaawansowany' ? ' class="on"' : ''}>Zaawansowany</a>
    </div>
    <span class="dim" style="font-size: 12px;">${mode === 'prosty'
      ? 'Wybór z list, bez szablonów. Tryb zaawansowany dokłada szablon Liquid, wyrażenia regularne i sprawdzanie certyfikatu.'
      : 'Szablon Liquid, wyrażenia regularne w wycinkach, warunek Liquid, sprawdzanie certyfikatu.'}</span>
  </div>`;
}

function sectionMailbox(v: MailFormValues, opts: MailFormOptions): string {
  const advanced = opts.mode === 'zaawansowany';
  const securities: Array<[MailFormValues['security'], string]> = [['tls', 'TLS (szyfrowane od początku, port 993)'], ['starttls', 'STARTTLS (szyfrowanie po powitaniu, port 143)'], ['none', 'brak (jawnym tekstem, port 143)']];
  return `<details open>
    <summary>Skrzynka</summary>
    <div class="field">
      <label for="host">Serwer IMAP</label>
      <div class="inline">
        <input id="host" name="host" value="${esc(v.host)}" placeholder="imap.przyklad.pl" style="flex: 1;" required>
        <span class="dim">port</span>
        <input id="port" name="port" type="number" min="1" max="65535" value="${esc(v.port)}" style="width: 110px;">
      </div>
    </div>
    <div class="field">
      <label for="security">Zabezpieczenie</label>
      <select id="security" name="security">${securities.map(([id, label]) => `<option value="${id}"${v.security === id ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
      ${hint('Przy „brak” hasło i treść maili idą po sieci jawnym tekstem. Tylko w sieci wewnętrznej')}
    </div>
    ${advanced ? `<div class="field">
      ${checkbox('verifyCert', v.verifyCert, 'Sprawdzaj certyfikat serwera')}
      ${hint('Wyłącz tylko dla serwera z własnym certyfikatem bez zaufanego urzędu. Bez sprawdzania połączenie jest podatne na podsłuch')}
    </div>` : `<input type="hidden" name="verifyCert" value="${v.verifyCert ? '1' : '0'}">`}
    <div class="field">
      <label for="user">Login</label>
      <input id="user" name="user" value="${esc(v.user)}" placeholder="bramka@przyklad.pl" autocomplete="off" required>
    </div>
    <div class="field">
      <label for="password">Hasło</label>
      <input id="password" name="password" type="password" value="" autocomplete="new-password"${opts.hasPassword ? '' : ' required'}>
      ${hint(opts.hasPassword ? 'Skrzynka ma hasło zapisane. Puste pole zostawia dotychczasowe' : 'Hasło zapisujemy zaszyfrowane; nie da się go potem odczytać w panelu. U Gmaila to hasło aplikacji')}
    </div>
    <div class="field">
      <label for="folder">Folder</label>
      <input id="folder" name="folder" value="${esc(v.folder)}" placeholder="INBOX">
      ${hint('Bramka bierze tylko maile nieprzeczytane. Skrzynka albo folder powinny należeć do bramki: mail otwarty przez człowieka w programie pocztowym staje się przeczytany i SMS nie pójdzie')}
    </div>
    <div class="field">
      <label for="intervalSec">Częstotliwość sprawdzania</label>
      <select id="intervalSec" name="intervalSec">${MAIL_IN_INTERVALS.map((sec) => `<option value="${sec}"${v.intervalSec === String(sec) ? ' selected' : ''}>co ${esc(intervalWords(sec))}</option>`).join('')}</select>
      ${hint('Po odczytaniu maila SMS idzie natychmiast. Częściej niż co 30 s nie da się, bo dostawcy poczty odcinają zbyt częste logowania')}
    </div>
    <div class="field">
      ${checkbox('backlog', v.backlog, 'Przetwórz też zaległe nieprzeczytane')}
      ${hint('Domyślnie bramka bierze tylko maile, które przyjdą po zapisaniu. To pole każe jej wziąć także zaległe nieprzeczytane, przy najbliższym sprawdzeniu, po 50 na raz. Przy 300 zaległych mailach ochrona przed burzą zatrzyma wysyłkę na limicie integracji, a reszta trafi do dziennika jako „limit”')}
    </div>
    <div class="field">
      <button class="btn btn-s" type="submit" name="action" value="polaczenie">Sprawdź połączenie</button>
      ${hint('Bramka loguje się, otwiera folder i pokazuje liczbę nieprzeczytanych oraz listę folderów. Nic nie przetwarza i nic nie zapisuje')}
    </div>
  </details>`;
}

function sectionSenders(v: MailFormValues): string {
  return `<details open>
    <summary>Kto może wysyłać</summary>
    <div class="field">
      <label for="senders">Nadawcy</label>
      ${textarea('senders', v.senders, 5, ' placeholder="tomek@plus.pl: 601000001, 601000002\n@sqlik.com\nups@przyklad.pl"')}
      ${hint('Jedna pozycja w linii: pełny adres albo cała domena z małpą. Po dwukropku można dopisać numery, na które mają iść SMS-y od tego nadawcy. Pusta lista oznacza, że żaden mail nie przejdzie')}
    </div>
    <div class="field">
      ${checkbox('requireAuthResults', v.requireAuthResults, 'Wymagaj potwierdzenia nadawcy przez serwer (SPF/DKIM)')}
      ${hint('Ma sens u dostawców publicznych (Gmail, home.pl, OVH). Serwery wewnętrzne zwykle nie dopisują tych nagłówków i wtedy każdy mail zostanie odrzucony')}
    </div>
  </details>`;
}

function sectionRecipients(v: MailFormValues): string {
  return `<details open>
    <summary>Do kogo</summary>
    <div class="field">
      <label for="toFallback">Odbiorcy</label>
      ${textarea('toFallback', v.toFallback, 3, ' placeholder="601000001\n+48 602 000 002"')}
      ${hint('Jeden numer w linii. Używane, gdy mail nie podaje numerów, a nadawca nie ma przypisanych')}
    </div>
    <div class="field">
      ${checkbox('recipientsFromMail', v.recipientsFromMail, 'Nadawca może podać numery w mailu')}
      ${hint('Każdy nadawca z listy może wtedy wysłać SMS na dowolny numer na koszt konta')}
    </div>
    <div class="field">
      <label>Gdzie szukać numerów</label>
      <div class="choices">${radio('recipientsWhere', 'subject', v.recipientsWhere, 'w temacie, przed dwukropkiem')}${radio('recipientsWhere', 'body', v.recipientsWhere, 'w pierwszej linii treści')}</div>
      ${hint('Temat: „600100200, 600100201: Serwer padł”. Pierwsza linia: same numery oddzielone przecinkiem albo spacją; linia znika z treści SMS-a')}
    </div>
  </details>`;
}

function fieldRows(fields: MailFieldValues[], advanced: boolean): string {
  const count = Math.min(MAX_FIELD_ROWS, fields.length + SPARE_FIELD_ROWS);
  return Array.from({ length: count }, (_, i) => {
    const f = fields[i] ?? EMPTY_FIELD;
    const n = (prop: keyof MailFieldValues) => `fields[${i}][${prop}]`;
    const modeField = advanced
      ? `<select name="${n('mode')}" style="width: 150px;"><option value="between"${f.mode === 'between' ? ' selected' : ''}>tekst po</option><option value="regex"${f.mode === 'regex' ? ' selected' : ''}>wyrażenie</option></select>`
      : `<input type="hidden" name="${n('mode')}" value="between">`;
    const body = f.mode === 'regex' && advanced
      ? `<input name="${n('pattern')}" value="${esc(f.pattern)}" placeholder="wyrażenie, np. Status: (\\w+)" style="flex: 1;"><input name="${n('flags')}" value="${esc(f.flags)}" placeholder="flagi" style="width: 60px;">`
      : `<input name="${n('after')}" value="${esc(f.after)}" placeholder="tekst po, np. Error code:" style="flex: 1;"><input name="${n('until')}" value="${esc(f.until)}" placeholder="do (koniec linii)" style="width: 150px;">`;
    return `<div class="inline" style="margin-bottom: 6px;">
        <input name="${n('name')}" value="${esc(f.name)}" placeholder="nazwa, np. kod" style="width: 130px;">${modeField}${body}
      </div>`;
  }).join('');
}

function sectionText(v: MailFormValues, opts: MailFormOptions): string {
  const advanced = opts.mode === 'zaawansowany';
  const variants: Array<[MailFormValues['textVariant'], string]> = [['subject_text', 'temat i treść'], ['subject', 'tylko temat'], ['text', 'tylko treść']];
  return `<details open>
    <summary>Co w SMS-ie</summary>
    ${advanced ? `<div class="field">
      <div class="choices">${radio('textMode', 'simple', v.textMode, 'Z listy')}${radio('textMode', 'liquid', v.textMode, 'Szablon Liquid')}</div>
    </div>` : '<input type="hidden" name="textMode" value="simple">'}
    <div class="field">
      <label for="textVariant">Treść SMS-a</label>
      <select id="textVariant" name="textVariant">${variants.map(([id, label]) => `<option value="${id}"${v.textVariant === id ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
      ${hint('Treść maila bez podpisu, stopki i cytatów; HTML zamieniony na tekst')}
    </div>
    ${advanced ? `<div class="field">
      <label for="textTemplate">Szablon Liquid</label>
      ${textarea('textTemplate', v.textTemplate, 3, ' placeholder="UPS {{ fields.urzadzenie }}: {{ fields.stan }}, kod {{ fields.kod }}"')}
      ${hint('Klucze: from, from_name, subject, text, text_full, date, to, message_id, fields.nazwa, now, integration.name. Filtr sms_truncate: n ucina do n znaków')}
    </div>` : ''}
    <div class="field">
      <label for="cutFrom">Ucinaj od tekstu</label>
      ${textarea('cutFrom', v.cutFrom, 2, ' placeholder="Wygenerowano automatycznie"')}
      ${hint('Jedna fraza w linii. Linia zaczynająca się od frazy i wszystko pod nią znika z treści, tak jak podpis i stopka')}
    </div>
    <div class="field">
      <label>Wycinki</label>
      ${fieldRows(v.fields, advanced)}
      ${hint(advanced
        ? 'Wartość to tekst po frazie do frazy końcowej albo końca linii, lub pierwsza grupa wyrażenia regularnego (flagi i, m). Wycinki czytają tekst przed czyszczeniem. W szablonie: {{ fields.nazwa }}'
        : 'Wartość to tekst po frazie do frazy końcowej albo końca linii. Wycinki czytają tekst przed czyszczeniem; podgląd pokazuje, co wyszło')}
    </div>
    <div class="field">
      <label>Limit części</label>
      <div class="inline">
        <input name="maxParts" type="number" min="1" max="9" value="${esc(v.maxParts)}" style="width: 90px;">
        <div class="choices">${radio('overflow', 'truncate', v.overflow, 'utnij i wyślij')}${radio('overflow', 'reject', v.overflow, 'nie wysyłaj, zapisz błąd i powiadom')}</div>
      </div>
    </div>
  </details>`;
}

function sectionWhen(v: MailFormValues, opts: MailFormOptions): string {
  const advanced = opts.mode === 'zaawansowany';
  return `<details${v.rules.length > 0 || v.conditionMode === 'liquid' ? ' open' : ''}>
    <summary>Kiedy wysyłać</summary>
    ${advanced ? `<div class="field">
      <div class="choices">${radio('conditionMode', 'builder', v.conditionMode, 'Reguły')}${radio('conditionMode', 'liquid', v.conditionMode, 'Wyrażenie Liquid')}</div>
    </div>` : '<input type="hidden" name="conditionMode" value="builder">'}
    <div class="field">
      <label>Reguły</label>
      ${ruleRows(v.rules, 'pole, np. subject albo fields.stan')}
      ${hint('Bez reguł każdy mail od nadawcy z listy idzie dalej. Wszystkie reguły muszą być spełnione. Pola: subject, text, from, from_name, fields.nazwa')}
    </div>
    ${advanced ? `<div class="field">
      <label for="conditionExpr">Wyrażenie</label>
      ${textarea('conditionExpr', v.conditionExpr, 2, ' placeholder="{% if subject contains \'awaria\' %}tak{% endif %}"')}
      ${hint('Pusty wynik, false albo 0 oznacza „nie wysyłaj”')}
    </div>` : ''}
  </details>`;
}

function sectionAfter(v: MailFormValues, opts: MailFormOptions): string {
  return `<details open>
    <summary>Po przetworzeniu</summary>
    <div class="field">
      <label>Co zrobić z mailem</label>
      <div class="choices">${radio('afterAction', 'keep', v.afterAction, 'zostaw w skrzynce')}${radio('afterAction', 'move', v.afterAction, 'przenieś do folderu')}${radio('afterAction', 'delete', v.afterAction, 'usuń')}</div>
      ${hint('Dotyczy także maili odrzuconych (zły nadawca, pusta treść, brak numeru). Mail zostaje oznaczony jako przeczytany. U Gmaila „usuń” to przeniesienie do kosza')}
    </div>
    <div class="field">
      <label for="afterFolder">Folder docelowy</label>
      <input id="afterFolder" name="afterFolder" value="${esc(v.afterFolder)}" placeholder="Przetworzone">
      ${hint('Folder, którego nie ma, bramka założy przy pierwszym użyciu')}
    </div>
    <div class="field">
      ${checkbox('replyEnabled', v.replyEnabled, 'Odpowiadaj nadawcy mailem')}
      ${opts.smtpConfigured
        ? hint('Nadawca z listy dostaje w wątku krótkie potwierdzenie: do kogo poszedł SMS albo dlaczego nie poszedł')
        : '<div class="hint">Nieczynne, bo SMTP nie jest skonfigurowane. <a href="/powiadomienia">Ustaw SMTP</a>, a bramka zacznie odpowiadać</div>'}
    </div>
  </details>`;
}

function sectionSample(v: MailFormValues): string {
  return `<details open>
    <summary>Próbka do sprawdzenia</summary>
    <div class="field">
      <label for="sampleRaw">Surowy mail</label>
      ${textarea('sampleRaw', v.sampleRaw, 5, ' placeholder="Wklej cały mail z nagłówkami (plik .eml albo „pokaż oryginał” w programie pocztowym)"')}
    </div>
    <div class="field">
      <label>Albo trzy pola</label>
      <div class="inline" style="margin-bottom: 6px;">
        <input name="sampleFrom" value="${esc(v.sampleFrom)}" placeholder="nadawca, np. ups@przyklad.pl" style="width: 40%;">
        <input name="sampleSubject" value="${esc(v.sampleSubject)}" placeholder="temat" style="flex: 1;">
      </div>
      ${textarea('sampleText', v.sampleText, 4, ' placeholder="treść maila"')}
      ${hint('Sprawdź szablon pokazuje, czy nadawca przechodzi, kto dostanie SMS, co dały wycinki i jak wygląda SMS. Nic nie wysyła i nic nie zapisuje')}
    </div>
  </details>`;
}

function connectionPanel(c: MailConnection): string {
  const folders = c.folders.map((f) => `<button class="btn btn-s" type="button" data-fill="#folder" data-value="${esc(f)}" style="padding: 3px 9px; font-size: 12px;">${esc(f)}</button>`).join(' ');
  if (c.ok) {
    return `<div class="panel" style="max-width: 760px;">
      <div class="panel-h"><div class="lab">Połączenie działa</div><div class="m dim">nieprzeczytanych: ${esc(c.unseen)}</div></div>
      <div class="kv"><div>Foldery</div><div>${folders || '<span class="dim">brak</span>'}<div class="hint">Kliknięcie wpisuje nazwę do pola folderu</div></div></div>
    </div>`;
  }
  const titles = { auth: ['Logowanie odrzucone', 'Sprawdź login i hasło. U Gmaila potrzebne jest hasło aplikacji, nie hasło do konta; w Google Workspace IMAP musi być włączony przez administratora'],
    network: ['Serwer nie odpowiada', 'Sprawdź nazwę serwera, port i zabezpieczenie oraz czy z maszyny bramki da się połączyć z serwerem poczty'],
    folder: ['Folder nie istnieje', 'Wpisz nazwę folderu dokładnie tak, jak podaje ją serwer; kliknięcie w nazwę z listy poniżej wpisuje ją do pola'],
    other: ['Błąd połączenia', 'Serwer odpowiedział błędem; jego komunikat poniżej'] } as const;
  const [title, advice] = titles[c.kind];
  return `<div class="panel" style="max-width: 760px;">
    <div class="panel-h"><div class="lab">${esc(title)}</div></div>
    <div class="warn">${esc(advice)}</div>
    <div class="m dim" style="padding: 8px 0;">${esc(c.error)}</div>
    ${folders ? `<div class="kv"><div>Foldery</div><div>${folders}</div></div>` : ''}
  </div>`;
}

const LEVEL_WORDS = { mail: 'numery z maila', sender: 'z listy nadawcy', fallback: 'ze stałej listy', none: 'brak' } as const;

function previewPanel(p: MailInPreview): string {
  const rows: string[] = [];
  rows.push(`<div>Nadawca</div><div>${p.senderAllowed ? '<span class="st"><span class="dot dot-ok"></span>Nadawca na liście</span>' : '<span class="st"><span class="dot dot-fail"></span>Nadawca spoza listy: mail zostałby pominięty</span>'}</div>`);
  rows.push(`<div>Odbiorcy</div><div class="m">${p.recipients.length > 0 ? `${esc(p.recipients.join(', '))} <span class="dim">(${esc(LEVEL_WORDS[p.recipientsLevel])})</span>` : '<span class="fail">brak</span>'}${p.invalid.length > 0 ? `<div class="fail">pominięte nieprawidłowe: ${esc(p.invalid.join(', '))}</div>` : ''}</div>`);
  const fields = Object.entries(p.fields);
  if (fields.length > 0) rows.push(`<div>Wycinki</div><div class="m">${fields.map(([k, val]) => `${esc(k)}: ${val === '' ? '<span class="dim">pusto</span>' : esc(val)}`).join('<br>')}</div>`);
  rows.push(`<div>Treść po czyszczeniu</div><div>${p.cleaned === '' ? '<span class="dim">pusta</span>' : `<pre class="m" style="white-space: pre-wrap; margin: 0;">${esc(p.cleaned)}</pre>`}</div>`);
  rows.push(`<div>SMS</div><div>${p.text ? `<div class="ruler" style="padding: 0 0 4px;">${esc(p.text)}</div>` : '<span class="dim">pusty</span>'}</div>`);
  rows.push(`<div>Części</div><div class="m">${esc(p.parts)}</div>`);
  return `<div class="panel" style="max-width: 760px;">
    <div class="panel-h"><div class="lab">Podgląd z próbki</div><div class="m dim">bez zapisu i bez wysyłki</div></div>
    ${p.error === null ? '' : `<div class="warn">${esc(p.error)}</div>`}
    <div class="kv">${rows.join('')}</div>
  </div>`;
}

export function mailFormPage(ctx: FormContext, v: MailFormValues, opts: MailFormOptions): string {
  const edit = ctx.row !== undefined;
  const action = edit ? `/integracje/${ctx.row!.id}/edytuj` : '/integracje';
  const guide = ctx.preset.guide === '' ? '' : `<details class="panel" style="max-width: 760px; padding: 0;">
      <summary style="padding: 12px 16px;">Gdzie wziąć dane skrzynki: ${esc(ctx.preset.name)}</summary>
      <div class="guide" style="padding: 0 16px 12px; font-size: 12.5px; line-height: 1.55;">${guideHtml(ctx.preset.guide)}</div>
    </details>`;
  const warnings = (opts.warnings ?? []).map((w) => `<div class="notice">${esc(w)}</div>`).join('');
  const crumbTail = edit ? 'edycja' : `<a href="/integracje/nowa">nowa</a> / ${esc(kindLabel('mail_in'))} / ${esc(ctx.preset.name)}`;
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/integracje">Integracje</a> / ${crumbTail}</div>
      <h1 class="h1">${edit ? esc(ctx.row!.name) : 'Nowa skrzynka'}</h1>
      <p class="sub">${esc(kindLabel('mail_in'))} · ustawienie ${esc(ctx.preset.name)}</p>
    </div>
  </div>
  <div class="scroll">
    ${modeSwitch(ctx, opts.mode)}
    ${opts.note ? `<div class="warn">${esc(opts.note)}</div>` : ''}
    ${opts.error ? `<div class="warn">${esc(opts.error)}</div>` : ''}
    ${guide}
    ${opts.connection ? connectionPanel(opts.connection) : ''}
    ${opts.preview ? previewPanel(opts.preview) : ''}
    <div class="panel" style="max-width: 760px;">
      <form class="form" method="post" action="${action}" autocomplete="off">
        <input type="hidden" name="kind" value="mail_in">
        <input type="hidden" name="preset" value="${esc(ctx.preset.id)}">
        <input type="hidden" name="tryb" value="${opts.mode}">
        ${sectionBasics(ctx, v)}
        ${sectionMailbox(v, opts)}
        ${sectionSenders(v)}
        ${sectionRecipients(v)}
        ${sectionText(v, opts)}
        ${sectionWhen(v, opts)}
        ${sectionAfter(v, opts)}
        ${sectionGuard(v)}
        ${sectionSample(v)}
        ${ctx.preset.warning ? `<div class="notice">${esc(ctx.preset.warning)}</div>` : ''}
        ${warnings}
        <div class="bar">
          <button class="btn btn-s" type="submit" name="action" value="sprawdz">Sprawdź szablon</button>
          <button class="btn btn-p" type="submit" name="action" value="zapisz">${edit ? 'Zapisz skrzynkę' : 'Utwórz skrzynkę'}</button>
        </div>
      </form>
    </div>
  </div>`;
}
