// Widok „Przebieg doręczenia” według wyniku delivery_trace: oś czasu etapów, stan, źródło i kod operatora.
// „Anuluj” woła cancel_message, „Wyślij ponownie” przygotowuje SMS z tą samą treścią i rysuje panel wysyłki.
// Czas w zapisie panelu, jak w pozostałych widokach, a nie w zapisie tekstu dla agenta.
import { applyTheme, badge, cancelledText, createBridge, esc, note, phoneLabel, sayIn, stamp, textOf } from './bridge.js';
import { mountSend } from './send.js';

const WAITING = new Set(['queued', 'sent', 'throttled', 'pending']);

function statusTone(status) {
  if (status === 'delivered') return 'ok';
  if (WAITING.has(status)) return 'wait';
  return status === 'cancelled' ? 'plain' : 'fail';
}

function traceEntry(e, i) {
  const title = e.kind === 'message'
    ? `Wiadomość <span class="mono">${esc(e.id)}</span>`
    : `Odbiorca rozsyłki <span class="mono">${esc(e.packageId)}</span>`;
  const details = '<dl class="kv">'
    + `<dt>Odbiorca</dt><dd class="mono">${esc(phoneLabel(e.to))}</dd>`
    + `<dt>Stan</dt><dd>${badge(statusTone(e.status), e.statusLabel)}</dd>`
    + `<dt>Źródło</dt><dd>${esc(e.source)}</dd>`
    + `<dt>Przyjęta</dt><dd>${esc(stamp(e.created.at))}</dd>`
    + (e.text ? `<dt>Treść</dt><dd>${esc(e.text)}</dd>` : '')
    + '</dl>';
  const stages = e.stages.map((s) => `<li>${esc(s.label)}<span class="t">${esc(stamp(s.at))}</span>${s.detail ? `<div class="note">${esc(s.detail)}</div>` : ''}</li>`);
  if (WAITING.has(e.status)) stages.push('<li class="pending">Oczekiwanie na raport doręczenia</li>');
  const timeline = `<ul class="timeline">${stages.join('')}</ul>`
    + (e.operator ? note(`Kod operatora ${e.operator.code}: ${e.operator.description}`) : '');
  const actions = [
    ...(e.cancellable ? [`<button type="button" class="btn" data-act="cancel" data-index="${i}">Anuluj</button>`] : []),
    ...(e.text ? [`<button type="button" class="btn" data-act="resend" data-index="${i}">Wyślij ponownie</button>`] : []),
  ];
  return `<section class="entry"><h2 class="entry-title">${title}</h2>`
    + `<div class="grid2"><div>${details}</div><div>${timeline}</div></div>`
    + (actions.length > 0 ? `<div class="row actions">${actions.join('')}</div>` : '')
    + `<p class="notice" data-say="${i}" role="status" hidden></p>`
    + `<div class="resend" data-resend="${i}"></div></section>`;
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

/** HTML przebiegu: każda pozycja z osią czasu, „Anuluj” przy `cancellable`, „Wyślij ponownie” przy zapisanej treści. */
export function renderTrace(entries) {
  if (!entries || entries.length === 0) return '<p class="muted">Bramka nie znalazła wiadomości spełniających warunki</p>';
  return entries.map(traceEntry).join('');
}

/** Uruchomienie widoku przebiegu w dokumencie. */
export function startTrace(win, env) {
  const doc = win.document;
  const content = doc.getElementById('tresc');
  const say = sayIn(doc);
  let input = null;
  let entries = [];
  let panels = new Map();

  const show = (result) => {
    if (result.isError) return say('fail', textOf(result));
    if (!result.structuredContent) {
      content.textContent = textOf(result);
      return undefined;
    }
    entries = result.structuredContent.entries ?? [];
    panels = new Map();
    content.innerHTML = renderTrace(entries);
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
        if (result.isError) return tell('fail', textOf(result));
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
