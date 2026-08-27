import type { PackageRow, RecipientRow } from '../../store/packages.ts';
import { warsawStamp } from '../../time/warsaw.ts';
import { esc } from './layout.ts';
import {
  packageStatusLabel, packageStatusTone, reportStatusLabel, statusLabel, statusTone,
} from './status-labels.ts';

export interface PackagesData {
  rows: PackageRow[];
  hasMore: boolean;
  offset: number;
  limit: number;
  keyNames: Map<number, string>;
  accountNames: Map<number, string>;
}

export interface PackageDetail {
  row: PackageRow;
  accountName: string;
  keyName: string;
  recipients: RecipientRow[];
  /** Ilu odbiorców pokazujemy; reszta jest w CSV. */
  shown: number;
  summary: { delivered: number; failed: number; other: number } | null;
}

const stamp = (iso: string | null) => (iso === null ? '-' : warsawStamp(iso));

const state = (p: PackageRow) =>
  `<span class="st"><span class="dot dot-${packageStatusTone(p.status)}"></span>${esc(packageStatusLabel(p.status))}</span>`;

function reportCell(p: PackageRow): string {
  if (p.reportStatus === 'ready') return `<a class="m" href="/rozsylki/${esc(p.id)}/raport.csv">CSV</a>`;
  return `<span class="${p.reportStatus === 'failed' ? 'fail' : 'dim'}">${esc(reportStatusLabel(p.reportStatus))}</span>`;
}

export function packagesPage(data: PackagesData): string {
  const rows = data.rows.length === 0
    ? '<tr><td class="dim" colspan="8">Nie było jeszcze żadnej rozsyłki.</td></tr>'
    : data.rows.map((p) => `<tr>
        <td class="m dim">${esc(stamp(p.createdAt))}</td>
        <td class="m"><a href="/rozsylki/${esc(p.id)}">${esc(p.id)}</a></td>
        <td>${esc(data.accountNames.get(p.accountId) ?? `konto ${p.accountId}`)}</td>
        <td class="dim">${esc(data.keyNames.get(p.apiKeyId) ?? `klucz ${p.apiKeyId}`)}</td>
        <td class="m">${esc(p.recipientsCount)}</td>
        <td class="m">${p.remainingCount === null ? '<span class="dim">-</span>' : esc(p.remainingCount)}</td>
        <td>${state(p)}</td>
        <td>${reportCell(p)}</td>
      </tr>`).join('');

  const from = data.rows.length === 0 ? 0 : data.offset + 1;
  const to = data.offset + data.rows.length;
  const pageLink = (offset: number) => (offset > 0 ? `/rozsylki?offset=${offset}` : '/rozsylki');

  return `<div class="head">
    <div>
      <h1 class="h1">Rozsyłki</h1>
      <p class="sub">Wysyłki masowe przez package.aspx · ${esc(data.limit)} na stronie</p>
    </div>
  </div>
  <div class="scroll">
    <div class="panel">
      <table>
        <tr>
          <th style="width: 150px;">Utworzono</th>
          <th style="width: 200px;">Identyfikator</th>
          <th style="width: 140px;">Konto</th>
          <th style="width: 150px;">Klucz</th>
          <th style="width: 90px;">Odbiorców</th>
          <th style="width: 90px;">Pozostało</th>
          <th style="width: 140px;">Status</th>
          <th>Raport</th>
        </tr>
        ${rows}
      </table>
      <div class="foot">
        <div>${esc(from)}-${esc(to)}</div>
        <div style="display: flex; gap: 12px;">
          ${data.offset > 0
            ? `<a href="${pageLink(Math.max(0, data.offset - data.limit))}">Poprzednie</a>`
            : '<span class="dim">Poprzednie</span>'}
          ${data.hasMore
            ? `<a href="${pageLink(data.offset + data.limit)}">Następne</a>`
            : '<span class="dim">Następne</span>'}
        </div>
      </div>
    </div>
  </div>`;
}

function recipientRow(r: RecipientRow): string {
  const status = r.status === null
    ? '<span class="dim">brak raportu</span>'
    : `<span class="st"><span class="dot dot-${statusTone(r.status)}"></span>${esc(statusLabel(r.status))}</span>`;
  // Raport rozsyłki niesie sam status, bez substatusu - nie dopisujemy opisu, którego nie znamy.
  const mi = r.miStatus === null ? '' : esc(r.miStatus);
  return `<tr>
      <td class="m dim">${esc(r.seq)}</td>
      <td class="m">${esc(r.dest)}</td>
      <td class="m">${r.clientId === null ? '<span class="dim">-</span>' : esc(r.clientId)}</td>
      <td class="txt">${r.text === null ? '<span class="dim">domyślna</span>' : esc(r.text)}</td>
      <td class="m">${r.miId === null ? '<span class="dim">-</span>' : esc(r.miId)}</td>
      <td>${status}</td>
      <td class="m dim">${mi}</td>
      <td class="m dim">${esc(r.statusChangedAt ?? '')}</td>
    </tr>`;
}

export function packagePage(d: PackageDetail): string {
  const p = d.row;
  const yes = (v: 0 | 1) => (v === 1 ? 'tak' : 'nie');

  const summary = d.summary === null
    ? `<div class="dim" style="padding: 14px 16px; font-size: 12.5px;">Podsumowanie pojawi się po wczytaniu raportu
        (stan: ${esc(reportStatusLabel(p.reportStatus))}).</div>`
    : `<div class="tiles" style="margin: 0; padding: 12px 16px;">
        <div class="tile"><div class="lab">Doręczone</div><div class="n ok">${esc(d.summary.delivered)}</div></div>
        <div class="tile"><div class="lab">Nieudane</div><div class="n fail">${esc(d.summary.failed)}</div></div>
        <div class="tile"><div class="lab">Pozostałe</div><div class="n">${esc(d.summary.other)}</div></div>
      </div>`;

  const csvButton = p.reportStatus === 'ready'
    ? `<a class="btn btn-p" href="/rozsylki/${esc(p.id)}/raport.csv">Pobierz CSV</a>`
    : `<span class="btn btn-s disabled" title="${esc(reportStatusLabel(p.reportStatus))}">Pobierz CSV</span>`;

  const reportState = p.reportStatus === 'ready'
    ? `gotowy · ${esc(p.recipientsCount)} odbiorców`
      + (p.reportExpiresAt === null ? '' : ` · ważny do ${esc(stamp(p.reportExpiresAt))}`)
    : `<span class="${p.reportStatus === 'failed' ? 'fail' : 'dim'}">${esc(reportStatusLabel(p.reportStatus))}</span>`;

  const note = d.recipients.length < p.recipientsCount
    ? `<div class="m dim">pierwszych ${esc(d.shown)} z ${esc(p.recipientsCount)} - pełna lista w CSV</div>`
    : `<div class="m dim">${esc(p.recipientsCount)}</div>`;

  return `<div class="head">
    <div>
      <div class="crumb"><a href="/rozsylki">Rozsyłki</a> / szczegół</div>
      <h1 class="h1 id">${esc(p.id)}</h1>
      <p class="sub">${esc(stamp(p.createdAt))} · konto ${esc(d.accountName)} · klucz „${esc(d.keyName)}”</p>
    </div>
    <div style="display: flex; align-items: center; gap: 12px;">
      <span class="pill"><span class="dot dot-${packageStatusTone(p.status)}"></span>${esc(packageStatusLabel(p.status))}</span>
      ${csvButton}
    </div>
  </div>
  <div class="scroll">
    <div class="cols">
      <div class="panel">
        <div class="panel-h"><div class="lab">Parametry</div></div>
        <div class="kv">
          <div>ID usługi</div><div class="m">${esc(p.serviceId)}</div>
          <div>Nadpis</div><div class="m">${esc(p.orig ?? '-')}</div>
          <div>Kodowanie</div><div class="m">${esc(p.encoding === 'gsm' ? 'GSM-7' : 'UCS-2')}${p.multipart === 1 ? ' · wieloczęściowa' : ''}</div>
          <div>Raport doręczenia</div><div class="m">${esc(yes(p.deliveryReport))}</div>
          <div>Start</div><div class="m">${p.startAt === null ? 'od razu' : esc(stamp(p.startAt))}</div>
          <div>Centrum kosztów</div><div class="m">${esc(p.costCenter ?? '-')}</div>
          <div>Identyfikator w Multiinfo</div><div class="m">${p.miPackageId === null ? '<span class="dim">jeszcze nie utworzono</span>' : esc(p.miPackageId)}</div>
          <div>Status Multiinfo</div><div class="m">${p.miStatus === null ? '<span class="dim">brak</span>' : esc(p.miStatus)}</div>
          <div>Zakończono</div><div class="m">${esc(stamp(p.completedAt))}</div>
          <div${p.error === null ? ' style="border-bottom: none;"' : ''}>Raport</div>
          <div${p.error === null ? ' style="border-bottom: none;"' : ''}>${reportState}</div>
          ${p.error === null ? '' : `<div style="border-bottom: none;">Błąd</div>
            <div class="m fail" style="border-bottom: none;">${p.providerCode === null ? '' : `${esc(p.providerCode)} - `}${esc(p.error)}</div>`}
        </div>
      </div>
      <div class="panel">
        <div class="panel-h"><div class="lab">Podsumowanie odbiorców</div></div>
        ${summary}
      </div>
    </div>

    <div class="panel">
      <div class="panel-h">
        <div class="lab">Odbiorcy</div>
        ${note}
      </div>
      <table>
        <tr>
          <th style="width: 50px;">#</th>
          <th style="width: 124px;">Numer</th>
          <th style="width: 130px;">Identyfikator klienta</th>
          <th>Treść</th>
          <th style="width: 100px;">Id Multiinfo</th>
          <th style="width: 130px;">Status</th>
          <th style="width: 120px;">Status Multiinfo</th>
          <th style="width: 150px;">Czas</th>
        </tr>
        ${d.recipients.map(recipientRow).join('')}
      </table>
    </div>
  </div>`;
}
