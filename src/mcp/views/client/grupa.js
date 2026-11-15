// Widok „SMS do grupy” według wyniku prepare_group_sms: nadawca i treść po szablonie grupy, lista odbiorców z _meta,
// okna ochrony agenta i grupy. Zmiana grupy tworzy nowy szkic, a „Wyślij do N osób” woła send_prepared,
// po czym widok sam odświeża stan doręczeń.
import { applyTheme, cancelledText, createBridge, esc, note, phoneLabel, plural, pluralWord, sayIn, stamp, textOf } from './bridge.js';
import { deliveryLine, watchDeliveries } from './doreczenia.js';
import { latinText } from './measure.js';

/** Stała treść wiadomości do rozmowy, bez treści SMS-a. */
const GROUP_FIX_MESSAGE = 'Chcę poprawić treść tego SMS-a do grupy';

const people = (n) => plural(n, 'osoba', 'osoby', 'osób');
/** Nadawca grupy: nadpis albo numer usługi z nazwą nadaną w panelu. */
const groupSenderLabel = (p) => p.orig ?? `numer usługi ${p.service.label === p.service.id ? p.service.id : `${p.service.label} (${p.service.id})`}`;
const groupGuardNote = (guard, what) => note(`${what}: w bieżącym oknie można jeszcze wykonać `
  + `${plural(guard.calls, 'wysyłkę', 'wysyłki', 'wysyłek')}`
  + (guard.recipients === null ? '' : ` i wysłać SMS-y do ${plural(guard.recipients, 'odbiorcy', 'odbiorców', 'odbiorców')}`));

/**
 * HTML widoku grupy. `recipients` to numery i nazwy z `_meta.recipients`; `state`: `busy`, `sending`,
 * `editable` false bez danych wejściowych narzędzia, `sent` wynik send_prepared, `deliveries` liczby w stanach.
 */
export function renderGroup(p, recipients = [], state = {}) {
  const sent = state.sent ?? null;
  const locked = sent !== null || state.sending === true || state.busy === true || state.editable === false;
  const groups = p.groups.length > 1
    ? `<select class="sel" name="group"${locked ? ' disabled' : ''}>${p.groups.map((g) => `<option value="${esc(g)}"${g === p.group.name ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>`
    : esc(p.group.name);
  const list = recipients.length === 0 ? ''
    : `<div class="recips">${recipients.map((r) => `<div><span>${esc(r.name || 'bez nazwy')}</span><span class="mono">${esc(phoneLabel(r.phone))}</span></div>`).join('')}</div>`;
  const sender = esc(groupSenderLabel(p));
  const left = `<div class="phone"><div class="phone-from">${sender}</div><div class="bubble">${esc(p.encoding === 'gsm' ? latinText(p.text) : p.text)}</div></div>`
    + `<div class="counter"><b>${p.characters}</b> ${pluralWord(p.characters, 'znak', 'znaki', 'znaków')} · <b>${p.parts}</b> `
    + `${pluralWord(p.parts, 'część', 'części', 'części')} · ${p.encoding === 'gsm' ? 'GSM' : 'UCS-2'}</div>`
    + (p.truncated ? note('Treść została skrócona do limitu części grupy') : '');
  const right = `<dl class="kv"><dt>Grupa</dt><dd>${groups}</dd>`
    + '<dt>Treść</dt><dd>według szablonu treści grupy</dd>'
    + `<dt>Nadawca SMS-a</dt><dd>${sender}, według ustawień grupy</dd>`
    + `<dt>Odbiorcy</dt><dd>${people(p.recipients)} z listy grupy</dd>`
    + '<dt>Potwierdzenie</dt><dd>w tym widoku, bez SMS-a zwrotnego</dd></dl>'
    + list + groupGuardNote(p.guard, 'Ochrona przed burzą') + groupGuardNote(p.groupGuard, `Ochrona przed burzą grupy ${p.group.name}`)
    + (sent ? '' : note(`Podgląd jest ważny do ${stamp(p.expiresAt)}`));
  const d = state.deliveries;
  const actions = sent
    ? `<div class="sent">Przyjęto SMS do grupy ${esc(sent.group)}: ${plural(sent.ids.length, 'wiadomość', 'wiadomości', 'wiadomości')}`
      + `${d && !d.unavailable ? `. ${deliveryLine(sent.ids.length, d)}` : ''}${sent.repeated ? note('Ten szkic został wysłany wcześniej, dlatego widok pokazuje poprzedni wynik') : ''}</div>`
    : `<div class="row actions"><button type="button" class="btn btn-primary" data-act="send"${state.sending || state.busy ? ' disabled' : ''}>`
      + `${state.sending ? 'Wysyłanie…' : `Wyślij do ${plural(p.recipients, 'osoby', 'osób', 'osób')}`}</button>`
      + `<button type="button" class="btn" data-act="fix"${state.sending || state.busy ? ' disabled' : ''}>Popraw treść w rozmowie</button>`
      + '<span class="note">Wysyłkę zatwierdza człowiek w tym widoku. Agent sam jej nie wykona.</span></div>';
  return `<div class="split2"><div>${left}</div><div>${right}</div></div>${actions}`;
}

/** Uruchomienie widoku grupy w dokumencie. */
export function startGroup(win, env) {
  const doc = win.document;
  const root = doc.getElementById('tresc');
  const say = sayIn(doc);
  const s = { input: null, preview: null, recipients: [], confirm: null, busy: false, sending: false, sent: null, deliveries: null };
  const draw = () => {
    if (s.preview) root.innerHTML = renderGroup(s.preview, s.recipients, { ...s, editable: s.input !== null });
  };
  const show = (result) => {
    if (result.isError) return say('fail', textOf(result));
    if (!result.structuredContent) {
      root.textContent = textOf(result);
      return undefined;
    }
    Object.assign(s, {
      preview: result.structuredContent, recipients: result._meta?.recipients ?? [], confirm: result._meta?.confirm ?? null, sent: null, deliveries: null,
    });
    say('plain', '');
    return draw();
  };
  const run = async (task) => {
    if (s.busy) return;
    s.busy = true;
    draw();
    try {
      await task();
    } catch (error) {
      say('fail', error instanceof Error ? error.message : String(error));
    } finally {
      s.busy = false;
      s.sending = false;
      draw();
    }
  };

  const bridge = createBridge(win, {
    version: env.version,
    onContext: (context) => applyTheme(doc, context),
    onToolInput: (args) => { s.input = args; },
    onToolResult: show,
    onToolCancelled: (reason) => say('wait', cancelledText(reason)),
  });

  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-act]');
    if (!button || button.disabled) return;
    if (button.dataset.act === 'send') {
      run(async () => {
        s.sending = true;
        draw();
        const result = await bridge.callTool('send_prepared', { draftId: s.preview.draftId, ...(s.confirm ? { confirm: s.confirm } : {}) });
        if (result.isError) return say('fail', textOf(result));
        s.sent = result.structuredContent;
        // Wiadomości grupy mają identyfikator szkicu jako klucz idempotencji, dlatego list_messages z draftId je znajduje.
        watchDeliveries(bridge, win, s.preview.draftId, (d) => { s.deliveries = d; draw(); });
        return say('plain', '');
      });
    } else if (button.dataset.act === 'fix') {
      run(async () => {
        const sent = await bridge.sendMessage(GROUP_FIX_MESSAGE);
        say(sent ? 'ok' : 'plain', sent ? 'Prośba o poprawę treści trafiła do rozmowy' : 'Napisz w rozmowie, co zmienić w treści SMS-a');
      });
    }
  });
  root.addEventListener('change', (event) => {
    if (event.target.name !== 'group') return;
    run(async () => {
      if (s.input === null) return say('fail', 'Aplikacja AI nie przekazała widokowi danych wejściowych. Poproś agenta w rozmowie o zmianę grupy.');
      const input = { ...s.input, group: event.target.value };
      const result = await bridge.callTool('prepare_group_sms', input);
      if (result.isError) return say('fail', textOf(result));
      s.input = input;
      return show(result);
    });
  });
}
