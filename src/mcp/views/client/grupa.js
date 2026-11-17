// Widok „SMS do grupy” według wyniku prepare_group_sms: treść po szablonie grupy w oknie z nadawcą grupy, ustawienia,
// lista odbiorców z _meta, podsumowanie z oknami ochrony agenta i grupy oraz zatwierdzenie. Zmiana grupy tworzy
// nowy szkic, a „Wyślij do N osób” woła send_prepared, po czym widok sam odświeża stan doręczeń.
import {
  applyTheme, button, buttons, cancelledText, createBridge, esc, field, fields, forwardedText, messageBox, note, numbers, plural, sayIn, section,
  smsCounter, textOf, tile, tiles,
} from './bridge.js';
import { deliveryLine, deliveryTile, NO_READ_SENT, watchDeliveries } from './doreczenia.js';
import { latinText } from './measure.js';
import { APPROVAL_TEXT, cancelScheduled, clock, REPEATED_NOTE, scheduledSection, scheduledTile, scheduleField } from './send.js';

/** Stała treść wiadomości do rozmowy, bez treści SMS-a. */
const GROUP_FIX_MESSAGE = 'Chcę poprawić treść tego SMS-a do grupy';

const people = (n) => plural(n, 'osoba', 'osoby', 'osób');
/** Nadawca grupy: nadpis albo numer usługi z nazwą nadaną w panelu. */
const groupSenderLabel = (p) => p.orig ?? `numer usługi ${p.service.label === p.service.id ? p.service.id : `${p.service.label} (${p.service.id})`}`;
const windowText = (guard, what) => (guard.resetsAt ? `${what} kończy się o ${clock(guard.resetsAt)}.` : `${what} otworzy się przy pierwszej wysyłce.`);

/**
 * HTML widoku grupy. `recipients` to numery i nazwy z `_meta.recipients`; `state`: `busy`, `sending`,
 * `editable` false bez danych wejściowych narzędzia, `sent` wynik send_prepared, `deliveries` liczby w stanach.
 */
export function renderGroup(p, recipients = [], state = {}) {
  const sent = state.sent ?? null;
  const locked = sent !== null || state.sending === true || state.busy === true || state.editable === false;
  const off = locked ? ' disabled' : '';
  const sender = groupSenderLabel(p);
  const content = section('Treść SMS-a', messageBox({ sender, counter: smsCounter(p), body: esc(p.encoding === 'gsm' ? latinText(p.text) : p.text) })
    + note('Treść według szablonu treści grupy') + (p.truncated ? note('Treść została skrócona do limitu części grupy') : ''));
  const groups = `<select class="sel" name="group"${off}>${p.groups.map((g) => `<option value="${esc(g)}"${g === p.group.name ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>`;
  const settings = section('Ustawienia wysyłki', fields(
    field('Grupa', groups),
    field('Nadawca SMS-a', `<select class="sel" aria-label="Nadawca SMS-a"${off}><option selected>${esc(sender)}</option></select>`),
    p.schedule ? scheduleField(p.schedule) : '',
  ) + note('Nadawcę i szablon treści określa grupa. Wysyłka nie wymaga potwierdzenia SMS-em zwrotnym.'));
  const list = section(`Odbiorcy: ${people(p.recipients)}`, numbers(recipients.map((r) => ({ phone: r.phone, label: r.name })))
    + (p.schedule ? note('Odbiorcy rozsyłki z terminem pochodzą z listy grupy w chwili zatwierdzenia, a późniejsze zmiany składu grupy jej nie dotyczą') : ''),
  `Lista grupy ${p.group.name}`);
  const d = state.deliveries;
  const n = sent?.ids?.length ?? 0;
  const summary = section('Podsumowanie', tiles(
    tile('Części SMS razem', p.recipients * p.parts, `${p.recipients} × ${plural(p.parts, 'część', 'części', 'części')}`),
    tile('Zostało wysyłek', p.guard.calls, 'w oknie ochrony agenta'),
    tile('Zostało wysyłek grupy', p.groupGuard.calls, 'w oknie ochrony grupy'),
    sent?.schedule ? scheduledTile(sent.schedule, state.cancelled === true)
      : sent ? deliveryTile(n, d, plural(n, 'wiadomość', 'wiadomości', 'wiadomości')) : tile('Podgląd ważny do', clock(p.expiresAt), 'potem nowy podgląd'),
  ) + note(`${windowText(p.guard, 'Okno ochrony agenta')} ${windowText(p.groupGuard, 'Okno grupy')}`));
  const busy = state.sending === true || state.busy === true;
  const label = p.schedule ? `Zaplanuj wysyłkę do ${plural(p.recipients, 'osoby', 'osób', 'osób')}` : `Wyślij do ${plural(p.recipients, 'osoby', 'osób', 'osób')}`;
  const finish = sent?.schedule ? scheduledSection(sent, state) : sent
    ? section('Wysyłka', `<div class="sent">Przyjęto SMS do grupy ${esc(sent.group)}: ${plural(n, 'wiadomość', 'wiadomości', 'wiadomości')}`
      + `${d && !d.unavailable ? `. ${deliveryLine(n, d)}` : ''}${d?.unavailable ? note(NO_READ_SENT) : ''}</div>`
      + (sent.repeated ? note(REPEATED_NOTE) : ''))
    : section('Zatwierdzenie', `<p class="say">${APPROVAL_TEXT}</p>`
      + buttons(button(state.sending ? 'Wysyłanie…' : label, { act: 'send', kind: 'primary', disabled: busy }),
        button('Popraw treść w rozmowie', { act: 'fix', disabled: busy })));
  return content + settings + list + summary + finish;
}

/** Uruchomienie widoku grupy w dokumencie. */
export function startGroup(win, env) {
  const doc = win.document;
  const root = doc.getElementById('tresc');
  const say = sayIn(doc);
  const s = { input: null, preview: null, recipients: [], confirm: null, busy: false, sending: false, sent: null, deliveries: null, cancelled: false };
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
      cancelled: false,
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
        // Rozsyłka z terminem nie ma jeszcze doręczeń.
        if (s.sent.kind === 'group') watchDeliveries(bridge, win, s.preview.draftId, (d) => { s.deliveries = d; draw(); });
        return say('plain', '');
      });
    } else if (button.dataset.act === 'cancel-package') {
      run(() => cancelScheduled(bridge, say, s));
    } else if (button.dataset.act === 'fix') {
      run(async () => {
        const sent = await bridge.sendMessage(GROUP_FIX_MESSAGE);
        say(sent ? 'ok' : 'plain', sent ? forwardedText('Prośba o poprawę treści') : 'Napisz w rozmowie, co zmienić w treści SMS-a');
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
