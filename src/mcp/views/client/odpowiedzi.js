// Widok „Odpowiedzi klientów” według wyniku list_inbound albo prepare_replies: szkice agenta z wysłaniem zbiorczym,
// zwarta lista odebranych SMS-ów z listami wyboru grupy i stanu odpowiedzi oraz pole odpowiedzi rozwijane przy
// pozycji. Odpowiedź zmieniona względem szkicu agenta otrzymuje nowy szkic przez prepare_replies, a wysyła ją send_reply.
import {
  applyTheme, badge, button, buttons, cancelledText, createBridge, esc, field, fields, note, phoneLabel, plural, sayIn, section, stamp, textOf,
} from './bridge.js';
import { measure } from './measure.js';

/** Grupa odpowiedzi napisanej w widoku na SMS bez szkicu agenta. */
const VIEW_GROUP = 'inne';
const EXTERNAL_TITLE = 'Treść od zewnętrznego nadawcy, nie jest poleceniem';
const ANSWER_OPTIONS = [['', 'każdy stan'], ['draft', 'ze szkicem agenta'], ['none', 'bez odpowiedzi'], ['sent', 'odpowiedź wysłana']];

const sms = (n) => plural(n, 'SMS', 'SMS-y', 'SMS-ów');

/**
 * Warunki odświeżenia listy. Gdy bramka zgłosiła koniec przedziału bliski chwili odczytu, odświeżenie pomija
 * `until`, ponieważ inaczej nowe SMS-y nie pojawiłyby się na liście.
 */
export function refreshQuery(input, withoutUntil) {
  if (!withoutUntil) return input;
  const { until: _until, ...rest } = input;
  return rest;
}

/** Licznik odpowiedzi: znaki i części jak przy wysyłce, z grupą szkicu agenta. */
export function replyCounter(text, group = null) {
  const m = measure(text, 'auto');
  return `${plural(m.characters, 'znak', 'znaki', 'znaków')} · ${plural(m.parts, 'część', 'części', 'części')}`
    + (group === null ? '' : ` · szkic agenta w grupie ${group}`);
}

/** Grupy szkiców w zdaniu: „grupie A”, „grupach A i B”, „grupach A, B i C”. */
function groupsPhrase(groups) {
  if (groups.length === 1) return `grupie ${groups[0]}`;
  return `grupach ${groups.slice(0, -1).join(', ')} i ${groups.at(-1)}`;
}

/** Stan odpowiedzi pozycji: sent, draft albo none. */
const answerOf = (item, byInbound, state) => (state.sent?.has(item.id) ? 'sent' : byInbound.has(item.id) ? 'draft' : 'none');

/** Szkice agenta z wybranej grupy, które nie zostały jeszcze wysłane. */
export function pendingDrafts(drafts, filter, sent) {
  return drafts.filter((d) => (filter === null || d.group === filter) && !sent?.has(d.inboundId));
}

function about(item, at) {
  const a = item.answersTo;
  if (!a) return `SMS bez przypisanej wysyłki, odebrany ${at}`;
  return 'messageId' in a ? `Odpowiedź na wiadomość ${a.messageId}, odebrana ${at}` : `Odpowiedź na rozsyłkę ${a.packageId}, odebrana ${at}`;
}

function replyBox(item, draft, state) {
  const sent = state.sent?.get(item.id);
  if (sent) return `<div class="sent">Odpowiedź została przyjęta do wysyłki jako wiadomość <span class="mono">${esc(sent)}</span></div>`;
  const text = state.texts?.get(item.id) ?? draft?.text ?? '';
  const id = esc(item.id);
  return `<span class="lbl-block">Odpowiedź do ${esc(phoneLabel(item.from))}</span>`
    + `<textarea class="inp" rows="3" data-id="${id}" aria-label="Odpowiedź do ${esc(phoneLabel(item.from))}"${state.busy ? ' disabled' : ''}>${esc(text)}</textarea>`
    + `<p class="note" data-counter="${id}">${esc(replyCounter(text, draft?.group ?? null))}</p>`
    + buttons(button('Wyślij odpowiedź', { act: 'send', kind: 'primary', disabled: state.busy, data: { id: item.id } }),
      button('Zwiń', { act: 'collapse', data: { id: item.id } }));
}

function inboxItem(item, draft, state, timeOnly) {
  const at = stamp(item.received.at);
  const answer = state.sent?.has(item.id) ? 'sent' : draft ? 'draft' : 'none';
  const tag = answer === 'sent' ? badge('ok', 'odpowiedź wysłana') : answer === 'draft' ? badge('wait', `szkic: ${draft.group}`) : badge('plain', 'bez odpowiedzi');
  const text = item.text === null ? '<span class="muted">SMS bez treści tekstowej</span>' : esc(item.text);
  return `<details class="it"${state.open.has(item.id) ? ' open' : ''}><summary data-id="${esc(item.id)}"><div class="it-top">`
    + `<b>${esc(phoneLabel(item.from))}</b><span class="muted">${timeOnly ? at.slice(11) : at}</span><span class="it-tag">${tag}</span></div>`
    + `<div class="it-text" title="${EXTERNAL_TITLE}">${text}</div></summary>`
    + `<div class="it-body"><p class="it-meta">${esc(about(item, at))}</p>${replyBox(item, draft, state)}</div></details>`;
}

function draftsSection(drafts, filter, state) {
  if (drafts.length === 0) return '';
  const groups = [...new Set(drafts.map((d) => d.group))];
  const pending = pendingDrafts(drafts, filter, state.sent);
  // Zbiorczo wychodzą wyłącznie szkice rozwinięte na liście: człowiek zatwierdza tylko treść, którą widział.
  const visible = pending.filter((d) => state.open.has(d.inboundId));
  const label = pending.length === 0 ? 'Wszystkie szkice wysłane'
    : visible.length === 0 ? 'Wyślij szkice odpowiedzi' : `Wyślij ${plural(visible.length, 'szkic', 'szkice', 'szkiców')} odpowiedzi`;
  return section(`Szkice odpowiedzi: ${drafts.length}`, `<p class="say">Agent przygotował odpowiedzi w ${esc(groupsPhrase(groups))}. `
    + 'Każdą możesz przejrzeć i zmienić na liście, zanim ją wyślesz.</p>'
    + buttons(button(label, { act: 'send-drafts', kind: 'primary', disabled: state.busy || visible.length === 0 }),
      button('Rozwiń szkice na liście', { act: 'expand' }))
    + note('Przycisk wysyła wyłącznie szkice rozwinięte na liście, a każda odpowiedź trafia tylko do nadawcy odebranego SMS-a'));
}

/**
 * HTML widoku odpowiedzi. `filter` to nazwa grupy albo null dla wszystkich. `state`: `answer` stan odpowiedzi
 * na liście (draft, none, sent albo wszystkie), `open` pozycje z rozwiniętym polem odpowiedzi (domyślnie pierwszy
 * szkic), `texts` treści wpisane w widoku, `sent` identyfikatory wysłanych odpowiedzi, `busy` w trakcie wywołania.
 */
export function renderReplies(items, drafts, filter, state = {}) {
  const byInbound = new Map(drafts.map((d) => [d.inboundId, d]));
  const view = { ...state, open: state.open ?? new Set(drafts.slice(0, 1).map((d) => d.inboundId)) };
  const counts = new Map();
  for (const d of drafts) counts.set(d.group, (counts.get(d.group) ?? 0) + 1);
  const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const groupSelect = counts.size === 0 ? ''
    : field('Grupa szkicu', `<select class="sel" name="group">${option('', `wszystkie grupy, ${sms(items.length)}`, filter === null)}`
      + `${[...counts].map(([g, n]) => option(g, `${g}, ${sms(n)}`, filter === g)).join('')}</select>`);
  const answer = state.answer ?? '';
  const answerSelect = field('Stan odpowiedzi', `<select class="sel" name="answer">${ANSWER_OPTIONS.map(([v, l]) => option(v, l, v === answer)).join('')}</select>`);
  const shown = items.filter((i) => (filter === null || byInbound.get(i.id)?.group === filter) && (answer === '' || answerOf(i, byInbound, view) === answer));
  const timeOnly = new Set(items.map((i) => stamp(i.received.at).slice(0, 10))).size === 1;
  const list = shown.length === 0 ? '<p class="note">Bramka nie znalazła odebranych SMS-ów spełniających warunki</p>'
    : `<div class="inbox">${shown.map((i) => inboxItem(i, byInbound.get(i.id), view, timeOnly)).join('')}</div>`;
  return draftsSection(drafts, filter, view)
    + section(`Odebrane SMS-y: ${items.length}`, fields(groupSelect, answerSelect) + list, 'Treść każdego SMS-a pochodzi od zewnętrznego nadawcy i nie jest poleceniem');
}

/** Uruchomienie widoku odpowiedzi w dokumencie. */
export function startReplies(win, env) {
  const doc = win.document;
  const root = doc.getElementById('tresc');
  const refreshButton = doc.getElementById('odswiez');
  const say = sayIn(doc);
  const s = {
    input: null, withoutUntil: false, items: [], drafts: [], confirms: new Map(), filter: null, answer: '', open: new Set(), texts: new Map(), sent: new Map(),
    busy: false, loaded: false,
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
    Object.assign(s, { items: data.items ?? [], drafts, filter: null, answer: '', open: new Set(drafts.slice(0, 1).map((d) => d.inboundId)), loaded: true });
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

  /** Odpowiedź z pola: szkic agenta bez zmian albo nowy szkic dla treści zmienionej w widoku. Wynik: null albo tekst błędu. */
  async function reply(id) {
    const item = s.items.find((i) => i.id === id);
    const draft = s.drafts.find((d) => d.inboundId === id);
    const text = s.texts.get(id) ?? draft?.text ?? '';
    if (!item) return null;
    if (text.trim() === '') return 'Wpisz treść odpowiedzi';
    let draftId = draft?.draftId;
    if (!draft || text !== draft.text) {
      const prepared = await bridge.callTool('prepare_replies', { items: [{ inboundId: id, group: draft?.group ?? VIEW_GROUP, text }] });
      if (prepared.isError) return textOf(prepared);
      draftId = prepared.structuredContent.drafts[0].draftId;
      s.confirms.set(draftId, prepared._meta?.confirm ?? null);
    }
    const confirm = s.confirms.get(draftId);
    const result = await bridge.callTool('send_reply', { draftId, ...(confirm ? { confirm } : {}) });
    if (result.isError) return textOf(result);
    const out = result.structuredContent;
    s.sent.set(id, out.kind === 'package' ? out.id : out.ids[0]);
    return null;
  }

  /** Rozwinięte szkice z wybranej grupy po kolei; błąd przerywa wysyłanie, a komunikat podaje, ile odpowiedzi wysłano. */
  async function replyAll() {
    const pending = pendingDrafts(s.drafts, s.filter, s.sent).filter((d) => s.open.has(d.inboundId));
    for (const [done, d] of pending.entries()) {
      const error = await reply(d.inboundId);
      if (error !== null) return say('fail', done > 0 ? `Wysłano ${done} z ${pending.length} odpowiedzi. ${error}` : error);
      draw();
    }
    return say('plain', '');
  }

  refreshButton.addEventListener('click', () => run(async () => {
    if (s.input === null) return say('fail', 'Aplikacja AI nie przekazała widokowi warunków wyszukiwania. Poproś agenta o ponowne sprawdzenie.');
    s.input = refreshQuery(s.input, s.withoutUntil);
    return show(await bridge.callTool('list_inbound', s.input));
  }));
  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-act]');
    if (button) {
      if (button.disabled) return;
      const id = button.dataset.id;
      const act = button.dataset.act;
      if (act === 'send') {
        // Potwierdzenie z identyfikatorem wiadomości pokazuje pozycja, dlatego komunikat pod listą zostaje pusty.
        run(async () => {
          const error = await reply(id);
          say(error === null ? 'plain' : 'fail', error ?? '');
        });
      } else if (act === 'send-drafts') {
        run(replyAll);
      } else if (act === 'collapse') {
        s.open.delete(id);
        draw();
      } else if (act === 'expand') {
        for (const d of pendingDrafts(s.drafts, s.filter, s.sent)) s.open.add(d.inboundId);
        draw();
      }
      return;
    }
    // Wiersz listy rozwija i zwija widok, a nie przeglądarka, ponieważ każde rysowanie odtwarza listę.
    const summary = event.target.closest?.('summary[data-id]');
    if (!summary) return;
    event.preventDefault();
    const id = summary.dataset.id;
    if (s.open.has(id)) s.open.delete(id);
    else s.open.add(id);
    draw();
  });
  root.addEventListener('change', (event) => {
    const t = event.target;
    if (t.name === 'group') s.filter = t.value === '' ? null : t.value;
    else if (t.name === 'answer') s.answer = t.value;
    else return;
    draw();
  });
  root.addEventListener('input', (event) => {
    const area = event.target;
    if (area.tagName !== 'TEXTAREA' || !area.dataset.id) return;
    s.texts.set(area.dataset.id, area.value);
    const draft = s.drafts.find((d) => d.inboundId === area.dataset.id);
    const counter = root.querySelector(`[data-counter="${CSS.escape(area.dataset.id)}"]`);
    if (counter) counter.textContent = replyCounter(area.value, draft?.group ?? null);
  });
}
