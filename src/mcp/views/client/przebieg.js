// Widok „Przebieg doręczenia” według wyniku delivery_trace: pola pozycji, treść w oknie z nadawcą, oś czasu etapów
// i kod operatora. „Anuluj wiadomość” jest zawsze widoczny: czerwony przed przekazaniem do sieci operatora, a w pozostałych
// stanach i po odmowie bramki wyszarzony z przyczyną. „Wyślij ponownie” przygotowuje SMS z tą samą treścią.
import {
  applyTheme, badge, button, buttons, cancelledText, createBridge, esc, field, fields, messageBox, note, phoneLabel, sayIn, section, smsCounter,
  stamp, textOf, txt,
} from './bridge.js';
import { latinText, measure } from './measure.js';
import { mountSend } from './send.js';

const WAITING = new Set(['queued', 'sent', 'throttled', 'pending']);
const BEFORE_NETWORK = new Set(['queued', 'throttled']);

function statusTone(status) {
  if (status === 'delivered') return 'ok';
  if (WAITING.has(status)) return 'wait';
  return status === 'cancelled' ? 'plain' : 'fail';
}

/** Zdanie przy przycisku anulowania: dlaczego można albo dlaczego nie można anulować pozycji. */
export function cancelReason(e) {
  if (e.kind !== 'message') return 'Odbiorcy rozsyłki nie można anulować pojedynczo';
  if (e.cancellable) return 'Multiinfo nie przekazało jeszcze wiadomości do sieci operatora, dlatego można ją anulować';
  if (BEFORE_NETWORK.has(e.status) && e.agentSent === false) return 'Agent anuluje wyłącznie wiadomości wysłane przez tę integrację, a pozostałe anuluje administrator w panelu bramki';
  if (BEFORE_NETWORK.has(e.status)) return 'Anulowanie wymaga uprawnienia „Wysyłka SMS-ów”, które nadaje administrator bramki w integracji Agent AI';
  if (e.status === 'delivered') return 'Wiadomość została doręczona, dlatego anulowanie nie jest możliwe';
  if (e.status === 'sent') return 'Wiadomość została przekazana do sieci operatora, dlatego anulowanie nie jest możliwe';
  if (e.status === 'cancelled') return 'Wiadomość została anulowana';
  if (e.status === 'unknown') return 'Stan wiadomości jest nieznany, dlatego anulowanie nie jest możliwe';
  return 'Wiadomość osiągnęła stan ostateczny, dlatego anulowanie nie jest możliwe';
}

/** Okno treści pozycji: nadawca albo numer usługi, licznik według kodowania wysyłki i treść, przy GSM z łacińskimi literami. */
function contentBox(e) {
  const gsm = e.encoding === 'gsm';
  const m = measure(e.text, gsm ? 'gsm' : 'unicode');
  return '<span class="sub-lbl">Treść</span>' + messageBox({
    sender: e.sender ?? `numer usługi ${e.serviceId}`,
    counter: smsCounter({ characters: m.characters, parts: e.parts ?? m.parts, encoding: gsm ? 'gsm' : 'ucs2' }),
    body: esc(gsm ? latinText(e.text) : e.text),
  });
}

/** Oczekujący etap: przekazanie do Multiinfo, przekazanie do sieci operatora, limit operatora albo raport doręczenia. */
function pendingStage(e) {
  if (e.status === 'throttled') return 'Wysyłka wstrzymana limitem operatora';
  if (e.status !== 'queued') return 'Oczekiwanie na raport doręczenia';
  return e.stages.some((s) => s.kind === 'sent') ? 'Oczekiwanie na przekazanie do sieci operatora' : 'Oczekiwanie na przekazanie do Multiinfo';
}

function traceEntry(e, i, refused) {
  const title = e.kind === 'message' ? `Wiadomość ${e.id}` : `Odbiorca rozsyłki ${e.packageId}`;
  const details = fields(
    field('Odbiorca', txt(phoneLabel(e.to))), field('Stan', `<div class="txt">${badge(statusTone(e.status), e.statusLabel)}</div>`),
    field('Źródło', txt(e.source)), field('Przyjęta', txt(stamp(e.created.at))),
  );
  const stages = e.stages.map((s) => `<li>${esc(s.label)}<span class="t">${esc(stamp(s.at))}</span>${s.detail ? `<div class="note">${esc(s.detail)}</div>` : ''}</li>`);
  if (WAITING.has(e.status)) {
    stages.push(`<li class="pending">${pendingStage(e)}</li>`);
  }
  const timeline = `<span class="sub-lbl">Przebieg</span><ul class="timeline">${stages.join('')}</ul>`
    + (e.operator ? note(`Kod operatora ${e.operator.code}: ${e.operator.description}`) : '');
  const refusal = refused?.get(e.id) ?? null;
  const actions = buttons(
    button('Anuluj wiadomość', { act: 'cancel', kind: 'danger', disabled: !e.cancellable || refusal !== null, data: { index: i } }),
    e.text ? button('Wyślij ponownie', { act: 'resend', kind: 'primary', data: { index: i } }) : '',
  );
  const notice = refusal === null ? `${note(cancelReason(e))}<p class="notice" data-say="${i}" role="status" hidden></p>`
    : `<p class="notice n-fail" data-say="${i}" role="status">${esc(refusal)}</p>`;
  return section(title, details + (e.text ? contentBox(e) : '') + timeline + actions + notice + `<div class="resend" data-resend="${i}"></div>`);
}

/**
 * Komunikat przy pozycji przebiegu, pod jej przyciskami. Element jest wyszukiwany przy każdym komunikacie,
 * ponieważ odświeżenie po anulowaniu rysuje pozycje od nowa.
 */
export function sayAt(root, index) {
  return (tone, text) => {
    const notice = root.querySelector(`[data-say="${index}"]`);
    if (!notice) return;
    notice.hidden = !text;
    notice.className = `notice n-${tone}`;
    notice.textContent = text;
  };
}

/**
 * HTML przebiegu: każda pozycja z osią czasu, „Anuluj wiadomość” i „Wyślij ponownie” przy zapisanej treści.
 * `state.refused` to odmowy anulowania według identyfikatora wiadomości.
 */
export function renderTrace(entries, state = {}) {
  if (!entries || entries.length === 0) return '<p class="muted">Bramka nie znalazła wiadomości spełniających warunki</p>';
  return entries.map((e, i) => traceEntry(e, i, state.refused)).join('');
}

/** Uruchomienie widoku przebiegu w dokumencie. */
export function startTrace(win, env) {
  const doc = win.document;
  const content = doc.getElementById('tresc');
  const say = sayIn(doc);
  let input = null;
  let entries = [];
  let panels = new Map();
  /** Odmowy anulowania zostają po odświeżeniu, dlatego przycisk odmówionej wiadomości pozostaje wyszarzony. */
  const refused = new Map();
  const draw = () => {
    panels = new Map();
    content.innerHTML = renderTrace(entries, { refused });
  };

  const show = (result) => {
    if (result.isError) return say('fail', textOf(result));
    if (!result.structuredContent) {
      content.textContent = textOf(result);
      return undefined;
    }
    entries = result.structuredContent.entries ?? [];
    draw();
    return say('plain', '');
  };

  const bridge = createBridge(win, {
    version: env.version,
    onContext: (context) => applyTheme(doc, context),
    onToolInput: (args) => { input = args; },
    onToolResult: show,
    onToolCancelled: (reason) => say('wait', cancelledText(reason)),
  });

  /** Warunki odświeżenia: dane wejściowe narzędzia, a bez nich identyfikator jedynej wiadomości. */
  const query = () => input ?? (entries.length === 1 && entries[0].kind === 'message' ? { id: entries[0].id } : null);
  async function refresh() {
    const q = query();
    if (q === null) return say('fail', 'Aplikacja AI nie przekazała widokowi warunków wyszukiwania. Poproś agenta o ponowne sprawdzenie.');
    return show(await bridge.callTool('delivery_trace', q));
  }

  const guarded = (button, task, tell = say) => async () => {
    button.disabled = true;
    try {
      await task();
    } catch (error) {
      tell('fail', error instanceof Error ? error.message : String(error));
    } finally {
      button.disabled = false;
    }
  };

  const refreshButton = doc.getElementById('odswiez');
  refreshButton.addEventListener('click', () => guarded(refreshButton, refresh)());

  content.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-act="cancel"], button[data-act="resend"]');
    if (!button || button.disabled || !button.dataset.index) return;
    const index = Number(button.dataset.index);
    const entry = entries[index];
    if (!entry) return;
    // Wynik akcji pojawia się przy pozycji, której dotyczy, a nie pod ostatnią pozycją przebiegu.
    const tell = sayAt(content, index);
    if (button.dataset.act === 'cancel') {
      guarded(button, async () => {
        const result = await bridge.callTool('cancel_message', { id: entry.id });
        if (result.isError) {
          refused.set(entry.id, textOf(result));
          return draw();
        }
        await refresh();
        return tell('ok', `Wiadomość ${entry.id} została anulowana`);
      }, tell)();
    } else {
      guarded(button, async () => {
        tell('plain', '');
        const q = { to: [entry.to], text: entry.text };
        const result = await bridge.callTool('prepare_sms', q);
        if (result.isError) return tell('fail', textOf(result));
        let panel = panels.get(index);
        if (!panel) {
          panel = mountSend(content.querySelector(`[data-resend="${index}"]`), { bridge, say: tell, win });
          panels.set(index, panel);
        }
        return panel.show(result, q);
      }, tell)();
    }
  });
}
