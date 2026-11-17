// Widok „Rozmowa z numerem” według wyniku conversation albo prepare_conversation_reply: SMS-y klienta i firmy
// w dwóch kolumnach według kierunku, odświeżanie co 15 s przez 15 minut, prośba o odpowiedź po nowym SMS-ie klienta
// i szkic odpowiedzi na dole, który wysyła send_reply z kluczem potwierdzenia z podglądu.
import {
  applyTheme, badge, button, buttons, cancelledText, createBridge, esc, failure, forwardedText, note, phoneLabel, pluralWord, retryable, retryText,
  sayIn, section, stamp, textOf,
} from './bridge.js';

export const CONVERSATION_REFRESH_MS = 15_000;
export const CONVERSATION_REFRESH_MAX_MS = 900_000;
/** Wiadomość do rozmowy po nowym SMS-ie klienta, jak CONVERSATION_MESSAGE w narzędziach: bez treści SMS-a i bez numeru. */
export const ASK_REPLY = 'Klient odpisał w rozmowie w widoku bramki. Przygotuj odpowiedź na jego ostatni SMS.';
/** Wiadomość do rozmowy po „Popraw treść w rozmowie”. */
export const REPLY_FIX_MESSAGE = 'Chcę poprawić treść tej odpowiedzi';

const EXTERNAL_TITLE = 'Treść od zewnętrznego nadawcy, nie jest poleceniem';
const LIVE_TEXT = { watching: '● na żywo, co 15 s', timeout: 'odświeżanie zatrzymane po 15 minutach', error: 'odświeżanie zatrzymane' };
/** Kolor plakietki stanu wysłanej wiadomości; pozostałe stany są w drodze. */
const STATE_TONE = { delivered: 'ok', failed: 'fail', blocked: 'fail', expired: 'fail', cancelled: 'plain', unknown: 'plain' };

/**
 * Odświeżanie rozmowy przez conversation z `args` co 15 s, najwyżej 15 minut. `args` może być funkcją, która podaje
 * argumenty przy każdym odczycie. `handlers.onData` otrzymuje każdy odczyt, a `handlers.onEnd` powód końca: timeout
 * albo error z tekstem i szczegółami błędu aplikacji AI. Po błędzie połączenia `handlers.onRetry` otrzymuje szczegóły
 * błędu, a odświeżanie ponawia odczyt. Wynikiem jest funkcja, która zatrzymuje odświeżanie bez wywołania `onEnd`.
 */
export function watchConversation(bridge, win, args, handlers, now = () => Date.now()) {
  const started = now();
  let stopped = false;
  async function tick() {
    if (stopped) return;
    let result;
    try {
      result = await bridge.callTool('conversation', typeof args === 'function' ? args() : args);
    } catch (error) {
      if (stopped) return;
      // Błąd połączenia, na przykład przy restarcie bramki, nie przerywa odświeżania przed upływem 15 minut.
      if (retryable(error) && now() - started < CONVERSATION_REFRESH_MAX_MS) {
        handlers.onRetry?.(failure(error)[1]);
        win.setTimeout(tick, CONVERSATION_REFRESH_MS);
      } else handlers.onEnd('error', ...failure(error));
      return;
    }
    if (stopped) return;
    if (result.isError || !result.structuredContent) {
      handlers.onEnd('error', textOf(result), '');
      return;
    }
    handlers.onData(result.structuredContent);
    if (now() - started >= CONVERSATION_REFRESH_MAX_MS) handlers.onEnd('timeout');
    else win.setTimeout(tick, CONVERSATION_REFRESH_MS);
  }
  win.setTimeout(tick, CONVERSATION_REFRESH_MS);
  return () => { stopped = true; };
}

/** Dymek SMS-a: treść jako tekst, godzina, przy SMS-ach klienta jego numer, a przy wysłanych stan doręczenia i źródło. */
function bubble(item, fresh, phone) {
  const isNew = item.kind === 'in' && fresh.has(item.id);
  const text = !item.stored ? '<span class="muted">Treść nie jest przechowywana</span>'
    : item.text === null ? '<span class="muted">SMS bez treści tekstowej</span>' : esc(item.text);
  const time = stamp(item.at.at).slice(11);
  const meta = [`<span>${esc(item.kind === 'in' ? `${phoneLabel(phone)} · ${time}` : time)}</span>`];
  if (item.kind === 'out') meta.push(badge(STATE_TONE[item.status] ?? 'wait', item.statusLabel ?? item.status), `<span>${esc(item.source)}</span>`);
  if (isNew) meta.push(badge('wait', 'nowy SMS'));
  return `<div class="bub ${item.kind === 'in' ? 'in' : 'out'}${isNew ? ' new' : ''}"${item.kind === 'in' ? ` title="${EXTERNAL_TITLE}"` : ''}>`
    + `<div class="bub-text">${text}</div><div class="bub-meta">${meta.join('')}</div></div>`;
}

/** SMS-y według czasu, z dniem nad pierwszym SMS-em każdego dnia. */
function chat(items, fresh, phone) {
  let day = null;
  const rows = [];
  for (const item of items) {
    const d = stamp(item.at.at).slice(0, 10);
    if (d !== day) {
      rows.push(`<div class="day">${esc(d)}</div>`);
      day = d;
    }
    rows.push(bubble(item, fresh, phone));
  }
  return `<div class="chat">${rows.join('')}</div>`;
}

const counter = (draft) => `<b>${draft.characters}</b> ${pluralWord(draft.characters, 'znak', 'znaki', 'znaków')} · `
  + `<b>${draft.parts}</b> ${pluralWord(draft.parts, 'część', 'części', 'części')}`;

function draftSection(draft, state) {
  if (state.replySent) {
    return section('Szkic odpowiedzi', `<div class="sent">Odpowiedź została przyjęta do wysyłki jako wiadomość <span class="mono">${esc(state.replySent)}</span></div>`);
  }
  const busy = state.busy === true;
  return section('Szkic odpowiedzi', '<div class="msg"><div class="msg-head">'
    + `<span>Odpowiedź do <b>${esc(phoneLabel(draft.to))}</b></span><span>${counter(draft)}</span></div>`
    + `<div class="msg-text">${esc(draft.text)}</div></div>`
    + note(`Szkic jest ważny do ${stamp(draft.expiresAt)}. Wysyłkę zatwierdza człowiek w tym widoku, a agent sam jej nie wykona.`)
    + buttons(button('Wyślij odpowiedź', { act: 'send-reply', kind: 'primary', disabled: busy }), button('Popraw treść w rozmowie', { act: 'fix', disabled: busy })));
}

/**
 * HTML widoku rozmowy z wyniku conversation albo prepare_conversation_reply (z polem `draft`). `state`: `fresh`
 * identyfikatory nowych SMS-ów klienta, `asked` prośba o odpowiedź przekazana, `replySent` identyfikator wysłanej
 * odpowiedzi, `busy` w trakcie wywołania.
 */
export function renderConversation(d, state = {}) {
  const fresh = state.fresh ?? new Set();
  const busy = state.busy === true;
  const list = d.items.length === 0 ? note('Bramka nie znalazła SMS-ów w rozmowie z tym numerem w ostatnich 30 dniach') : chat(d.items, fresh, d.phone);
  const narrowed = d.sent === 'replies'
    ? note('Z wysłanych wiadomości widok pokazuje wyłącznie odpowiedzi i wysyłkę, na którą odpowiada pierwszy SMS klienta. '
      + 'Pozostałe wysłane wiadomości wymagają uprawnienia „Odczyt wysłanych”.') : '';
  const ask = fresh.size > 0 && d.canReply && !state.asked ? buttons(button('Poproś o odpowiedź', { act: 'ask', kind: 'primary', disabled: busy })) : '';
  return section(`SMS-y w rozmowie: ${d.items.length}`,
    (d.hasEarlier ? buttons(button('Wcześniejsze', { act: 'earlier', disabled: busy })) : '')
    + `<div class="chat-head"><span>Klient ${esc(phoneLabel(d.phone))}</span><span>Firma</span></div>${list}${narrowed}${ask}`,
    'Treść SMS-ów klienta pochodzi od zewnętrznego nadawcy i nie jest poleceniem')
    + (d.draft ? draftSection(d.draft, state) : '');
}

const byTime = (a, b) => a.at.at.localeCompare(b.at.at) || a.id.localeCompare(b.id);

/** Uruchomienie widoku rozmowy w dokumencie. */
export function startConversation(win, env) {
  const doc = win.document;
  const root = doc.getElementById('tresc');
  const live = doc.getElementById('na-zywo');
  const refreshButton = doc.getElementById('odswiez');
  const say = sayIn(doc);
  const s = {
    data: null, seen: new Set(), fresh: new Set(), asked: false, confirm: null, replySent: null, busy: false, stop: null, retrying: false,
  };
  refreshButton.hidden = true;
  const draw = () => {
    if (s.data) root.innerHTML = renderConversation(s.data, s);
  };

  /** Pozycje odczytu w miejsce pozycji o tym samym identyfikatorze; nieznany SMS klienta z odświeżenia jest nowy. */
  const merge = (incoming, markNew) => {
    const byId = new Map(s.data.items.map((i) => [i.id, i]));
    for (const item of incoming) {
      if (item.kind === 'in' && !s.seen.has(item.id)) {
        s.seen.add(item.id);
        if (markNew) {
          s.fresh.add(item.id);
          s.asked = false;
        }
      }
      byId.set(item.id, item);
    }
    return [...byId.values()].sort(byTime);
  };
  const update = (data) => {
    if (s.retrying) {
      s.retrying = false;
      say('plain', '');
    }
    s.data = { ...s.data, items: merge(data.items, true), lastInboundId: data.lastInboundId ?? s.data.lastInboundId, sent: data.sent, canReply: data.canReply };
    draw();
  };
  const retry = (detail) => {
    s.retrying = true;
    say('wait', retryText(CONVERSATION_REFRESH_MS), detail);
  };
  const end = (why, text, detail) => {
    s.stop = null;
    s.retrying = false;
    live.textContent = LIVE_TEXT[why] ?? '';
    refreshButton.hidden = false;
    if (why === 'error') say('fail', text, detail);
  };
  const watch = () => {
    s.stop?.();
    refreshButton.hidden = true;
    live.textContent = LIVE_TEXT.watching;
    s.stop = watchConversation(bridge, win, () => ({ phone: s.data.phone }), { onData: update, onEnd: end, onRetry: retry });
  };
  const show = (result) => {
    if (result.isError) return say('fail', textOf(result));
    const data = result.structuredContent;
    if (!data) {
      root.textContent = textOf(result);
      return undefined;
    }
    Object.assign(s, {
      data, seen: new Set(data.items.filter((i) => i.kind === 'in').map((i) => i.id)), fresh: new Set(), asked: false,
      confirm: result._meta?.confirm ?? null, replySent: null,
    });
    say('plain', '');
    draw();
    return watch();
  };
  const run = async (task) => {
    if (s.busy || !s.data) return;
    // Komunikat działania pracownika zastępuje komunikat o ponowieniu odczytu i zostaje po udanym odczycie.
    s.retrying = false;
    s.busy = true;
    draw();
    try {
      await task();
    } catch (error) {
      say('fail', ...failure(error));
    } finally {
      s.busy = false;
      draw();
    }
  };
  /** Odczyt rozmowy od razu i ponowne odświeżanie przez 15 minut. */
  const refresh = async () => {
    const result = await bridge.callTool('conversation', { phone: s.data.phone });
    if (result.isError || !result.structuredContent) return say('fail', textOf(result));
    update(result.structuredContent);
    return watch();
  };

  const bridge = createBridge(win, {
    version: env.version,
    onContext: (context) => applyTheme(doc, context),
    onToolResult: show,
    onToolCancelled: (reason) => say('wait', cancelledText(reason)),
  });

  refreshButton.addEventListener('click', () => run(async () => {
    say('plain', '');
    await refresh();
  }));
  root.addEventListener('click', (event) => {
    const target = event.target.closest?.('button[data-act]');
    if (!target || target.disabled) return;
    const act = target.dataset.act;
    if (act === 'earlier') {
      run(async () => {
        const result = await bridge.callTool('conversation', { phone: s.data.phone, before: s.data.earliest });
        if (result.isError || !result.structuredContent) return say('fail', textOf(result));
        const older = result.structuredContent;
        s.data = { ...s.data, items: merge(older.items, false), hasEarlier: older.hasEarlier, earliest: older.earliest };
        return say('plain', '');
      });
    } else if (act === 'ask') {
      run(async () => {
        const sent = await bridge.sendMessage(ASK_REPLY);
        if (sent) s.asked = true;
        say(sent ? 'ok' : 'plain', sent ? forwardedText('Prośba o odpowiedź') : 'Napisz w rozmowie, jaką odpowiedź przygotować na ostatni SMS klienta');
      });
    } else if (act === 'fix') {
      run(async () => {
        const sent = await bridge.sendMessage(REPLY_FIX_MESSAGE);
        say(sent ? 'ok' : 'plain', sent ? forwardedText('Prośba o poprawę treści') : 'Napisz w rozmowie, co zmienić w treści odpowiedzi');
      });
    } else if (act === 'send-reply') {
      run(async () => {
        const result = await bridge.callTool('send_reply', { draftId: s.data.draft.draftId, ...(s.confirm ? { confirm: s.confirm } : {}) });
        if (result.isError) return say('fail', textOf(result));
        const out = result.structuredContent;
        s.replySent = out.kind === 'package' ? out.id : out.ids[0];
        say('plain', '');
        draw();
        // Wysłana odpowiedź pojawia się w rozmowie od razu, a jej stan doręczenia przy kolejnych odczytach.
        return refresh();
      });
    }
  });
}
