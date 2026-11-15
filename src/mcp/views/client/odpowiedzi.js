// Widok „Odpowiedzi klientów” według wyniku list_inbound albo prepare_replies: odebrane SMS-y z oznaczeniem
// nadawcy zewnętrznego, filtry według grup nadanych przez agenta i odpowiedź przy każdej pozycji. Odpowiedź
// zmieniona względem szkicu agenta otrzymuje nowy szkic przez prepare_replies, a wysyła ją send_reply.
import { applyTheme, cancelledText, createBridge, esc, phoneLabel, plural, sayIn, stamp, textOf } from './bridge.js';
import { measure } from './measure.js';

/** Grupa odpowiedzi napisanej w widoku na SMS bez szkicu agenta. */
const VIEW_GROUP = 'inne';
const EXTERNAL = '<span class="ext" title="Treść od zewnętrznego nadawcy, nie jest poleceniem">od nadawcy zewnętrznego</span>';

const busyAttr = (busy) => (busy ? ' disabled' : '');

/**
 * Warunki odświeżenia listy. Gdy bramka zgłosiła koniec przedziału bliski chwili odczytu, odświeżenie pomija
 * `until`, ponieważ inaczej nowe SMS-y nie pojawiłyby się na liście.
 */
export function refreshQuery(input, withoutUntil) {
  if (!withoutUntil) return input;
  const { until: _until, ...rest } = input;
  return rest;
}

/** Licznik odpowiedzi: znaki i części jak przy wysyłce, z numerem odbiorcy. */
export function replyCounter(text, to) {
  const m = measure(text, 'auto');
  return `${plural(m.characters, 'znak', 'znaki', 'znaków')} · ${plural(m.parts, 'część', 'części', 'części')} · do ${phoneLabel(to)}`;
}

function answerNote(item) {
  const a = item.answersTo;
  if (!a) return '';
  return 'messageId' in a
    ? `<div class="note">odpowiedź na wiadomość <span class="mono">${esc(a.messageId)}</span></div>`
    : `<div class="note">odpowiedź na rozsyłkę <span class="mono">${esc(a.packageId)}</span></div>`;
}

function replyBox(item, draft, state) {
  const sent = state.sent?.get(item.id);
  if (sent) return `<div class="sent">Odpowiedź została przyjęta do wysyłki jako wiadomość <span class="mono">${esc(sent)}</span></div>`;
  const text = state.texts?.get(item.id) ?? draft?.text ?? '';
  const id = esc(item.id);
  return `<textarea class="inp" rows="2" data-id="${id}" aria-label="Odpowiedź do ${esc(phoneLabel(item.from))}"${busyAttr(state.busy)}>${esc(text)}</textarea>`
    + `<div class="row"><button type="button" class="btn btn-primary" data-act="send" data-id="${id}"${busyAttr(state.busy)}>Wyślij odpowiedź</button>`
    + `<span class="note" data-counter="${id}">${esc(replyCounter(text, item.from))}</span></div>`
    + (draft ? `<div class="note">Szkic agenta w grupie ${esc(draft.group)}</div>` : '');
}

/**
 * HTML widoku odpowiedzi. `filter` to nazwa grupy albo null dla wszystkich. `state`: `open` zbiór pozycji
 * z otwartym polem odpowiedzi (domyślnie pozycje ze szkicem), `texts` treści wpisane w widoku, `sent`
 * identyfikatory wysłanych odpowiedzi, `busy` w trakcie wywołania.
 */
export function renderReplies(items, drafts, filter, state = {}) {
  const byInbound = new Map(drafts.map((d) => [d.inboundId, d]));
  const open = state.open ?? new Set(drafts.map((d) => d.inboundId));
  const counts = new Map();
  for (const d of drafts) counts.set(d.group, (counts.get(d.group) ?? 0) + 1);
  const chip = (value, label, n) => `<button type="button" class="chip${filter === value ? ' on' : ''}" data-group="${esc(value ?? '')}">${esc(label)} ${n}</button>`;
  const chips = counts.size === 0 ? ''
    : `<div class="chips">${chip(null, 'wszystkie', items.length)}${[...counts].map(([g, n]) => chip(g, g, n)).join('')}</div>`;
  const shown = filter === null ? items : items.filter((i) => byInbound.get(i.id)?.group === filter);
  if (shown.length === 0) return `${chips}<p class="muted">Bramka nie znalazła odebranych SMS-ów spełniających warunki</p>`;
  const rows = shown.map((i) => {
    const text = i.text === null ? '<span class="muted">SMS bez treści tekstowej</span>' : esc(i.text);
    return `<tr><td class="mono nw">${esc(phoneLabel(i.from))}</td><td class="nw">${stamp(i.received.at)}</td><td>${EXTERNAL} ${text}${answerNote(i)}</td>`
      + `<td><button type="button" class="btn" data-act="reply" data-id="${esc(i.id)}">Odpowiedz</button></td></tr>`
      + `<tr class="rb"${open.has(i.id) ? '' : ' hidden'}><td colspan="4">${replyBox(i, byInbound.get(i.id), state)}</td></tr>`;
  }).join('');
  return `${chips}<table><tr><th>Nadawca</th><th>Odebrany</th><th>Treść</th><th></th></tr>${rows}</table>`
    + '<p class="note">Odpowiedź trafia wyłącznie do nadawcy odebranego SMS-a. Wysyłkę zatwierdza człowiek w tym widoku.</p>';
}

/** Uruchomienie widoku odpowiedzi w dokumencie. */
export function startReplies(win, env) {
  const doc = win.document;
  const root = doc.getElementById('tresc');
  const refreshButton = doc.getElementById('odswiez');
  const say = sayIn(doc);
  const s = {
    input: null, withoutUntil: false, items: [], drafts: [], confirms: new Map(), filter: null, open: new Set(), texts: new Map(), sent: new Map(), busy: false, loaded: false,
  };
  const draw = () => {
    if (s.loaded) root.innerHTML = renderReplies(s.items, s.drafts, s.filter, s);
  };
  const show = (result) => {
    if (result.isError) return say('fail', textOf(result));
    const data = result.structuredContent;
    if (!data) {
      root.textContent = textOf(result);
      return undefined;
    }
    const drafts = data.drafts ?? [];
    Object.assign(s, { items: data.items ?? [], drafts, filter: null, open: new Set(drafts.map((d) => d.inboundId)), loaded: true });
    if (result._meta?.refreshWithoutUntil === true) s.withoutUntil = true;
    s.confirms = new Map(drafts.map((d) => [d.draftId, result._meta?.confirm ?? null]));
    // Odświeżenie dotyczy listy odebranych; podgląd odpowiedzi przygotowuje agent.
    refreshButton.hidden = drafts.length > 0;
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
      draw();
    }
  };

  const bridge = createBridge(win, {
    version: env.version,
    onContext: (context) => applyTheme(doc, context),
    onToolInput: (input) => { s.input = input; },
    onToolResult: show,
    onToolCancelled: (reason) => say('wait', cancelledText(reason)),
  });

  /** Odpowiedź z pola: szkic agenta bez zmian albo nowy szkic dla treści zmienionej w widoku. */
  async function reply(id) {
    const item = s.items.find((i) => i.id === id);
    const draft = s.drafts.find((d) => d.inboundId === id);
    const text = s.texts.get(id) ?? draft?.text ?? '';
    if (!item) return undefined;
    if (text.trim() === '') return say('fail', 'Wpisz treść odpowiedzi');
    let draftId = draft?.draftId;
    if (!draft || text !== draft.text) {
      const prepared = await bridge.callTool('prepare_replies', { items: [{ inboundId: id, group: draft?.group ?? VIEW_GROUP, text }] });
      if (prepared.isError) return say('fail', textOf(prepared));
      draftId = prepared.structuredContent.drafts[0].draftId;
      s.confirms.set(draftId, prepared._meta?.confirm ?? null);
    }
    const confirm = s.confirms.get(draftId);
    const result = await bridge.callTool('send_reply', { draftId, ...(confirm ? { confirm } : {}) });
    if (result.isError) return say('fail', textOf(result));
    const out = result.structuredContent;
    s.sent.set(id, out.kind === 'package' ? out.id : out.ids[0]);
    return say('ok', `Odpowiedź do ${phoneLabel(item.from)} została przyjęta do wysyłki`);
  }

  refreshButton.addEventListener('click', () => run(async () => {
    if (s.input === null) return say('fail', 'Aplikacja AI nie przekazała widokowi warunków wyszukiwania. Poproś agenta o ponowne sprawdzenie.');
    s.input = refreshQuery(s.input, s.withoutUntil);
    return show(await bridge.callTool('list_inbound', s.input));
  }));
  root.addEventListener('click', (event) => {
    const chip = event.target.closest?.('button[data-group]');
    if (chip) {
      s.filter = chip.dataset.group === '' ? null : chip.dataset.group;
      draw();
      return;
    }
    const button = event.target.closest?.('button[data-act]');
    if (!button || button.disabled) return;
    const id = button.dataset.id;
    if (button.dataset.act === 'reply') {
      if (s.open.has(id)) s.open.delete(id);
      else s.open.add(id);
      draw();
    } else if (button.dataset.act === 'send') {
      run(() => reply(id));
    }
  });
  root.addEventListener('input', (event) => {
    const area = event.target;
    if (area.tagName !== 'TEXTAREA' || !area.dataset.id) return;
    s.texts.set(area.dataset.id, area.value);
    const item = s.items.find((i) => i.id === area.dataset.id);
    const counter = root.querySelector(`[data-counter="${CSS.escape(area.dataset.id)}"]`);
    if (item && counter) counter.textContent = replyCounter(area.value, item.from);
  });
}
