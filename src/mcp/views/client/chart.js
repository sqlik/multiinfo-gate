// Wykres słupkowy SVG widoków, tak jak wykres kampanii w panelu: słupki w kolorze z motywu, opis każdego słupka
// w podpowiedzi, wartości nad słupkami przy krótkich seriach i podpisy osi.
import { esc } from './bridge.js';

const AXIS = 20;
const TOP = 16;
/** Najwięcej słupków, przy których wartości mieszczą się nad słupkami. */
const VALUES_MAX = 16;

const fixed = (n) => n.toFixed(1);

/**
 * Wykres z punktów { label, value, title }; pusta etykieta pomija podpis osi. `opts`: `label` opis wykresu dla
 * czytników ekranu, `width` i `height` w jednostkach viewBox, `tone` 'ok' dla słupków w kolorze doręczeń.
 */
export function barChart(points, opts = {}) {
  const w = opts.width ?? 640;
  const h = opts.height ?? 170;
  const max = Math.max(0, ...points.map((p) => p.value));
  const slot = w / Math.max(points.length, 1);
  const bar = Math.max(1, Math.min(slot * 0.64, 48));
  const values = points.length <= VALUES_MAX;
  let out = `<line class="axis" x1="0" x2="${w}" y1="${h - AXIS}" y2="${h - AXIS}"></line>`;
  points.forEach((p, i) => {
    const height = max === 0 ? 0 : ((h - AXIS - TOP) * p.value) / max;
    const center = i * slot + slot / 2;
    const y = h - AXIS - height;
    out += `<rect x="${fixed(center - bar / 2)}" y="${fixed(y)}" width="${fixed(bar)}" height="${fixed(height)}" rx="1.5"><title>${esc(p.title)}</title></rect>`;
    if (values) out += `<text class="val" x="${fixed(center)}" y="${fixed(y - 4)}" text-anchor="middle">${esc(p.value)}</text>`;
    if (p.label) out += `<text x="${fixed(center)}" y="${h - 5}" text-anchor="middle">${esc(p.label)}</text>`;
  });
  return `<svg class="chart${opts.tone === 'ok' ? ' chart-ok' : ''}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(opts.label ?? '')}">${out}</svg>`;
}

/**
 * Pasek udziałów jako SVG: odcinki { tone, value } w kolejności, z szerokością proporcjonalną do wartości. Kolory
 * odcinków nadają klasy `t-<tone>` ze stylów widoku.
 */
export function stackBar(segments) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let x = 0;
  let out = '';
  for (const s of segments) {
    if (total === 0 || s.value <= 0) continue;
    const width = (s.value / total) * 1000;
    out += `<rect class="t-${s.tone}" x="${fixed(x)}" y="0" width="${fixed(width)}" height="18"></rect>`;
    x += width;
  }
  return `<svg class="stack" viewBox="0 0 1000 18" preserveAspectRatio="none" aria-hidden="true">${out}</svg>`;
}
