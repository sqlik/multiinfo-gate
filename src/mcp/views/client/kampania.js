// Widok „Wyniki kampanii” według wyniku campaign_results: liczby jak w panelu, otwarcia dzień po dniu albo
// kliknięcia w kolejnych godzinach, cele linków, odbiorcy bez otwarcia porcjami, pliki CSV i przypomnienie.
// Po usunięciu szczegółów kampanii zostają liczby i kliknięcia w kolejnych godzinach.
import { applyTheme, cancelledText, createBridge, esc, forwardedText, note, num, openDownload, phoneLabel, sayIn, stamp, textOf } from './bridge.js';
import { barChart } from './chart.js';

/**
 * Stały tekst prośby o przypomnienie, bez nazwy kampanii: nazwę może nadać agent w prepare_sms, a ChatGPT wstawia
 * wiadomość z widoku jako wiadomość użytkownika. Agent zna kampanię z własnego wywołania campaign_results.
 */
export const REMIND_MESSAGE = 'Przygotuj przypomnienie dla odbiorców bez otwarcia kampanii pokazanej w widoku wyników';
/** Wykres godzinowy obejmuje 48 godzin od pierwszej wysyłki, jak wykres kliknięć w panelu. */
const CAMPAIGN_HOURS = 48;
const HOUR_MS = 3_600_000;
/** Najwięcej dni wykresu dziennego: ważność linków wynosi najwyżej 365 dni. */
const CAMPAIGN_DAYS_MAX = 366;

const percentOf = (part, whole) => `${((part / whole) * 100).toFixed(1).replace('.', ',')} %`;
const dayMark = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const off = (busy) => (busy ? ' disabled' : '');

function nextDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function campaignTiles(d) {
  const tile = (label, value, sub) => `<div class="tile"><div class="lbl">${label}</div><div class="val">${num(value)}</div>`
    + `<div class="sub">${esc(sub)}</div></div>`;
  const first = stamp(d.first.at).slice(0, 10);
  const last = stamp(d.last.at).slice(0, 10);
  // Okres w zapisie DD.MM, a przy wysyłkach w różnych latach pełne daty.
  const period = first === last ? first : first.slice(0, 4) === last.slice(0, 4) ? `${dayMark(first)} - ${dayMark(last)}` : `${first} - ${last}`;
  // Bez raportu doręczenia udział otwarć liczy się od wysłanych, jak w panelu.
  const base = d.delivered > 0 ? { whole: d.delivered, of: 'doręczonych' } : { whole: d.sent, of: 'wysłanych' };
  return '<div class="tiles">'
    + tile('Wysłane', d.sent, period)
    + tile('Doręczone', d.delivered, d.delivered === 0 ? 'brak raportu doręczeń' : `${percentOf(d.delivered, d.sent)} wysłanych`)
    + tile('Otwarcia', d.opens, base.whole === 0 ? '-' : `${percentOf(d.opens, base.whole)} ${base.of}`)
    + tile('Kliknięcia', d.clicks, d.opens === 0 ? 'brak otwarć' : `${(d.clicks / d.opens).toFixed(2).replace('.', ',')} na otwarcie`)
    + '</div>';
}

/** Otwarcia każdego dnia od dnia pierwszej wysyłki do dnia ostatniej wysyłki albo ostatniego otwarcia. */
function opensChart(d) {
  const byDay = new Map(d.opensByDay.map((o) => [o.day, o.opens]));
  const first = stamp(d.first.at).slice(0, 10);
  const last = [stamp(d.last.at).slice(0, 10), ...byDay.keys()].reduce((a, b) => (b > a ? b : a), first);
  let days = [];
  for (let day = first; day <= last; day = nextDay(day)) days.push(day);
  if (days.length > CAMPAIGN_DAYS_MAX) days = days.slice(-CAMPAIGN_DAYS_MAX);
  const every = Math.max(1, Math.ceil(days.length / 12));
  return barChart(days.map((day, i) => ({
    label: i % every === 0 ? dayMark(day) : '', value: byDay.get(day) ?? 0, title: `${day}, otwarcia: ${byDay.get(day) ?? 0}`,
  })), { label: 'Otwarcia dzień po dniu' });
}

/**
 * Kliknięcia w 48 godzinach od godziny pierwszej wysyłki, w czasie polskim. W nocy zmiany czasu na zimowy bramka
 * sumuje dwie godziny o tej samej nazwie, dlatego liczba trafia tylko do pierwszej z nich.
 */
function clicksChart(d) {
  const byHour = new Map(d.clicksByHour.map((h) => [h.hour, h.clicks]));
  const start = Math.floor(Date.parse(d.first.at) / HOUR_MS) * HOUR_MS;
  const seen = new Set();
  const points = Array.from({ length: CAMPAIGN_HOURS }, (_, i) => {
    const key = `${stamp(new Date(start + i * HOUR_MS).toISOString()).slice(0, 13)}:00`;
    const value = seen.has(key) ? 0 : byHour.get(key) ?? 0;
    seen.add(key);
    const hour = Number(key.slice(11, 13));
    return { label: hour % 6 === 0 ? key.slice(11) : '', value, title: `${key}, kliknięcia: ${value}` };
  });
  return barChart(points, { label: 'Kliknięcia w pierwszych 48 godzinach od pierwszej wysyłki' });
}

function targetsTable(targets) {
  if (targets.length === 0) return '';
  return '<div class="chart-title"><span>Kliknięcia według celu linku</span></div>'
    + '<table><tr><th>Cel linku</th><th class="num">Otwarcia</th><th class="num">Kliknięcia</th></tr>'
    + targets.map((t) => `<tr><td class="mono">${esc(t.target)}${t.kind === 'individual' ? ' <span class="muted">linki indywidualne</span>' : ''}</td>`
      + `<td class="num">${num(t.opens)}</td><td class="num">${num(t.clicks)}</td></tr>`).join('')
    + '</table>';
}

function unopenedPanel(d, busy) {
  const u = d.unopened;
  if (u === null) return '';
  const list = u.items.length === 0 ? '' : `<div class="recips">${u.items.map((r) => `<div><span>${esc(r.clientId ?? '')}</span>`
    + `<span class="mono">${esc(phoneLabel(r.to))}</span></div>`).join('')}</div>`;
  const more = u.hasMore ? `<button type="button" class="btn" data-act="more"${off(busy)}>Pokaż kolejnych odbiorców</button>` : '';
  const remind = u.total > 0
    ? `<button type="button" class="btn btn-primary" data-act="remind"${off(busy)}>Przygotuj przypomnienie dla odbiorców bez otwarcia</button>` : '';
  return `<div class="chart-title"><span>Odbiorcy bez otwarcia: ${num(u.total)}</span></div>${list}`
    + `<div class="row">${more}<button type="button" class="btn" data-act="csv" data-file="unopened"${off(busy)}>Pobierz CSV odbiorców bez otwarcia</button>`
    + `<button type="button" class="btn" data-act="csv" data-file="opened"${off(busy)}>Pobierz CSV odbiorców z otwarciem</button>${remind}</div>`
    + (remind ? note('Przycisk przekazuje agentowi prośbę o przypomnienie. Numery odbiorców ustala bramka, a agent otrzymuje wyłącznie ich liczbę.') : '');
}

/** HTML widoku kampanii. `state`: `mode` 'days' albo 'hours', `busy` w trakcie wywołania. */
export function renderCampaign(d, state = {}) {
  const purged = d.detailsPurged === true;
  const mode = purged ? 'hours' : state.mode ?? 'days';
  const seg = (value, label) => `<button type="button" data-mode="${value}"${mode === value ? ' class="on"' : ''}>${label}</button>`;
  const title = mode === 'days' ? 'Otwarcia dzień po dniu' : 'Kliknięcia w pierwszych 48 godzinach od pierwszej wysyłki';
  return `<p class="who">Kampania <b>${esc(d.name)}</b></p>${campaignTiles(d)}`
    + (d.bots > 0 ? note(`Bramka pominęła w liczbach kliknięcia automatów: ${d.bots}`) : '')
    + `<div class="chart-title"><span>${title}</span>`
    + (purged ? '' : `<span class="seg">${seg('days', 'otwarcia dziennie')}${seg('hours', 'kliknięcia co godzinę')}</span>`) + '</div>'
    + (mode === 'days' ? opensChart(d) : clicksChart(d))
    + (purged ? note('Szczegóły kampanii zostały usunięte po okresie przechowywania, dlatego widok pokazuje liczby i kliknięcia w kolejnych godzinach') : '')
    + targetsTable(d.targets) + unopenedPanel(d, state.busy === true);
}

/** Uruchomienie widoku kampanii w dokumencie. */
export function startCampaign(win, env) {
  const doc = win.document;
  const root = doc.getElementById('tresc');
  const say = sayIn(doc);
  const s = { input: null, data: null, mode: 'days', busy: false };
  const draw = () => {
    if (s.data) root.innerHTML = renderCampaign(s.data, s);
  };
  const show = (result) => {
    if (result.isError) return say('fail', textOf(result));
    if (!result.structuredContent) {
      root.textContent = textOf(result);
      return undefined;
    }
    s.data = result.structuredContent;
    say('plain', '');
    return draw();
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
    onToolInput: (args) => { s.input = args; },
    onToolResult: show,
    onToolCancelled: (reason) => say('wait', cancelledText(reason)),
  });
  /** Kampania z wyniku i wielkość porcji odbiorców z danych wejściowych narzędzia. */
  const query = () => ({ name: s.data.name, ...(s.input?.limit ? { limit: s.input.limit } : {}) });

  doc.getElementById('odswiez').addEventListener('click', () => run(async () => {
    show(await bridge.callTool('campaign_results', query()));
  }));
  root.addEventListener('click', (event) => {
    const mode = event.target.closest?.('button[data-mode]');
    if (mode && !mode.disabled) {
      s.mode = mode.dataset.mode;
      draw();
      return;
    }
    const button = event.target.closest?.('button[data-act]');
    if (!button || button.disabled) return;
    const act = button.dataset.act;
    if (act === 'more') {
      run(async () => {
        const loaded = (s.input?.offset ?? 0) + s.data.unopened.items.length;
        const result = await bridge.callTool('campaign_results', { ...query(), offset: loaded });
        if (result.isError) return say('fail', textOf(result));
        const next = result.structuredContent;
        s.data = { ...next, unopened: next.unopened && { ...next.unopened, items: [...s.data.unopened.items, ...next.unopened.items] } };
        return say('plain', '');
      });
    } else if (act === 'csv') {
      run(async () => {
        const result = await bridge.callTool('campaign_results', { ...query(), csv: button.dataset.file });
        if (result.isError) return say('fail', textOf(result));
        return openDownload(bridge, say, result.structuredContent.download);
      });
    } else if (act === 'remind') {
      run(async () => {
        const sent = await bridge.sendMessage(REMIND_MESSAGE);
        say(sent ? 'ok' : 'plain', sent ? forwardedText('Prośba o przypomnienie')
          : `Napisz w rozmowie, że chcesz przypomnienia dla odbiorców bez otwarcia kampanii ${s.data.name}`);
      });
    }
  });
}
