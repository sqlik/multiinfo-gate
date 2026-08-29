import type { ProtocolTrace } from '../../multiinfo/client.ts';
import { describeSubstatus, mapStatus } from '../../multiinfo/status.ts';
import type { MessageEvent } from '../../store/message-events.ts';
import { deliveriesTable, type DeliveryView } from './deliveries.ts';
import type { MessageRow } from '../../store/messages.ts';
import { measureText } from '../../text/measure.ts';
import { segmentText } from '../../text/segment.ts';
import { warsawStamp, warsawStampMs } from '../../time/warsaw.ts';
import { esc, preview } from './layout.ts';
import { segmentPanel } from './segments.ts';
import { statusLabel, statusTone } from './status-labels.ts';

export interface MessageFilters {
  status: string | null;
  to: string | null;
}

export interface MessagesData {
  rows: MessageRow[];
  filters: MessageFilters;
  hasMore: boolean;
  offset: number;
  limit: number;
  keyNames: Map<number, string>;
  accountNames: Map<number, string>;
}

const FILTRY: Array<{ key: string | null; label: string }> = [
  { key: null, label: 'Wszystkie' },
  { key: 'delivered', label: 'Doręczone' },
  { key: 'transit', label: 'W drodze' },
  { key: 'failed', label: 'Błąd' },
  { key: 'blocked', label: 'Zablokowane' },
  { key: 'cancelled', label: 'Anulowane' },
];

const stamp = (iso: string | null) => (iso === null ? '-' : warsawStamp(iso));

/** Treść na liście skracamy do jednego wiersza; pełną widać w szczególe. */
const state = (m: MessageRow) =>
  `<span class="st"><span class="dot dot-${statusTone(m.status)}"></span>${esc(statusLabel(m.status))}</span>`;

/** Buduje adres listy z zachowaniem pozostałych filtrów. */
function link(filters: MessageFilters, patch: Partial<MessageFilters & { offset: number }>): string {
  const params = new URLSearchParams();
  const status = patch.status === undefined ? filters.status : patch.status;
  const to = patch.to === undefined ? filters.to : patch.to;
  if (status !== null && status !== '') params.set('status', status);
  if (to !== null && to !== '') params.set('to', to);
  if (patch.offset !== undefined && patch.offset > 0) params.set('offset', String(patch.offset));
  const query = params.toString();
  return query === '' ? '/wiadomosci' : `/wiadomosci?${query}`;
}

export function messagesPage(data: MessagesData): string {
  const tabs = FILTRY.map((f) => {
    const on = (f.key ?? '') === (data.filters.status ?? '');
    return `<a href="${link(data.filters, { status: f.key, offset: 0 })}"${on ? ' class="on"' : ''}>${esc(f.label)}</a>`;
  }).join('');

  const rows = data.rows.length === 0
    ? '<tr><td class="dim" colspan="7">Brak wiadomości pasujących do filtrów.</td></tr>'
    : data.rows.map((m) => `<tr>
        <td class="m dim nw">${esc(warsawStamp(m.createdAt))}</td>
        <td class="m"><a href="/wiadomosci/${esc(m.id)}">${esc(m.id)}</a></td>
        <td class="m">${esc(m.dest)}</td>
        <td class="txt">${preview(m.body)}</td>
        <td><span class="enc">${esc(m.encoding === 'gsm' ? 'GSM-7' : 'UCS-2')}</span></td>
        <td class="m">${esc(m.parts)}</td>
        <td>${state(m)}</td>
      </tr>`).join('');

  const from = data.rows.length === 0 ? 0 : data.offset + 1;
  const to = data.offset + data.rows.length;

  return `<div class="head">
    <div>
      <h1 class="h1">Wiadomości</h1>
      <p class="sub">${esc(data.limit)} na stronie</p>
    </div>
  </div>
  <div class="scroll">
    <div class="bar">
      <div class="seg">${tabs}</div>
      <form method="get" action="/wiadomosci" class="bar" style="gap: 8px;">
        ${data.filters.status === null ? '' : `<input type="hidden" name="status" value="${esc(data.filters.status)}">`}
        <input class="inp" style="width: 160px;" name="to" placeholder="numer odbiorcy"
               value="${esc(data.filters.to ?? '')}">
        <button class="btn btn-s" type="submit">Filtruj</button>
      </form>
    </div>

    <div class="panel">
      <table style="table-layout: fixed;">
        <tr>
          <th class="nw" style="width: 134px;">Czas</th>
          <th style="width: 168px;">Identyfikator</th>
          <th style="width: 82px;">Numer</th>
          <th>Treść</th>
          <th style="width: 62px;">Kodowanie</th>
          <th style="width: 44px;">Części</th>
          <th class="nw" style="width: 96px;">Status</th>
        </tr>
        ${rows}
      </table>
      <div class="foot">
        <div>${esc(from)}-${esc(to)}</div>
        <div style="display: flex; gap: 12px;">
          ${data.offset > 0
            ? `<a href="${link(data.filters, { offset: Math.max(0, data.offset - data.limit) })}">Poprzednie</a>`
            : '<span class="dim">Poprzednie</span>'}
          ${data.hasMore
            ? `<a href="${link(data.filters, { offset: data.offset + data.limit })}">Następne</a>`
            : '<span class="dim">Następne</span>'}
        </div>
      </div>
    </div>
  </div>`;
}

export interface MessageDetail {
  row: MessageRow;
  accountName: string;
  keyName: string;
  storeContent: boolean;
  /** Host Multiinfo konta - ślad protokołu nie zapisuje adresu. */
  host: string;
  events: MessageEvent[];
  /** Dostawy webhooków o tej wiadomości; pusta lista, gdy klucz nie ma adresu webhooka. */
  deliveries: DeliveryView[];
}

type Tone = 'ok' | 'wait' | 'fail' | 'dim';

interface Step { at: string; tone: Tone; text: string }

/** Kropka i opis zdarzenia z przebiegu. Rodzaje zapisuje API, worker i anulowanie. */
function stepOf(e: MessageEvent): Step {
  const detail = e.detail === null ? '' : esc(e.detail);
  switch (e.kind) {
    case 'queued': return { at: e.at, tone: 'dim', text: 'Przyjęta przez bramkę, zapisana w kolejce' };
    case 'sent': return { at: e.at, tone: 'dim', text: `Przekazana do Multiinfo - ${detail}` };
    case 'retry': return { at: e.at, tone: 'dim', text: `Ponowienie: ${detail}` };
    case 'paused': return { at: e.at, tone: 'dim', text: `Konto wstrzymane: ${detail}` };
    case 'status': {
      const codes = /status (\d+) \/ (\d+)/.exec(e.detail ?? '');
      const tone: Tone = codes ? statusTone(mapStatus(Number(codes[1]), Number(codes[2]))) : 'wait';
      return { at: e.at, tone, text: `Multiinfo: ${detail}` };
    }
    case 'failed': return { at: e.at, tone: 'fail', text: `Niepowodzenie: ${detail}` };
    case 'expired': return { at: e.at, tone: 'fail', text: `Przedawniona: ${detail}` };
    case 'cancelled': return { at: e.at, tone: 'fail', text: `Anulowana - ${detail}` };
    case 'cancel_partial': return { at: e.at, tone: 'fail', text: `Anulowanie częściowe: ${detail}` };
    case 'cancel_failed': return { at: e.at, tone: 'fail', text: `Anulowanie nieskuteczne: ${detail}` };
    case 'abandoned': return { at: e.at, tone: 'fail', text: `Odpytywanie przerwane: ${detail}` };
    case 'webhook': return { at: e.at, tone: 'ok', text: `Webhook <span class="m">${detail}</span> zakolejkowany` };
    default: return { at: e.at, tone: 'dim', text: `${esc(e.kind)}${detail === '' ? '' : `: ${detail}`}` };
  }
}

/** Wiadomości sprzed migracji nie mają zdarzeń - pokazujemy trzy daty, jak dotąd. */
function legacySteps(m: MessageRow, substatus: { opis: string } | null): Step[] {
  return [
    { at: m.createdAt, tone: 'dim', text: 'Przyjęta przez bramkę, zapisana w kolejce' },
    ...(m.sentAt === null ? [] : [{
      at: m.sentAt, tone: 'dim' as Tone,
      text: `Przekazana do Multiinfo - identyfikatory ${m.miIds.map((x) => `<span class="m">${esc(x)}</span>`).join(', ')}`,
    }]),
    ...(m.finalAt === null ? [] : [{
      at: m.finalAt, tone: statusTone(m.status),
      text: `Stan ostateczny: ${esc(statusLabel(m.status))}${substatus === null ? '' : ` (${esc(substatus.opis)})`}`,
    }]),
  ];
}

/** Parametr `text` w śladzie jest zakodowany jak w formularzu i łamany co 60 znaków, jak w makiecie. */
const TRACE_WRAP = 60;

function traceParam(key: string, value: string): string {
  if (key !== 'text') return `   ${esc(key)}=${esc(value)}`;
  const encoded = encodeURIComponent(value).replace(/%20/g, '+');
  const chunks = encoded.match(new RegExp(`.{1,${TRACE_WRAP}}`, 'g')) ?? [''];
  return `   text=${chunks.map(esc).join('\n        ')}`;
}

function tracePanel(trace: ProtocolTrace | null, host: string): string {
  if (trace === null) {
    return `<div class="panel">
      <div class="panel-h"><div class="lab">Ślad protokołu</div></div>
      <div class="dim" style="padding: 14px 16px; font-size: 12.5px;">Ślad pojawi się po przekazaniu do Multiinfo.</div>
    </div>`;
  }
  const params = Object.entries(trace.params).map(([k, v]) => traceParam(k, v)).join('\n');
  const lines = ['0', ...trace.lines]
    .map((l, i) => `<span class="ln">${String(i + 1).padStart(4, ' ')}</span>  ${esc(l)}`).join('\n');
  return `<div class="panel">
    <div class="panel-h">
      <div class="lab">Ślad protokołu</div>
      <div class="m dim">${esc(warsawStamp(trace.at))} · ${esc(trace.durationMs)} ms</div>
    </div>
    <div class="trace"><span class="ar">→</span> POST ${esc(host)}/${esc(trace.script)}
${params}

<span class="ar">←</span> ${esc(trace.httpStatus)} · ${esc(trace.durationMs)} ms
${lines}</div>
  </div>`;
}

/** Podgląd segmentów liczony na nowo z treści; przy braku treści - informacja, czemu jej nie ma. */
function contentPanel(m: MessageRow, storeContent: boolean, accountName: string): string {
  if (m.body === null) {
    const brak = storeContent
      ? 'Treść usunięta po przetworzeniu.'
      : `Treść usunięta po przetworzeniu - konto ${esc(accountName)} ma wyłączone przechowywanie treści.`;
    return `<div class="panel">
      <div class="panel-h">
        <div class="lab">Treść</div>
        <div class="m dim">${esc(m.slots)} miejsc · ${esc(m.parts)} ${m.parts === 1 ? 'część' : 'części'}
          · ${esc(m.encoding === 'gsm' ? 'GSM-7' : 'UCS-2')}</div>
      </div>
      <div class="ruler dim" style="font-size: 13px; line-height: 1.7;">${brak}</div>
    </div>`;
  }
  const measurement = measureText(m.body, m.encoding === 'ucs2' ? 'unicode' : 'gsm');
  try {
    return segmentPanel(m.body, measurement, segmentText(m.body, measurement, 9));
  } catch {
    return `<div class="panel"><div class="panel-h"><div class="lab">Treść</div></div>
      <div class="ruler">${esc(m.body)}</div></div>`;
  }
}

export function messagePage(d: MessageDetail): string {
  const m = d.row;
  const substatus = m.miStatus === null
    ? null
    : { code: `${m.miStatus} / ${m.miSubstatus ?? 0}`, opis: describeSubstatus(m.miStatus, m.miSubstatus ?? 0) };

  const parts = m.miIds.length === 0
    ? '<span class="dim">jeszcze nie przekazano do Multiinfo</span>'
    : m.miIds.map((id) => `<span class="tag">${esc(id)}</span>`).join(' ');

  const steps = d.events.length > 0 ? d.events.map(stepOf) : legacySteps(m, substatus);
  const timeline = steps.map((step, index, all) => `<div class="tl-i">
      <div class="t">${esc(warsawStampMs(step.at))}</div>
      <div class="r"><span class="dot-${step.tone}"></span>${index === all.length - 1 ? '' : '<i></i>'}</div>
      <div class="c">${step.text}</div>
    </div>`).join('');

  return `<div class="head">
    <div>
      <div class="crumb"><a href="/wiadomosci">Wiadomości</a> / szczegół</div>
      <h1 class="h1 id">${esc(m.id)}</h1>
      <p class="sub">${esc(stamp(m.createdAt))} · konto ${esc(d.accountName)} · klucz „${esc(d.keyName)}”</p>
    </div>
    <div>
      <span class="pill"><span class="dot dot-${statusTone(m.status)}"></span>${esc(statusLabel(m.status))}</span>
    </div>
  </div>
  <div class="scroll">
    ${contentPanel(m, d.storeContent, d.accountName)}

    <div class="cols">
      <div class="panel">
        <div class="panel-h"><div class="lab">Dane wiadomości</div></div>
        <div class="kv">
          <div>Odbiorca</div><div class="m">${esc(m.dest)}</div>
          <div>Nadpis</div><div class="m">${esc(m.orig ?? '-')}</div>
          <div>ID usługi</div><div class="m">${esc(m.serviceId)}</div>
          ${m.inReplyTo === null ? '' : `<div>Odpowiedź na</div><div class="m"><a href="/odebrane/${esc(m.inReplyTo)}">${esc(m.inReplyTo)}</a></div>`}
          <div>Części w Multiinfo</div><div>${parts}</div>
          <div>Status Multiinfo</div><div class="m">${substatus === null
            ? '<span class="dim">brak</span>'
            : `${esc(substatus.code)} - ${esc(substatus.opis)}`}</div>
          <div${m.error === null ? ' style="border-bottom: none;"' : ''}>Ważność</div>
          <div class="m"${m.error === null ? ' style="border-bottom: none;"' : ''}>${esc(m.validTo ?? '-')}</div>
          ${m.error === null ? '' : `<div style="border-bottom: none;">Błąd</div>
            <div class="m fail" style="border-bottom: none;">${esc(m.error)}</div>`}
        </div>
      </div>
      <div class="panel">
        <div class="panel-h"><div class="lab">Przebieg</div></div>
        <div class="tl">${timeline}</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-h"><div class="lab">Dostawy do aplikacji</div></div>
      ${deliveriesTable(d.deliveries, 'Klucz nie ma adresu webhooka - aplikacja odczytuje stan przez GET /v1/messages/{id}.', true)}
    </div>

    ${tracePanel(m.trace, d.host)}
  </div>`;
}
