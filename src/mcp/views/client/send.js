// Widok „Wysyłka SMS” według wyniku prepare_sms: podgląd w dymku telefonu, nadawca, usługa, kodowanie,
// krótkie linki i ochrona przed burzą. Zmiana ustawienia tworzy nowy szkic, a „Wyślij” woła send_prepared
// z kluczem potwierdzenia z _meta. Po wysyłce widok sam odświeża stan doręczeń.
import { applyTheme, cancelledText, createBridge, esc, forwardedText, note, phoneLabel, plural, pluralWord, sayIn, stamp, textOf } from './bridge.js';
import { deliveryLine, watchDeliveries } from './doreczenia.js';
import { latinText, measure } from './measure.js';

/** Kod zastępczy krótkiego linku w podglądzie; prawdziwy kod powstaje przy wysyłce. */
const PLACEHOLDER = '0000000';
/** Stała treść wiadomości do rozmowy: bez treści SMS-a (punkt kontrolny A, rozstrzygnięcie 2). */
export const FIX_MESSAGE = 'Chcę poprawić treść tego SMS-a';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const disabled = (off) => (off ? ' disabled' : '');
const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const sms = (n) => plural(n, 'SMS', 'SMS-y', 'SMS-ów');
const parts = (n) => plural(n, 'część', 'części', 'części');

/** Treść z podświetlonym krótkim linkiem; reszta treści trafia do widoku jako tekst. */
export function linkMarkup(text, preview) {
  const domain = preview?.links?.shortened > 0 ? preview.links.domain : null;
  if (!domain) return esc(text);
  const re = new RegExp(`(?:https://)?${escapeRe(domain)}/${PLACEHOLDER}`, 'g');
  let out = '';
  let at = 0;
  for (const m of String(text).matchAll(re)) {
    out += `${esc(text.slice(at, m.index))}<span class="lnk">${esc(m[0])}</span>`;
    at = m.index + m[0].length;
  }
  return out + esc(text.slice(at));
}

/** Ochrona przed burzą: ile wysyłek i odbiorców zostało w oknie. */
export function guardNote(guard, what = 'Ochrona przed burzą') {
  const recipients = guard.recipients === null ? '' : ` i wysłać SMS-y do ${plural(guard.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')}`;
  return note(`${what}: w bieżącym oknie można jeszcze wykonać ${plural(guard.calls, 'wysyłkę', 'wysyłki', 'wysyłek')}${recipients}`);
}

function counter(p) {
  const polish = measure(p.text, 'auto').encoding === 'ucs2';
  const why = p.encoding === 'ucs2' && polish ? ' · polskie znaki wymuszają kodowanie UCS-2'
    : p.encoding === 'gsm' && polish ? ' · Multiinfo zamieni polskie znaki na łacińskie odpowiedniki' : '';
  return `<div class="counter"><b>${p.characters}</b> ${pluralWord(p.characters, 'znak', 'znaki', 'znaków')} · `
    + `<b>${p.parts}</b> ${pluralWord(p.parts, 'część', 'części', 'części')} · ${p.encoding === 'gsm' ? 'GSM' : 'UCS-2'}${why}</div>`;
}

/** Przełącznik kodowania z liczbą części obu wariantów, gdy treść zawiera znaki spoza alfabetu GSM. */
function encodingSwitch(p, locked) {
  if (measure(p.text, 'auto').encoding !== 'ucs2' && p.encoding !== 'ucs2') return '';
  const button = (enc, label) => `<button type="button" data-act="encoding" data-enc="${enc}"`
    + `${(enc === 'gsm') === (p.encoding === 'gsm') ? ' class="on"' : ''}${disabled(locked)}>${esc(label)}</button>`;
  return `<div class="row"><span class="seg">${button('unicode', `z polskimi znakami · ${parts(measure(p.text, 'unicode').parts)}`)}`
    + `${button('gsm', `bez polskich znaków · ${parts(measure(p.text, 'gsm').parts)}`)}</span></div>`;
}

function senderField(p, locked) {
  const selected = p.senders.find((s) => s.value === p.orig);
  const control = p.senders.length > 1
    ? `<select class="sel" name="orig"${disabled(locked)}>${p.senders.map((s) => option(s.value ?? '', s.label, s.value === p.orig)).join('')}</select>`
    : esc(selected?.label ?? p.orig ?? '');
  const hint = p.orig === null ? note('Integracja, klucz i konto nie mają nadpisu domyślnego, dlatego SMS zostanie wysłany z numeru usługi, a odbiorca będzie mógł odpowiedzieć') : '';
  return `<dt>Nadawca</dt><dd>${control}${hint}</dd>`;
}

function serviceField(p, locked) {
  const label = (s) => (s.label === s.id ? s.id : `${s.label} (${s.id})`);
  const control = p.services.length > 1
    ? `<select class="sel" name="service"${disabled(locked)}>${p.services.map((s) => option(s.id, label(s), s.id === p.serviceId)).join('')}</select>`
    : `<span class="mono">${esc(label(p.services.find((s) => s.id === p.serviceId) ?? { id: p.serviceId, label: p.serviceId }))}</span>`;
  return `<dt>Usługa</dt><dd>${control}</dd>`;
}

/** Skracanie: przełącznik tylko wtedy, gdy klucz pozwala nadawcy decydować, domena i kampania przy skróconych linkach. */
function linkFields(p, locked) {
  const l = p.links;
  if (l === null) return '';
  const shorten = l.mode === 'sender'
    ? `<label><input type="checkbox" name="shorten"${l.shortened > 0 ? ' checked' : ''}${disabled(locked)}> Skróć linki</label>`
    : l.mode === 'always' ? 'linki skracane zawsze, według ustawień klucza' : 'skracanie wyłączone w ustawieniach klucza';
  let out = `<dt>Skracanie</dt><dd>${shorten}</dd>`;
  if (l.shortened > 0) {
    const domain = l.domains.length > 1
      ? `<select class="sel" name="domain"${disabled(locked)}>${l.domains.map((d) => option(d, d, d === l.domain)).join('')}</select>`
      : esc(l.domain ?? '');
    out += `<dt>Domena</dt><dd>${domain}</dd>`
      + `<dt>Kampania</dt><dd><input class="inp" name="campaign" value="${esc(l.campaign ?? '')}"${disabled(locked)}></dd>`
      + `<dt>UTM</dt><dd>${l.utm ? 'parametry UTM dopisywane według ustawień klucza' : 'bez parametrów UTM'}</dd>`;
  }
  return out;
}

/** Numery odbiorców z `_meta.recipients`; przy odbiorcach kampanii z identyfikatorami klientów wiersze mają dwie kolumny. */
function recipientList(recipients) {
  if (!recipients || recipients.length === 0) return '';
  const clients = recipients.some((r) => r.clientId);
  return `<div class="recips">${recipients.map((r) => `<div>${clients ? `<span>${esc(r.clientId ?? '')}</span>` : ''}`
    + `<span class="mono">${esc(phoneLabel(r.phone))}</span></div>`).join('')}</div>`;
}

function progressText(pr) {
  if (pr.report) return `Stan rozsyłki: ${esc(pr.statusLabel)}. Doręczone: <b>${pr.report.byStatus.delivered ?? 0}</b> z ${pr.recipients}`;
  return `Stan rozsyłki: ${esc(pr.statusLabel)}` + (pr.remaining === null || pr.final ? '' : `. Do wysłania pozostało ${pr.remaining} z ${pr.recipients}`);
}

function sentBox(p, sent, state) {
  const repeated = sent.repeated ? note('Ten szkic został wysłany wcześniej, dlatego widok pokazuje poprzedni wynik') : '';
  if (sent.kind === 'package') {
    return `<div class="sent">Przyjęto rozsyłkę <span class="mono">${esc(sent.id)}</span> do ${plural(sent.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')}`
      + `${state.progress ? `<br>${progressText(state.progress)}` : ''}`
      + `<div class="row"><button type="button" class="btn" data-act="progress"${disabled(state.busy)}>Sprawdź postęp rozsyłki</button></div>${repeated}</div>`;
  }
  const n = sent.ids.length;
  const d = state.deliveries;
  const text = !d ? `Przyjęto ${sms(n)}` : d.unavailable ? `Przyjęto ${plural(n, 'wiadomość', 'wiadomości', 'wiadomości')}` : `Przyjęto ${sms(n)}. ${deliveryLine(n, d)}`;
  return `<div class="sent">${text}${repeated}</div>`;
}

/**
 * HTML widoku wysyłki. `state`: `recipients` numery z `_meta`, `sending` w trakcie wysyłki, `busy` w trakcie wywołania,
 * `editable` false bez danych wejściowych narzędzia, `sent` wynik send_prepared, `deliveries` liczby w stanach,
 * `progress` stan rozsyłki.
 */
export function renderSend(p, state = {}) {
  const sent = state.sent ?? null;
  const locked = sent !== null || state.sending === true || state.busy === true || state.editable === false;
  const sender = p.senders.find((s) => s.value === p.orig)?.label ?? p.orig ?? '';
  const left = `<div class="phone"><div class="phone-from">${esc(sender)}</div><div class="bubble">${linkMarkup(p.encoding === 'gsm' ? latinText(p.text) : p.text, p)}</div></div>${counter(p)}`
    + (p.truncated ? note('Treść została skrócona do limitu części integracji') : '')
    + (p.links?.shortened > 0 ? note('Krótki link zawiera kod zastępczy. Każdy odbiorca otrzyma przy wysyłce własny kod.') : '')
    + (p.links?.notice ? note(p.links.notice) : '')
    + encodingSwitch(p, locked);
  const route = p.route === 'messages' ? 'pojedyncze wiadomości z raportem doręczenia każdej' : 'rozsyłka ze wspólną treścią';
  const right = `<dl class="kv">${senderField(p, locked)}${serviceField(p, locked)}`
    + `<dt>Odbiorcy</dt><dd>${plural(p.recipients, 'numer', 'numery', 'numerów')}`
    + `${p.duplicatesRemoved > 0 ? `, usunięte powtórzenia: ${p.duplicatesRemoved}` : ''}${note(route)}</dd>`
    + `<dt>Części razem</dt><dd>${p.recipients * p.parts}, ${plural(p.recipients, 'odbiorca', 'odbiorców', 'odbiorców')} po ${parts(p.parts)}</dd>`
    + `${linkFields(p, locked)}</dl>${recipientList(state.recipients)}`
    + guardNote(p.guard) + (sent ? '' : note(`Podgląd jest ważny do ${stamp(p.expiresAt)}`));
  const label = p.route === 'package' ? `Wyślij rozsyłkę do ${plural(p.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')}` : `Wyślij ${sms(p.recipients)}`;
  const actions = sent ? sentBox(p, sent, state)
    : `<div class="row actions"><button type="button" class="btn btn-primary" data-act="send"${disabled(state.sending || state.busy)}>`
      + `${state.sending ? 'Wysyłanie…' : esc(label)}</button>`
      + `<button type="button" class="btn" data-act="fix"${disabled(state.sending || state.busy)}>Popraw treść w rozmowie</button>`
      + '<span class="note">Wysyłkę zatwierdza człowiek w tym widoku. Agent sam jej nie wykona.</span></div>';
  return `<div class="split2"><div>${left}</div><div>${right}</div></div>${actions}`;
}

const errorText = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Panel wysyłki w elemencie `root`: przyjmuje wynik prepare_sms z danymi wejściowymi, tworzy nowe szkice po
 * zmianie ustawień, wysyła i odświeża doręczenia. Zwraca `show(result, input)`.
 */
export function mountSend(root, { bridge, say, win }) {
  const s = { input: null, preview: null, recipients: [], confirm: null, busy: false, sending: false, sent: null, deliveries: null, progress: null };
  const draw = () => {
    if (s.preview) root.innerHTML = renderSend(s.preview, { ...s, editable: s.input !== null });
  };
  const run = async (task) => {
    if (s.busy) return;
    s.busy = true;
    draw();
    try {
      await task();
    } catch (error) {
      say('fail', errorText(error));
    } finally {
      s.busy = false;
      s.sending = false;
      draw();
    }
  };

  function show(result, input) {
    if (input !== undefined) s.input = input;
    if (result.isError) return say('fail', textOf(result));
    if (!result.structuredContent) {
      root.textContent = textOf(result);
      return undefined;
    }
    Object.assign(s, {
      preview: result.structuredContent, recipients: result._meta?.recipients ?? [], confirm: result._meta?.confirm ?? null,
      sent: null, deliveries: null, progress: null,
    });
    say('plain', '');
    draw();
    return undefined;
  }

  const prepare = (changes) => run(async () => {
    if (s.input === null) return say('fail', 'Aplikacja AI nie przekazała widokowi danych wejściowych. Poproś agenta w rozmowie o zmianę.');
    const input = { ...s.input, ...changes };
    const result = await bridge.callTool('prepare_sms', input);
    if (result.isError) return say('fail', textOf(result));
    s.input = input;
    return show(result);
  });

  const send = () => run(async () => {
    s.sending = true;
    draw();
    const result = await bridge.callTool('send_prepared', { draftId: s.preview.draftId, ...(s.confirm ? { confirm: s.confirm } : {}) });
    if (result.isError) return say('fail', textOf(result));
    s.sent = result.structuredContent;
    say('plain', '');
    if (s.sent.kind === 'messages') watchDeliveries(bridge, win, s.preview.draftId, (d) => { s.deliveries = d; draw(); });
    return undefined;
  });

  const progress = () => run(async () => {
    const result = await bridge.callTool('package_status', { packageId: s.sent.id, limit: 1 });
    if (result.isError) return say('fail', textOf(result));
    s.progress = result.structuredContent;
    return undefined;
  });

  const fix = () => run(async () => {
    const sent = await bridge.sendMessage(FIX_MESSAGE);
    say(sent ? 'ok' : 'plain', sent ? forwardedText('Prośba o poprawę treści') : 'Napisz w rozmowie, co zmienić w treści SMS-a');
  });

  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-act]');
    if (!button || button.disabled) return;
    const act = button.dataset.act;
    if (act === 'send') send();
    else if (act === 'fix') fix();
    else if (act === 'progress') progress();
    else if (act === 'encoding' && !button.classList.contains('on')) prepare({ encoding: button.dataset.enc });
  });
  root.addEventListener('change', (event) => {
    const t = event.target;
    if (t.name === 'orig') prepare({ orig: t.value === '' ? null : t.value });
    else if (t.name === 'service') prepare({ serviceId: t.value });
    else if (t.name === 'shorten') prepare({ shortenLinks: t.checked });
    else if (t.name === 'domain') prepare({ linkDomain: t.value });
    else if (t.name === 'campaign') prepare({ campaign: t.value.trim() === '' ? undefined : t.value.trim() });
  });
  return { show };
}

/** Uruchomienie widoku wysyłki w dokumencie. */
export function startSend(win, env) {
  const doc = win.document;
  const say = sayIn(doc);
  let input;
  let panel = null;
  const bridge = createBridge(win, {
    version: env.version,
    onContext: (context) => applyTheme(doc, context),
    onToolInput: (args) => { input = args; },
    onToolResult: (result) => panel?.show(result, input),
    onToolCancelled: (reason) => say('wait', cancelledText(reason)),
  });
  panel = mountSend(doc.getElementById('tresc'), { bridge, say, win });
}
