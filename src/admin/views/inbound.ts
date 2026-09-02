import type { InboundRow } from '../../store/inbound-messages.ts';
import type { MessageRow } from '../../store/messages.ts';
import { deliveriesTable, type DeliveryView } from './deliveries.ts';
import { warsawStamp } from '../../time/warsaw.ts';
import { esc, preview } from './layout.ts';
import { statusLabel, statusTone } from './status-labels.ts';

export interface InboundFilters { konto: number | null; usluga: string | null; od: string | null; dzienOd: string | null; dzienDo: string | null }

export interface InboundListData {
  rows: InboundRow[]; filters: InboundFilters; hasMore: boolean; offset: number; limit: number;
  accounts: Array<{ id: number; name: string }>;
}

function link(f: InboundFilters, offset: number): string {
  const p = new URLSearchParams();
  if (f.konto !== null) p.set('konto', String(f.konto));
  if (f.usluga !== null) p.set('usluga', f.usluga);
  if (f.od !== null) p.set('od', f.od);
  if (f.dzienOd !== null) p.set('dzienOd', f.dzienOd);
  if (f.dzienDo !== null) p.set('dzienDo', f.dzienDo);
  if (offset > 0) p.set('offset', String(offset));
  const q = p.toString();
  return q === '' ? '/odebrane' : `/odebrane?${q}`;
}

export function inboundPage(d: InboundListData): string {
  const names = new Map(d.accounts.map((a) => [a.id, a.name]));
  const accountOptions = ['<option value="">wszystkie konta</option>', ...d.accounts.map((a) =>
    `<option value="${esc(a.id)}"${d.filters.konto === a.id ? ' selected' : ''}>${esc(a.name)}</option>`)].join('');
  const rows = d.rows.length === 0
    ? '<tr><td class="dim" colspan="6">Brak wiadomości pasujących do filtrów.</td></tr>'
    : d.rows.map((r) => `<tr>
        <td class="m dim nw">${esc(warsawStamp(r.receivedAt))}</td>
        <td class="m"><a href="/odebrane/${esc(r.id)}">${esc(r.id)}</a></td>
        <td class="m">${esc(r.sender)}</td>
        <td class="m nw">${esc(names.get(r.accountId) ?? `konto ${r.accountId}`)} · ${esc(r.serviceId)}</td>
        <td class="txt">${preview(r.body === null ? null : r.kind === 'binary' ? `[binarna] ${r.body}` : r.body)}</td>
        <td class="m">${r.relatedMessageId === null ? '<span class="dim">-</span>' : `<a href="/wiadomosci/${esc(r.relatedMessageId)}">${esc(r.relatedMessageId)}</a>`}</td>
      </tr>`).join('');
  const from = d.rows.length === 0 ? 0 : d.offset + 1;
  const to = d.offset + d.rows.length;
  return `<div class="head">
    <div>
      <h1 class="h1">Odebrane</h1>
      <p class="sub">SMS-y od abonentów na numery usług · ${esc(d.limit)} na stronie</p>
    </div>
  </div>
  <div class="scroll">
    <form method="get" action="/odebrane" class="bar" style="gap: 8px; margin-bottom: 12px;">
      <select class="inp" name="konto">${accountOptions}</select>
      <input class="inp" style="width: 110px;" name="usluga" placeholder="ID usługi" value="${esc(d.filters.usluga ?? '')}">
      <input class="inp" style="width: 160px;" name="od" placeholder="numer nadawcy" value="${esc(d.filters.od ?? '')}">
      <input class="inp" type="date" name="dzienOd" value="${esc(d.filters.dzienOd ?? '')}">
      <input class="inp" type="date" name="dzienDo" value="${esc(d.filters.dzienDo ?? '')}">
      <button class="btn btn-s" type="submit">Filtruj</button>
    </form>
    <div class="panel">
      <table style="table-layout: fixed;">
        <tr>
          <th class="nw" style="width: 134px;">Odebrana</th>
          <th style="width: 168px;">Identyfikator</th>
          <th style="width: 82px;">Nadawca</th>
          <th class="nw" style="width: 98px;">Konto · usługa</th>
          <th>Treść</th>
          <th class="nw" style="width: 200px;">Ostatnia wysłana do nadawcy</th>
        </tr>
        ${rows}
      </table>
      <div class="foot">
        <div>${esc(from)}-${esc(to)}</div>
        <div style="display: flex; gap: 12px;">
          ${d.offset > 0 ? `<a href="${link(d.filters, Math.max(0, d.offset - d.limit))}">Poprzednie</a>` : '<span class="dim">Poprzednie</span>'}
          ${d.hasMore ? `<a href="${link(d.filters, d.offset + d.limit)}">Następne</a>` : '<span class="dim">Następne</span>'}
        </div>
      </div>
    </div>
  </div>`;
}

export interface InboundDetail {
  row: InboundRow; accountName: string;
  deliveries: DeliveryView[];
  related: MessageRow | null; replies: MessageRow[];
  /** Zgłoszenie w obcej aplikacji założone z tej wiadomości przez integrację wychodzącą. */
  ticket?: { ref: string; integration: { id: number; name: string } } | null;
}

export function inboundDetailPage(d: InboundDetail): string {
  const r = d.row;
  const content = r.body === null
    ? `<div class="ruler dim" style="font-size: 13px; line-height: 1.7;">Treść nieprzechowywana - konto ${esc(d.accountName)} ma wyłączone przechowywanie treści.</div>`
    : `<div class="ruler"${r.kind === 'binary' ? ' style="font-family: monospace;"' : ''}>${esc(r.body)}</div>`;
  const replies = d.replies.length === 0
    ? '<span class="dim">brak</span>'
    : d.replies.map((m) => `<a href="/wiadomosci/${esc(m.id)}">${esc(m.id)}</a> <span class="st"><span class="dot dot-${statusTone(m.status)}"></span>${esc(statusLabel(m.status))}</span>`).join('<br>');
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/odebrane">Odebrane</a> / szczegół</div>
      <h1 class="h1 id">${esc(r.id)}</h1>
      <p class="sub">odebrana ${esc(warsawStamp(r.receivedAt))} · konto ${esc(d.accountName)} · usługa ${esc(r.serviceId)}</p>
    </div>
  </div>
  <div class="scroll">
    <div class="panel">
      <div class="panel-h"><div class="lab">Treść</div><div class="m dim">${r.kind === 'binary' ? 'wiadomość binarna (hex)' : 'wiadomość tekstowa'}</div></div>
      ${content}
    </div>
    <div class="cols">
      <div class="panel">
        <div class="panel-h"><div class="lab">Dane wiadomości</div></div>
        <div class="kv">
          <div>Nadawca</div><div class="m">${esc(r.sender)}</div>
          <div>Numer usługi</div><div class="m">${esc(r.dest)}</div>
          <div>ID usługi</div><div class="m">${esc(r.serviceId)}</div>
          <div>ID w Multiinfo</div><div class="m">${esc(r.miId)}</div>
          <div>Protokół / kodowanie</div><div class="m">${esc(r.protocolId)} / ${esc(r.codingScheme)}</div>
          <div>Konektor</div><div class="m">${esc(r.connectorId ?? '-')}</div>
          <div>Zapisana</div><div class="m">${esc(warsawStamp(r.createdAt))}</div>
          ${!d.ticket ? '' : `<div>Zgłoszenie</div><div class="m">${esc(d.ticket.ref)} (<a href="/integracje/${esc(d.ticket.integration.id)}">${esc(d.ticket.integration.name)}</a>)</div>`}
          <div>Ostatnia wysłana do nadawcy</div><div class="m">${d.related === null ? '<span class="dim">brak w ciągu 48 godzin</span>' : `<a href="/wiadomosci/${esc(d.related.id)}">${esc(d.related.id)}</a> · ${esc(warsawStamp(d.related.createdAt))}`}</div>
          <div style="border-bottom: none;">Odpowiedzi wysłane</div><div style="border-bottom: none;">${replies}</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-h"><div class="lab">Dostawy do aplikacji</div></div>
        ${deliveriesTable(d.deliveries, 'Żaden klucz nie subskrybował tej usługi w chwili odbioru.')}
      </div>
    </div>
  </div>`;
}
