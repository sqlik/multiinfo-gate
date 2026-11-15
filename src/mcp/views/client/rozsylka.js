// Widok „Postęp rozsyłki” według wyniku package_status: w trakcie wysyłania postęp, po raporcie liczby w stanach,
// przyczyny niedoręczeń, doręczenia w kolejnych godzinach i pliki CSV. Widok sam odświeża stan co 30 s.
import { applyTheme, cancelledText, createBridge, esc, note, num, openDownload, phoneLabel, sayIn, stamp, textOf } from './bridge.js';
import { barChart, stackBar } from './chart.js';
import { STATE_LABELS } from './doreczenia.js';

export const PACKAGE_REFRESH_MS = 30_000;
export const PACKAGE_REFRESH_MAX_MS = 1_800_000;
/** Kolejność odcinków paska po raporcie i ich kolory. */
const REPORT_ORDER = ['delivered', 'failed', 'expired', 'blocked', 'cancelled', 'unknown'];
const REPORT_TONE = { delivered: 'ok', failed: 'fail', expired: 'fail', blocked: 'fail' };
/** Wykres doręczeń uzupełnia godziny bez doręczeń najwyżej w tylu kolejnych godzinach. */
const DELIVERY_HOURS_MAX = 168;
const LIVE_TEXT = { watching: '● na żywo, co 30 s', timeout: 'odświeżanie zatrzymane po 30 minutach' };

const disabledIf = (busy) => (busy ? ' disabled' : '');

/** Rozsyłka nie zmieni już stanu: raport jest gotowy albo rozsyłka zakończyła się bez wysyłki. */
export function packageSettled(d) {
  return d.report !== null || (d.final === true && d.status !== 'completed');
}

/**
 * Odświeżanie stanu rozsyłki przez package_status z `args` co 30 s, do raportu albo stanu ostatecznego, najwyżej
 * 30 minut. `handlers.onData` otrzymuje każdy stan, a `handlers.onEnd` powód końca: settled, timeout albo error z tekstem.
 */
export function watchPackage(bridge, win, args, handlers, now = () => Date.now()) {
  const started = now();
  async function tick() {
    let result;
    try {
      result = await bridge.callTool('package_status', args);
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
    if (result.isError || !result.structuredContent) {
      handlers.onEnd('error', textOf(result));
      return;
    }
    handlers.onData(result.structuredContent);
    if (packageSettled(result.structuredContent)) handlers.onEnd('settled');
    else if (now() - started >= PACKAGE_REFRESH_MAX_MS) handlers.onEnd('timeout');
    else win.setTimeout(tick, PACKAGE_REFRESH_MS);
  }
  win.setTimeout(tick, PACKAGE_REFRESH_MS);
}

const legendItem = (tone, label, n) => `<span><i class="sw t-${tone}"></i>${esc(label)} <b>${num(n)}</b></span>`;

function progressPanel(d) {
  if (d.remaining === null) return `<p class="stack-note">Odbiorcy: <b>${num(d.recipients)}</b>, stan: ${esc(d.statusLabel)}</p>`;
  const passed = Math.max(0, d.recipients - d.remaining);
  return stackBar([{ tone: 'wait', value: passed }, { tone: 'rest', value: d.remaining }])
    + `<p class="stack-note">Przekazano do Multiinfo <b>${num(passed)}</b> z ${num(d.recipients)}, do wysłania pozostało ${num(d.remaining)}</p>`;
}

/** Godziny raportu `RRRR-MM-DD GG:00` w czasie polskim, z godzinami bez doręczeń między pierwszą a ostatnią. */
function deliveryHours(list) {
  const toMs = (hour) => Date.UTC(+hour.slice(0, 4), +hour.slice(5, 7) - 1, +hour.slice(8, 10), +hour.slice(11, 13));
  if (list.length === 0) return [];
  const byHour = new Map(list.map((h) => [h.hour, h.count]));
  const first = toMs(list[0].hour);
  const span = Math.round((toMs(list[list.length - 1].hour) - first) / 3_600_000) + 1;
  if (span > DELIVERY_HOURS_MAX) return list;
  return Array.from({ length: span }, (_, i) => {
    const hour = `${new Date(first + i * 3_600_000).toISOString().slice(0, 13).replace('T', ' ')}:00`;
    return { hour, count: byHour.get(hour) ?? 0 };
  });
}

function reportPanel(d, busy) {
  const r = d.report;
  const keys = [...REPORT_ORDER.filter((k) => k in r.byStatus), ...Object.keys(r.byStatus).filter((k) => !REPORT_ORDER.includes(k))];
  const tone = (k) => REPORT_TONE[k] ?? 'plain';
  const hours = deliveryHours(r.deliveredByHour);
  const every = Math.max(1, Math.ceil(hours.length / 8));
  const chart = hours.length === 0 ? '<p class="muted">Raport nie zawiera czasu doręczeń</p>'
    : barChart(hours.map((h, i) => ({ label: i % every === 0 ? h.hour.slice(11) : '', value: h.count, title: `${h.hour}, doręczenia: ${h.count}` })),
      { label: 'Doręczenia w kolejnych godzinach', width: 320, height: 140, tone: 'ok' });
  const reasons = r.reasons.length === 0 ? '<p class="muted">Raport nie zawiera niedoręczonych wiadomości</p>'
    : '<table><tr><th>Przyczyna</th><th class="num">Liczba</th></tr>'
      + r.reasons.map((x) => `<tr><td>${esc(x.description)}</td><td class="num">${num(x.count)}</td></tr>`).join('') + '</table>';
  const failed = Object.entries(r.byStatus).filter(([k]) => k !== 'delivered').reduce((sum, [, n]) => sum + n, 0);
  return stackBar(keys.map((k) => ({ tone: tone(k), value: r.byStatus[k] })))
    + `<div class="stack-legend">${keys.map((k) => legendItem(tone(k), STATE_LABELS[k] ?? k, r.byStatus[k])).join('')}`
    + `<span>razem <b>${num(d.recipients)}</b></span></div>`
    + `<div class="grid2"><div><div class="chart-title"><span>Doręczenia w kolejnych godzinach</span></div>${chart}</div>`
    + `<div><div class="chart-title"><span>Niedoręczone według przyczyny</span></div>${reasons}</div></div>`
    + `<div class="row"><button type="button" class="btn" data-act="csv" data-file="report"${disabledIf(busy)}>Pobierz raport CSV</button>`
    + (failed > 0 ? `<button type="button" class="btn" data-act="csv" data-file="failed"${disabledIf(busy)}>Pobierz CSV niedoręczonych</button>` : '')
    + '</div>';
}

function recipientsTable(d) {
  if (d.items.length === 0) return '';
  const rows = d.items.map((i) => `<tr><td class="mono nw">${esc(phoneLabel(i.to))}</td><td>${esc(i.clientId ?? '')}</td>`
    + `<td>${esc(i.statusLabel)}</td><td class="nw">${i.changed ? stamp(i.changed.at) : ''}</td></tr>`).join('');
  return '<div class="chart-title"><span>Odbiorcy</span></div>'
    + `<table><tr><th>Numer</th><th>Identyfikator klienta</th><th>Stan</th><th>Zmiana stanu</th></tr>${rows}</table>`
    + (d.hasMore ? note(`Tabela pokazuje ${d.items.length === 1 ? 'pierwszego odbiorcę' : `pierwszych ${d.items.length} odbiorców`}, a pełną listę zawiera raport CSV`) : '');
}

/** HTML widoku rozsyłki; `state.busy` w trakcie wywołania. */
export function renderPackage(d, state = {}) {
  const busy = state.busy === true;
  const waiting = d.report === null && !packageSettled(d);
  return `<p class="who">Rozsyłka <b class="mono">${esc(d.id)}</b> · ${esc(d.statusLabel)} · przyjęta ${stamp(d.created.at)} · ${esc(d.source)}</p>`
    + (d.report === null ? progressPanel(d) : reportPanel(d, busy))
    + (waiting ? note(d.final ? 'Rozsyłka została zakończona. Raport doręczeń jeszcze nie jest gotowy, a widok sam sprawdza jego stan.'
      : 'Liczby w stanach, przyczyny niedoręczeń i pliki CSV pojawią się po raporcie doręczeń') : '')
    + recipientsTable(d);
}

/** Uruchomienie widoku rozsyłki w dokumencie. */
export function startPackage(win, env) {
  const doc = win.document;
  const root = doc.getElementById('tresc');
  const live = doc.getElementById('na-zywo');
  const say = sayIn(doc);
  const s = { input: null, data: null, busy: false, watching: false };
  const draw = () => {
    if (s.data) root.innerHTML = renderPackage(s.data, s);
  };
  const args = () => ({ packageId: s.data.id, ...(s.input?.limit ? { limit: s.input.limit } : {}) });
  const end = (why, text) => {
    s.watching = false;
    live.textContent = LIVE_TEXT[why] ?? '';
    if (why === 'error') say('fail', text);
  };
  const watch = () => {
    if (s.watching || packageSettled(s.data)) return;
    s.watching = true;
    live.textContent = LIVE_TEXT.watching;
    watchPackage(bridge, win, args(), { onData: (data) => { s.data = data; draw(); }, onEnd: end });
  };
  const show = (result) => {
    if (result.isError) return say('fail', textOf(result));
    if (!result.structuredContent) {
      root.textContent = textOf(result);
      return undefined;
    }
    s.data = result.structuredContent;
    say('plain', '');
    draw();
    // Ręczne odświeżenie mogło przynieść raport przed kolejnym odczytem odświeżania.
    if (packageSettled(s.data)) live.textContent = '';
    return watch();
  };
  const run = async (task) => {
    if (s.busy || !s.data) return;
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

  doc.getElementById('odswiez').addEventListener('click', () => run(async () => {
    show(await bridge.callTool('package_status', args()));
  }));
  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-act="csv"]');
    if (!button || button.disabled) return;
    run(async () => {
      const result = await bridge.callTool('package_report', { packageId: s.data.id, file: button.dataset.file });
      if (result.isError) return say('fail', textOf(result));
      return openDownload(bridge, say, result.structuredContent);
    });
  });
}
