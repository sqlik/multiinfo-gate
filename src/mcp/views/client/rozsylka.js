// Widok „Postęp rozsyłki” według wyniku package_status: w trakcie wysyłania postęp, po raporcie liczby w stanach,
// przyczyny niedoręczeń, doręczenia w kolejnych godzinach i pliki CSV. Widok sam odświeża stan co 30 s,
// a odbiorców doładowuje porcjami.
import {
  applyTheme, badge, button, buttons, CANCEL_WINDOW, cancelledText, createBridge, esc, field, fields, note, num, openDownload, phoneLabel, sayIn, section,
  stamp, textOf, tile, tiles, txt,
} from './bridge.js';
import { barChart, stackBar } from './chart.js';
import { STATE_LABELS } from './doreczenia.js';

export const PACKAGE_REFRESH_MS = 30_000;
export const PACKAGE_REFRESH_MAX_MS = 1_800_000;
/** Kolejność odcinków paska po raporcie i ich kolory. */
const REPORT_ORDER = ['delivered', 'failed', 'expired', 'blocked', 'cancelled', 'unknown'];
const REPORT_TONE = { delivered: 'ok', failed: 'fail', blocked: 'fail' };
/** Stany z własnym kaflem po raporcie; pozostałe wymienia zdanie pod kaflami. */
const REPORT_TILES = new Set(['delivered', 'failed', 'expired']);
/** Najwięcej odbiorców w jednym odczycie package_status. */
const PAGE_MAX = 200;
const PACKAGE_TONE = { completed: 'ok', failed: 'fail', cancelled: 'plain' };
/** Wykres doręczeń uzupełnia godziny bez doręczeń najwyżej w tylu kolejnych godzinach. */
const DELIVERY_HOURS_MAX = 168;
const LIVE_TEXT = { watching: '● na żywo, co 30 s', timeout: 'odświeżanie zatrzymane po 30 minutach' };

/** Rozsyłka nie zmieni już stanu: raport jest gotowy albo rozsyłka zakończyła się bez wysyłki. */
export function packageSettled(d) {
  return d.report !== null || (d.final === true && d.status !== 'completed');
}

/** Rozsyłka czeka w bramce na termin albo na decyzję administratora; do przekazania nie zmienia stanu sama z siebie. */
export const packagePending = (d) => d.status === 'scheduled' || d.status === 'overdue';

const OVERDUE_TEXT = 'Bramka nie przekazała rozsyłki do Multiinfo w ciągu 60 minut od terminu. Decyzję o wysłaniu albo anulowaniu podejmuje administrator bramki.';

/** Rozsyłka przed przekazaniem: termin, chwila przekazania i anulowanie, gdy agent może ją anulować. */
function pendingSection(d, busy) {
  const scheduled = d.status === 'scheduled';
  return section(scheduled ? 'Zaplanowana rozsyłka' : 'Termin minął', fields(
    d.schedule ? field('Termin', txt(stamp(d.schedule.startAt.at))) : '',
    scheduled && d.schedule?.handoverAt ? field('Przekazanie do Multiinfo', txt(stamp(d.schedule.handoverAt.at))) : '',
  ) + note(scheduled ? CANCEL_WINDOW : OVERDUE_TEXT)
    + (d.cancellable ? buttons(button('Anuluj rozsyłkę', { act: 'cancel-package', kind: 'danger', disabled: busy })) : ''));
}

/**
 * Odświeżanie stanu rozsyłki przez package_status z `args` co 30 s, do raportu albo stanu ostatecznego, najwyżej
 * 30 minut. `args` może być funkcją, która podaje argumenty przy każdym odczycie. `handlers.onData` otrzymuje każdy
 * stan, a `handlers.onEnd` powód końca: settled, timeout albo error z tekstem.
 */
export function watchPackage(bridge, win, args, handlers, now = () => Date.now()) {
  const started = now();
  async function tick() {
    let result;
    try {
      result = await bridge.callTool('package_status', typeof args === 'function' ? args() : args);
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

const percent = (part, whole) => (whole === 0 ? '-' : `${((part / whole) * 100).toFixed(1).replace('.', ',')} %`);

function progressSection(d) {
  const passed = d.remaining === null ? null : Math.max(0, d.recipients - d.remaining);
  const waiting = d.report === null && !packageSettled(d);
  return section('Postęp', (passed === null ? '' : stackBar([{ tone: 'wait', value: passed }, { tone: 'rest', value: d.remaining }]))
    + tiles(
      tile('Odbiorcy', num(d.recipients), 'w rozsyłce'),
      passed === null ? tile('Przekazane', '-', 'czeka na Multiinfo') : tile('Przekazane', num(passed), 'do Multiinfo'),
      passed === null ? tile('Do wysłania', '-', 'czeka na Multiinfo') : tile('Do wysłania', num(d.remaining), 'w kolejce Multiinfo'),
      tile('Raport', 'po wysyłce', waiting ? 'widok sprawdza co 30 s' : 'raport niedostępny'),
    )
    + (waiting ? note(d.final ? 'Rozsyłka została zakończona. Raport doręczeń jeszcze nie jest gotowy, a widok sam sprawdza jego stan.'
      : 'Liczby w stanach, przyczyny niedoręczeń i pliki CSV pojawią się po raporcie doręczeń') : ''));
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

function reportSections(d, busy) {
  const r = d.report;
  const count = (k) => r.byStatus[k] ?? 0;
  const keys = [...REPORT_ORDER.filter((k) => k in r.byStatus), ...Object.keys(r.byStatus).filter((k) => !REPORT_ORDER.includes(k))];
  const others = keys.filter((k) => !REPORT_TILES.has(k) && count(k) > 0).map((k) => `${STATE_LABELS[k] ?? k} ${num(count(k))}`);
  const hours = deliveryHours(r.deliveredByHour);
  const every = Math.max(1, Math.ceil(hours.length / 12));
  const chart = hours.length === 0 ? '<p class="muted">Raport nie zawiera czasu doręczeń</p>'
    : barChart(hours.map((h, i) => ({ label: i % every === 0 ? h.hour.slice(11) : '', value: h.count, title: `${h.hour}, doręczenia: ${h.count}` })),
      { label: 'Doręczenia w kolejnych godzinach', height: 140, tone: 'ok' });
  const reasons = r.reasons.length === 0 ? '<p class="muted">Raport nie zawiera niedoręczonych wiadomości</p>'
    : '<table><tr><th>Przyczyna</th><th class="num">Liczba</th></tr>'
      + r.reasons.map((x) => `<tr><td>${esc(x.description)}</td><td class="num">${num(x.count)}</td></tr>`).join('') + '</table>';
  const failed = keys.filter((k) => k !== 'delivered').reduce((sum, k) => sum + count(k), 0);
  return section('Wynik', stackBar(keys.map((k) => ({ tone: REPORT_TONE[k] ?? 'plain', value: count(k) })))
    + tiles(
      tile('Doręczone', num(count('delivered')), percent(count('delivered'), d.recipients), 'ok'),
      tile('Niedoręczone', num(count('failed')), percent(count('failed'), d.recipients)),
      tile('Przedawnione', num(count('expired')), percent(count('expired'), d.recipients)),
      tile('Razem', num(d.recipients), 'odbiorców'),
    )
    + (others.length > 0 ? note(`Pozostałe stany: ${others.join(', ')}`) : ''))
    + section('Doręczenia w kolejnych godzinach', chart)
    + section('Niedoręczone według przyczyny', reasons + buttons(
      button('Pobierz raport CSV', { act: 'csv', kind: 'primary', disabled: busy, data: { file: 'report' } }),
      failed > 0 ? button('Pobierz CSV niedoręczonych', { act: 'csv', disabled: busy, data: { file: 'failed' } }) : '',
    ));
}

function recipientsSection(d, busy) {
  if (d.items.length === 0) return '';
  const rows = d.items.map((i) => `<tr><td class="nw">${esc(phoneLabel(i.to))}</td><td>${esc(i.clientId ?? '')}</td>`
    + `<td>${esc(i.statusLabel)}</td><td class="nw">${i.changed ? stamp(i.changed.at) : ''}</td></tr>`).join('');
  return section('Odbiorcy', `<table><tr><th>Numer</th><th>Klient</th><th>Stan</th><th>Zmiana</th></tr>${rows}</table>`
    + (d.hasMore ? buttons(button('Pokaż kolejnych odbiorców', { act: 'more', disabled: busy })) : ''));
}

/** HTML widoku rozsyłki; `state.busy` w trakcie wywołania. */
export function renderPackage(d, state = {}) {
  const busy = state.busy === true;
  return section(`Rozsyłka ${d.id}`, fields(
    field('Stan', `<div class="txt">${badge(PACKAGE_TONE[d.status] ?? 'wait', d.statusLabel)}</div>`), field('Przyjęta', txt(stamp(d.created.at))),
    field('Źródło', txt(d.source)), field('Odbiorcy', txt(num(d.recipients))),
    d.schedule && !packagePending(d) ? field('Termin', txt(stamp(d.schedule.startAt.at))) : '',
  ))
    + (packagePending(d) ? pendingSection(d, busy) : d.report === null ? progressSection(d) : reportSections(d, busy))
    + recipientsSection(d, busy);
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
  // Odświeżenie obejmuje wszystkich doładowanych odbiorców, najwyżej 200 w jednym odczycie.
  const args = () => {
    const limit = Math.min(PAGE_MAX, Math.max(s.input?.limit ?? 25, s.data.items.length));
    return { packageId: s.data.id, ...(limit === 25 ? {} : { limit }) };
  };
  const end = (why, text) => {
    s.watching = false;
    live.textContent = LIVE_TEXT[why] ?? '';
    if (why === 'error') say('fail', text);
  };
  const watch = () => {
    // Rozsyłka przed przekazaniem nie zmienia stanu przez wiele godzin, dlatego widok nie odświeża jej na żywo.
    if (s.watching || packageSettled(s.data) || packagePending(s.data)) return;
    s.watching = true;
    live.textContent = LIVE_TEXT.watching;
    watchPackage(bridge, win, args, { onData: (data) => { s.data = data; draw(); }, onEnd: end });
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
    if (packageSettled(s.data) || packagePending(s.data)) live.textContent = '';
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
    const button = event.target.closest?.('button[data-act]');
    if (!button || button.disabled) return;
    if (button.dataset.act === 'more') {
      run(async () => {
        const result = await bridge.callTool('package_status', { packageId: s.data.id, offset: s.data.items.length, limit: s.input?.limit ?? 25 });
        if (result.isError) return say('fail', textOf(result));
        const next = result.structuredContent;
        s.data = { ...next, items: [...s.data.items, ...next.items] };
        return say('plain', '');
      });
    } else if (button.dataset.act === 'cancel-package') {
      run(async () => {
        const result = await bridge.callTool('cancel_package', { id: s.data.id });
        if (result.isError) return say('fail', textOf(result));
        show(await bridge.callTool('package_status', args()));
        return say('ok', textOf(result));
      });
    } else if (button.dataset.act === 'csv') {
      run(async () => {
        const result = await bridge.callTool('package_report', { packageId: s.data.id, file: button.dataset.file });
        if (result.isError) return say('fail', textOf(result));
        return openDownload(bridge, say, result.structuredContent);
      });
    }
  });
}
