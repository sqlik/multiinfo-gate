// Widok „Wysyłka SMS” według wyniku prepare_sms: treść w oknie z nadawcą i licznikiem, ustawienia wysyłki, odbiorcy,
// podsumowanie z ochroną przed burzą i zatwierdzenie. Zmiana ustawienia tworzy nowy szkic, a „Wyślij” woła
// send_prepared z kluczem potwierdzenia z _meta. Po wysyłce widok sam odświeża stan doręczeń.
import {
  applyTheme, button, buttons, CANCEL_WINDOW, cancelledText, createBridge, esc, field, fields, forwardedText, messageBox, note, numbers, plural, sayIn,
  section, smsCounter, stamp, textOf, tile, tiles, txt,
} from './bridge.js';
import { deliveryLine, deliveryTile, NO_READ_SENT, watchDeliveries } from './doreczenia.js';
import { latinText, measure } from './measure.js';

/** Kod zastępczy krótkiego linku w podglądzie; prawdziwy kod powstaje przy wysyłce. */
const PLACEHOLDER = '0000000';
/** Stała treść wiadomości do rozmowy: bez treści SMS-a (punkt kontrolny A, rozstrzygnięcie 2). */
export const FIX_MESSAGE = 'Chcę poprawić treść tego SMS-a';
/** Zdanie nad przyciskami zatwierdzenia w widokach wysyłki i grupy. */
export const APPROVAL_TEXT = 'Wysyłkę zatwierdza człowiek w tym widoku. Agent sam jej nie wykona.';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const disabled = (off) => (off ? ' disabled' : '');
export const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const sms = (n) => plural(n, 'SMS', 'SMS-y', 'SMS-ów');
const parts = (n) => plural(n, 'część', 'części', 'części');
/** Godzina w czasie polskim: GG:MM. */
export const clock = (iso) => stamp(iso).slice(11);

/** Treść z podświetlonym krótkim linkiem i oznaczonym kodem zastępczym; reszta treści trafia do widoku jako tekst. */
export function linkMarkup(text, preview) {
  const domain = preview?.links?.shortened > 0 ? preview.links.domain : null;
  if (!domain) return esc(text);
  const re = new RegExp(`(?:https://)?${escapeRe(domain)}/${PLACEHOLDER}`, 'g');
  let out = '';
  let at = 0;
  for (const m of String(text).matchAll(re)) {
    const address = m[0].slice(0, -PLACEHOLDER.length);
    out += `${esc(text.slice(at, m.index))}<span class="lnk">${esc(address)}<span class="slot">${PLACEHOLDER}</span></span>`;
    at = m.index + m[0].length;
  }
  return out + esc(text.slice(at));
}

/** Wiersz terminu w ustawieniach wysyłki i wysyłki do grupy. */
export const scheduleField = (schedule) => field('Termin', txt(stamp(schedule.startAt)), CANCEL_WINDOW);

/** Kafel po zaplanowaniu: termin i chwila, do której można anulować, a po anulowaniu stan rozsyłki. */
export const scheduledTile = (schedule, cancelled) => (cancelled ? tile('Rozsyłka', 'anulowana', 'przed przekazaniem do Multiinfo')
  : tile('Zaplanowana na', stamp(schedule.startAt), `anulowanie do ${clock(schedule.handoverAt)}`));

/** Sekcja po zaplanowaniu rozsyłki: termin i przycisk anulowania, który działa do chwili przekazania do Multiinfo. */
export function scheduledSection(sent, state) {
  const repeated = sent.repeated ? note(REPEATED_NOTE) : '';
  if (state.cancelled) return section('Wysyłka', `<div class="sent">Rozsyłka <span class="mono">${esc(sent.id)}</span> została anulowana</div>${repeated}`);
  return section('Wysyłka', `<div class="sent">Zaplanowano rozsyłkę <span class="mono">${esc(sent.id)}</span> do `
    + `${plural(sent.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')} na ${esc(stamp(sent.schedule.startAt))}</div>`
    + buttons(button('Anuluj rozsyłkę', { act: 'cancel-package', kind: 'danger', disabled: state.busy === true })) + repeated);
}

/** Anulowanie zaplanowanej rozsyłki z widoku wysyłki albo grupy; `s.cancelled` po skutecznym anulowaniu. */
export async function cancelScheduled(bridge, say, s) {
  const result = await bridge.callTool('cancel_package', { id: s.sent.id });
  if (result.isError) return say('fail', textOf(result));
  s.cancelled = true;
  return say('ok', textOf(result));
}

/** Kafel ochrony przed burzą: ile odbiorców zostało w oknie, a bez limitu odbiorców „bez limitu”. */
export const recipientsLeftTile = (guard, sub) => tile('Zostało odbiorców', guard.recipients === null ? 'bez limitu' : guard.recipients, sub);

/** Lista wyboru: zawsze lista, także z jedną pozycją; po wysyłce wyłączona. */
export const select = (name, options, locked) => `<select class="sel" name="${name}"${disabled(locked)}>${options.join('')}</select>`;

/** Przełącznik z równymi polami; `items` to [etykieta, atrybuty data-*, włączony]. */
const segment = (items, locked) => `<div class="seg2">${items.map(([label, attrs, on]) => `<button type="button"${on ? ' class="on"' : ''} ${attrs}`
  + `${disabled(locked)}>${esc(label)}</button>`).join('')}</div>`;

/** Kodowanie: przełącznik z liczbą części obu wariantów, gdy treść zawiera znaki spoza alfabetu GSM. */
function encodingField(p, locked) {
  if (measure(p.text, 'auto').encoding !== 'ucs2' && p.encoding !== 'ucs2') return '';
  const gsm = p.encoding === 'gsm';
  return field('Kodowanie', segment([
    [`z polskimi · ${parts(measure(p.text, 'unicode').parts)}`, 'data-act="encoding" data-enc="unicode"', !gsm],
    [`bez polskich · ${parts(measure(p.text, 'gsm').parts)}`, 'data-act="encoding" data-enc="gsm"', gsm],
  ], locked), 'W wariancie bez polskich znaków Multiinfo zamienia polskie litery na łacińskie odpowiedniki');
}

/** Krótkie linki: przełącznik tylko wtedy, gdy klucz pozwala nadawcy decydować, domena i kampania przy skróconych linkach. */
function linkFields(p, locked) {
  const l = p.links;
  if (l === null) return [];
  const on = l.shortened > 0;
  const shorten = l.mode === 'sender'
    ? field('Krótkie linki', segment([['skracaj', 'data-act="shorten" data-on="1"', on], ['nie skracaj', 'data-act="shorten" data-on="0"', !on]], locked),
      'Otwarcia linków trafiają do wyników kampanii')
    : field('Krótkie linki', txt(l.mode === 'always' ? 'skracane zawsze, według ustawień klucza' : 'skracanie wyłączone w ustawieniach klucza'));
  if (!on) return [shorten];
  return [shorten,
    field('Domena linków', select('domain', l.domains.map((d) => option(d, d, d === l.domain)), locked), 'Domeny do wyboru określa klucz API'),
    field('Kampania', `<input class="inp" name="campaign" value="${esc(l.campaign ?? '')}"${disabled(locked)}>`,
      l.utm ? 'Parametry UTM dopisuje bramka według ustawień klucza' : 'Linki bez parametrów UTM')];
}

function settings(p, locked) {
  const service = (s) => (s.label === s.id ? s.id : `${s.label} (${s.id})`);
  const services = p.services.some((s) => s.id === p.serviceId) ? p.services : [...p.services, { id: p.serviceId, label: p.serviceId }];
  return section('Ustawienia wysyłki', fields(
    p.schedule ? scheduleField(p.schedule) : '',
    field('Nadawca', select('orig', p.senders.map((s) => option(s.value ?? '', s.label, s.value === p.orig)), locked),
      p.orig === null ? 'Integracja, klucz i konto nie określają nadpisu domyślnego, dlatego SMS zostanie wysłany z numeru usługi, a odbiorca będzie mógł odpowiedzieć' : ''),
    field('Usługa Multiinfo', select('service', services.map((s) => option(s.id, service(s), s.id === p.serviceId)), locked)),
    encodingField(p, locked),
    ...linkFields(p, locked),
  ));
}

function progressText(pr) {
  if (pr.report) return `Stan rozsyłki: ${esc(pr.statusLabel)}. Doręczone: <b>${pr.report.byStatus.delivered ?? 0}</b> z ${pr.recipients}`;
  return `Stan rozsyłki: ${esc(pr.statusLabel)}` + (pr.remaining === null || pr.final ? '' : `. Do wysłania pozostało ${pr.remaining} z ${pr.recipients}`);
}

/** Zdanie o wysyłce szkicu wysłanego wcześniej. */
export const REPEATED_NOTE = 'Ten szkic został wysłany wcześniej, dlatego widok pokazuje poprzedni wynik';

function sentSection(sent, state) {
  const repeated = sent.repeated ? note(REPEATED_NOTE) : '';
  if (sent.kind === 'package') {
    return section('Wysyłka', `<div class="sent">Przyjęto rozsyłkę <span class="mono">${esc(sent.id)}</span> do `
      + `${plural(sent.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')}${state.progress ? `<br>${progressText(state.progress)}` : ''}</div>`
      + buttons(button('Sprawdź postęp rozsyłki', { act: 'progress', disabled: state.busy })) + repeated);
  }
  const n = sent.ids.length;
  const d = state.deliveries;
  const text = !d ? `Przyjęto ${sms(n)}` : d.unavailable ? `Przyjęto ${plural(n, 'wiadomość', 'wiadomości', 'wiadomości')}${note(NO_READ_SENT)}` : `Przyjęto ${sms(n)}. ${deliveryLine(n, d)}`;
  return section('Wysyłka', `<div class="sent">${text}</div>${repeated}`);
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
  const content = section('Treść SMS-a', messageBox({
    sender, counter: smsCounter(p), body: linkMarkup(p.encoding === 'gsm' ? latinText(p.text) : p.text, p),
  })
    + (p.truncated ? note('Treść została skrócona do limitu części integracji') : '')
    + (p.links?.shortened > 0 ? `<p class="note"><span class="slot">${PLACEHOLDER}</span> oznacza kod zastępczy. Każdy odbiorca otrzyma przy wysyłce link z własnym kodem.</p>` : '')
    + (p.links?.notice ? note(p.links.notice) : ''));
  const route = p.route === 'messages' ? 'Pojedyncze wiadomości z raportem doręczenia każdej'
    : `${p.schedule ? 'Rozsyłka z terminem' : 'Rozsyłka ze wspólną treścią'}, raport doręczeń po zakończeniu rozsyłki`;
  const recipients = section(`Odbiorcy: ${plural(p.recipients, 'numer', 'numery', 'numerów')}`,
    numbers((state.recipients ?? []).map((r) => ({ phone: r.phone, label: r.clientId })))
    + (p.duplicatesRemoved > 0 ? note(`Bramka usunęła powtórzone numery: ${p.duplicatesRemoved}`) : ''), route);
  const accepted = sent?.kind === 'package' ? plural(sent.recipients, 'odbiorca', 'odbiorców', 'odbiorców') : sms(sent?.ids?.length ?? 0);
  const summary = section('Podsumowanie', tiles(
    tile('Części SMS razem', p.recipients * p.parts, `${p.recipients} × ${parts(p.parts)}`),
    tile('Zostało wysyłek', p.guard.calls, 'w oknie ochrony'),
    recipientsLeftTile(p.guard, 'w oknie ochrony'),
    sent?.schedule ? scheduledTile(sent.schedule, state.cancelled === true)
      : sent ? deliveryTile(sent.ids?.length ?? 0, sent.kind === 'messages' ? state.deliveries : null, accepted)
      : tile('Podgląd ważny do', clock(p.expiresAt), 'potem nowy podgląd'),
  ) + note(p.guard.resetsAt ? `Okno ochrony przed burzą kończy się o ${clock(p.guard.resetsAt)}` : 'Okno ochrony przed burzą otworzy się przy pierwszej wysyłce'));
  const label = p.schedule ? `Zaplanuj rozsyłkę do ${plural(p.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')}`
    : p.route === 'package' ? `Wyślij rozsyłkę do ${plural(p.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')}` : `Wyślij ${sms(p.recipients)}`;
  const busy = state.sending === true || state.busy === true;
  const finish = sent?.schedule ? scheduledSection(sent, state) : sent ? sentSection(sent, state)
    : section('Zatwierdzenie', `<p class="say">${APPROVAL_TEXT}</p>`
      + buttons(button(state.sending ? 'Wysyłanie…' : label, { act: 'send', kind: 'primary', disabled: busy }),
        button('Popraw treść w rozmowie', { act: 'fix', disabled: busy })));
  return content + settings(p, locked) + recipients + summary + finish;
}

const errorText = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Panel wysyłki w elemencie `root`: przyjmuje wynik prepare_sms z danymi wejściowymi, tworzy nowe szkice po
 * zmianie ustawień, wysyła i odświeża doręczenia. Zwraca `show(result, input)`.
 */
export function mountSend(root, { bridge, say, win }) {
  const s = { input: null, preview: null, recipients: [], confirm: null, busy: false, sending: false, sent: null, deliveries: null, progress: null, cancelled: false };
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
      sent: null, deliveries: null, progress: null, cancelled: false,
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
    else if (act === 'cancel-package') run(() => cancelScheduled(bridge, say, s));
    else if (act === 'encoding' && !button.classList.contains('on')) prepare({ encoding: button.dataset.enc });
    else if (act === 'shorten' && !button.classList.contains('on')) prepare({ shortenLinks: button.dataset.on === '1' });
  });
  root.addEventListener('change', (event) => {
    const t = event.target;
    if (t.name === 'orig') prepare({ orig: t.value === '' ? null : t.value });
    else if (t.name === 'service') prepare({ serviceId: t.value });
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
