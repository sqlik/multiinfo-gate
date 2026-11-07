// Wykres kliknięć kampanii jako SVG rysowany po stronie serwera, bez skryptu. Godziny w bazie są
// w UTC (`YYYY-MM-DDTHH`), a oś, noc i dni wykres podaje w czasie polskim, także w dniu zmiany czasu.
import { warsawDay, warsawStamp } from '../../time/warsaw.ts';
import { esc } from './layout.ts';

const W = 960;
const H = 150;
const AXIS = 18;
const TOP = 4;
const HOUR_MS = 3_600_000;
const HOURS_SHOWN = 48;
/** Najwyżej tyle dni pokazuje widok dzienny: ważność linków wynosi najwyżej 365 dni. */
const MAX_DAYS = 366;

type Hour = { hour: string; clicks: number };

const isoOfHour = (hour: string) => `${hour}:00:00.000Z`;
/** `14.04` z dnia `RRRR-MM-DD`. */
const dayLabel = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const fixed = (n: number) => n.toFixed(1);

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function frame(label: string, body: string): string {
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">${body}`
    + `<line class="axis" x1="0" x2="${W}" y1="${H - AXIS}" y2="${H - AXIS}"></line></svg>`;
}

function bar(slot: number, x: number, width: number, value: number, max: number, title: string, night: boolean): string {
  const height = max === 0 ? 0 : (value / max) * (H - AXIS - TOP);
  return `<rect class="bar${night ? ' bar-night' : ''}" data-slot="${slot}" x="${fixed(x)}" y="${fixed(H - AXIS - height)}" width="${fixed(width)}"`
    + ` height="${fixed(height)}" rx="1"><title>${esc(title)}</title></rect>`;
}

const label = (x: number, text: string) => `<text x="${fixed(x)}" y="${H - 4}" text-anchor="middle">${esc(text)}</text>`;

/** 48 godzin od godziny pierwszej wysyłki; noc 22:00-7:00 czasu polskiego wyróżniona tłem i kolorem słupka. */
function hourly(hours: readonly Hour[], start: Date): string {
  const first = Math.floor(start.getTime() / HOUR_MS) * HOUR_MS;
  const byHour = new Map(hours.map((h) => [h.hour, h.clicks]));
  const slots = Array.from({ length: HOURS_SHOWN }, (_, i) => {
    const iso = new Date(first + i * HOUR_MS).toISOString();
    const local = warsawStamp(iso);
    const next = warsawStamp(new Date(first + (i + 1) * HOUR_MS).toISOString());
    return { clicks: byHour.get(iso.slice(0, 13)) ?? 0, hour: Number(local.slice(11, 13)), day: local.slice(0, 10), from: local.slice(11, 16), to: next.slice(11, 16) };
  });
  const max = Math.max(0, ...slots.map((s) => s.clicks));
  const width = W / HOURS_SHOWN;
  let out = '';
  slots.forEach((s, i) => {
    const night = s.hour >= 22 || s.hour < 7;
    if (night) out += `<rect class="night" data-slot="${i}" x="${fixed(i * width)}" y="0" width="${fixed(width)}" height="${H - AXIS}"></rect>`;
    out += bar(i, i * width + 2.5, width - 5, s.clicks, max, `${dayLabel(s.day)}, ${s.from}-${s.to}, kliknięcia: ${s.clicks}`, night);
    if (s.hour % 6 === 0) out += label(i * width + width / 2, `${String(s.hour).padStart(2, '0')}:00`);
  });
  return frame('Kliknięcia co godzinę w pierwszych 48 godzinach od pierwszej wysyłki', out);
}

/** Dzień czasu polskiego od dnia pierwszej wysyłki do dnia ostatniego kliknięcia. */
function daily(hours: readonly Hour[], start: Date): string {
  const byDay = new Map<string, number>();
  for (const h of hours) {
    if (h.clicks === 0) continue;
    const day = warsawDay(isoOfHour(h.hour));
    byDay.set(day, (byDay.get(day) ?? 0) + h.clicks);
  }
  const firstDay = warsawDay(start.toISOString());
  const lastDay = [...byDay.keys()].reduce((a, b) => (b > a ? b : a), firstDay);
  let days: string[] = [];
  for (let day = firstDay; day <= lastDay; day = nextDay(day)) days.push(day);
  if (days.length > MAX_DAYS) days = days.slice(-MAX_DAYS);
  const max = Math.max(0, ...days.map((d) => byDay.get(d) ?? 0));
  const width = W / days.length;
  // Przy kilku dniach słupek nie wypełnia całej szerokości dnia.
  const barWidth = Math.min(width - Math.min(5, width * 0.25), 40);
  const every = Math.max(1, Math.ceil(days.length / 8));
  let out = '';
  days.forEach((day, i) => {
    const clicks = byDay.get(day) ?? 0;
    out += bar(i, i * width + (width - barWidth) / 2, barWidth, clicks, max, `${dayLabel(day)}, kliknięcia: ${clicks}`, false);
    if (i % every === 0) out += label(i * width + width / 2, dayLabel(day));
  });
  return frame('Kliknięcia dziennie od pierwszej wysyłki', out);
}

export function clicksChart(hours: Array<{ hour: string; clicks: number }>, start: Date, mode: 'hourly' | 'daily'): string {
  return mode === 'hourly' ? hourly(hours, start) : daily(hours, start);
}
