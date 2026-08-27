import type { AuditEntry } from '../../store/audit.ts';
import { warsawStamp } from '../../time/warsaw.ts';
import { esc } from './layout.ts';

export interface AuditData {
  rows: Array<AuditEntry & { at: string }>;
  offset: number;
  limit: number;
  hasMore: boolean;
}

const stamp = (iso: string) => warsawStamp(iso);

/**
 * Szczegóły zdarzenia pokazujemy jako pary klucz-wartość, a nie surowy JSON:
 * wpis ma być czytelny dla osoby, która sprawdza, kto i co zmienił.
 */
function details(meta: Record<string, unknown> | undefined): string {
  if (!meta) return '<span class="dim">-</span>';
  return Object.entries(meta)
    .map(([key, value]) => {
      const shown = Array.isArray(value) ? value.join(', ') : value === null ? '-' : String(value);
      return `<span class="dim">${esc(key)}</span> <span class="m">${esc(shown)}</span>`;
    })
    .join('<br>');
}

export function auditPage(data: AuditData): string {
  const rows = data.rows.length === 0
    ? '<tr><td class="dim" colspan="5">Dziennik jest pusty.</td></tr>'
    : data.rows.map((e) => `<tr>
        <td class="m dim">${esc(stamp(e.at))}</td>
        <td class="m">${esc(e.actor)}</td>
        <td class="m">${esc(e.action)}</td>
        <td class="m">${e.target === undefined ? '<span class="dim">-</span>' : esc(e.target)}</td>
        <td class="txt">${details(e.meta)}</td>
        <td class="m dim">${e.ip === undefined ? '-' : esc(e.ip)}</td>
      </tr>`).join('');

  const from = data.rows.length === 0 ? 0 : data.offset + 1;
  const to = data.offset + data.rows.length;
  const link = (offset: number) => (offset > 0 ? `/dziennik?offset=${offset}` : '/dziennik');

  return `<div class="head">
    <div>
      <h1 class="h1">Dziennik zdarzeń</h1>
      <p class="sub">Kto, co i kiedy zmienił w panelu. Czas polski. Wpisów nie da się edytować ani usunąć.</p>
    </div>
  </div>
  <div class="scroll">
    <div class="panel">
      <table>
        <tr>
          <th style="width: 150px;">Czas</th>
          <th style="width: 130px;">Kto</th>
          <th style="width: 170px;">Zdarzenie</th>
          <th style="width: 110px;">Cel</th>
          <th>Szczegóły</th>
          <th style="width: 120px;">Adres</th>
        </tr>
        ${rows}
      </table>
      <div class="foot">
        <div>${esc(from)}-${esc(to)}</div>
        <div style="display: flex; gap: 12px;">
          ${data.offset > 0
            ? `<a href="${link(Math.max(0, data.offset - data.limit))}">Nowsze</a>`
            : '<span class="dim">Nowsze</span>'}
          ${data.hasMore
            ? `<a href="${link(data.offset + data.limit)}">Starsze</a>`
            : '<span class="dim">Starsze</span>'}
        </div>
      </div>
    </div>
  </div>`;
}
