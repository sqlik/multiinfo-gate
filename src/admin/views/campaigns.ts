import type { CampaignDetail, CampaignTarget } from '../../links/campaigns.ts';
import { targetPattern } from '../../links/utm.ts';
import type { CampaignRow } from '../../store/campaigns.ts';
import { warsawStamp } from '../../time/warsaw.ts';
import { clicksChart } from './chart.ts';
import { esc } from './layout.ts';

export interface CampaignsData {
  rows: CampaignRow[];
  hasMore: boolean;
  offset: number;
  limit: number;
  keyNames: Map<number, string>;
}

export interface CampaignView {
  detail: CampaignDetail;
  mode: 'hourly' | 'daily';
  /** Przełącznik widoku dziennego: kampania trwa dłużej niż 48 godzin od pierwszej wysyłki. */
  canSwitch: boolean;
  /** Tylu wierszy linków i odbiorców pokazuje strona; pełna lista odbiorców jest w CSV. */
  shown: number;
}

/** Liczba z odstępem tysięcy, na przykład 1 240. */
const num = (n: number) => esc(n.toLocaleString('pl-PL', { useGrouping: 'always' }));
const minute = (iso: string) => warsawStamp(iso).slice(0, 16);
/** `14.04 10:02` w tabeli odbiorców, gdzie rok wynika z okresu kampanii. */
const short = (iso: string) => { const s = warsawStamp(iso); return `${s.slice(8, 10)}.${s.slice(5, 7)} ${s.slice(11, 16)}`; };
const percent = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1).replace('.', ',')} %`;

/** Forma liczebnika: 1 rozsyłka, 2 rozsyłki, 5 rozsyłek. */
function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return `${n} ${one}`;
  const tens = n % 100;
  return n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14) ? `${n} ${few}` : `${n} ${many}`;
}

const period = (c: CampaignRow) => {
  const from = minute(c.firstSentAt);
  const to = minute(c.lastSentAt);
  return from === to ? `od ${from}` : `od ${from} do ${to}`;
};

export function campaignsPage(data: CampaignsData): string {
  const rows = data.rows.length === 0
    ? '<tr><td class="dim" colspan="6">Brak kampanii. Kampania powstaje przy pierwszej wysyłce, w której bramka skraca link.</td></tr>'
    : data.rows.map((c) => `<tr>
        <td><a href="/kampanie/${esc(c.id)}">${esc(c.name)}</a></td>
        <td class="dim">${esc(data.keyNames.get(c.apiKeyId) ?? `klucz ${c.apiKeyId}`)}</td>
        <td class="m dim">${esc(period(c))}</td>
        <td class="m r">${num(c.sent)}</td>
        <td class="m r">${num(c.opens)}</td>
        <td class="m r">${num(c.clicks)}</td>
      </tr>`).join('');

  const from = data.rows.length === 0 ? 0 : data.offset + 1;
  const to = data.offset + data.rows.length;
  const pageLink = (offset: number) => (offset > 0 ? `/kampanie?offset=${offset}` : '/kampanie');

  return `<div class="head">
    <div>
      <h1 class="h1">Kampanie</h1>
      <p class="sub">Wyniki krótkich linków według kampanii · ${esc(data.limit)} na stronie</p>
    </div>
  </div>
  <div class="scroll">
    <div class="panel">
      <table>
        <tr>
          <th>Nazwa</th>
          <th style="width: 190px;">Klucz</th>
          <th style="width: 260px;">Okres</th>
          <th class="r" style="width: 90px;">Wysłane</th>
          <th class="r" style="width: 90px;">Otwarcia</th>
          <th class="r" style="width: 90px;">Kliknięcia</th>
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

function tiles(d: CampaignDetail): string {
  const c = d.row;
  const tile = (lab: string, n: string, desc: string, tone = '') =>
    `<div class="tile"><div class="lab">${lab}</div><div class="n${tone}">${n}</div><div class="d">${esc(desc)}</div></div>`;
  const delivered = d.reported
    ? tile('Doręczone', num(d.delivered), c.sent === 0 ? '-' : `${percent(d.delivered, c.sent)} wysłanych`, ' ok')
    : tile('Doręczone', '-', 'brak raportu', ' dim');
  // Bez raportu doręczenia procent otwarć liczy się od wysłanych.
  const base = d.reported ? { whole: d.delivered, of: 'doręczonych' } : { whole: c.sent, of: 'wysłanych' };
  return `<div class="tiles tiles-5">
      ${tile('Wysłane', num(c.sent), 'SMS-y z linkami')}
      ${delivered}
      ${tile('Otwarcia', num(c.opens), base.whole === 0 ? '-' : `${percent(c.opens, base.whole)} ${base.of}`, ' sig')}
      ${tile('Kliknięcia', num(c.clicks), c.opens === 0 ? 'brak otwarć' : `${(c.clicks / c.opens).toFixed(2).replace('.', ',')} na otwarcie`)}
      ${tile('Automaty', num(c.bots), 'odfiltrowane wejścia', ' dim')}
    </div>`;
}

function chartPanel(v: CampaignView): string {
  const d = v.detail;
  const base = `/kampanie/${esc(d.row.id)}`;
  const hourly = v.mode === 'hourly';
  const toggle = hourly
    ? (v.canSwitch ? ` · <a href="${base}?widok=dzien">dziennie</a>` : '')
    : ` · <a href="${base}">co godzinę</a>`;
  const legend = hourly
    ? '<span><i class="lg-bar"></i>kliknięcia</span><span><i class="lg-night"></i>noc 22:00-7:00</span>'
    : '<span><i class="lg-bar"></i>kliknięcia</span>';
  return `<div class="panel">
      <div class="panel-h">
        <div class="lab">${hourly ? 'Kliknięcia w pierwszych 48 godzinach' : 'Kliknięcia dziennie'}</div>
        <div class="m dim">${hourly ? 'co godzinę · ' : ''}czas polski${toggle}</div>
      </div>
      <div class="chart">${clicksChart(d.hours, new Date(d.row.firstSentAt), v.mode)}</div>
      <div class="legend">${legend}</div>
    </div>`;
}

/** Numer wiersza tabeli „Linki” dla adresu docelowego odbiorcy: adres albo jego wzorzec. */
function linkNumbers(targets: readonly CampaignTarget[]): (target: string) => number | undefined {
  const index = new Map(targets.map((t, i) => [t.target, i + 1]));
  return (target) => index.get(target) ?? index.get(targetPattern(target));
}

function linksPanel(d: CampaignDetail, shown: number): string {
  const rows = d.targets.slice(0, shown).map((t, i) => `<tr>
      <td class="m dim">${i + 1}</td>
      <td class="m url">${esc(t.target)}</td>
      <td><span class="tag">${t.kind === 'shared' ? 'wspólny' : 'indywidualny'}</span></td>
      <td class="m r">${num(t.opens)}</td>
      <td class="m r">${num(t.clicks)}</td>
    </tr>`).join('');
  const note = d.targets.length > shown ? `pierwszych ${shown} z ${d.targets.length}` : String(d.targets.length);
  return `<div class="panel">
      <div class="panel-h"><div class="lab">Linki</div><div class="m dim">${esc(note)}</div></div>
      <table>
        <tr><th style="width: 36px;">#</th><th>Adres docelowy</th><th style="width: 110px;">Rodzaj</th>
          <th class="r" style="width: 80px;">Otwarcia</th><th class="r" style="width: 80px;">Kliknięcia</th></tr>
        ${rows || '<tr><td class="dim" colspan="5">Brak linków</td></tr>'}
      </table>
    </div>`;
}

function analyticsPanel(d: CampaignDetail, now: Date): string {
  const utm = d.utm === true
    ? `<div>utm_source</div><div class="m">sms</div>
       <div>utm_medium</div><div class="m">sms</div>
       <div>utm_campaign</div><div class="m">${esc(d.row.name)}</div>`
    : d.utm === false ? '<div>Parametry UTM</div><div>nie są dopisywane</div>' : '';
  let validity = '-';
  if (d.expiresAt !== null) {
    validity = Date.parse(d.expiresAt) <= now.getTime()
      ? `wygasły ${minute(d.expiresAt)}`
      : `do ${minute(d.expiresAt)} · potem strona „Link wygasł”`;
  } else if (d.row.detailsPurgedAt !== null) {
    validity = 'linki wygasły';
  }
  return `<div class="panel">
      <div class="panel-h"><div class="lab">Analityka</div></div>
      <div class="kv">
        ${utm}
        <div>Domena</div><div class="m">${esc(d.domain ?? '-')}</div>
        <div style="border-bottom: none;">Ważność linków</div><div style="border-bottom: none;">${esc(validity)}</div>
      </div>
    </div>`;
}

function openersPanel(d: CampaignDetail, shown: number): string {
  if (d.row.detailsPurgedAt !== null) {
    return `<div class="panel">
      <div class="panel-h"><div class="lab">Odbiorcy, którzy otworzyli link</div></div>
      <div class="form"><div class="dim">Szczegóły odbiorców zostały usunięte zgodnie z retencją. Bramka usuwa numery, krótkie kody
        i adresy docelowe 30 dni po wygaśnięciu linków, a liczby kampanii pozostają bez zmian.</div></div>
    </div>`;
  }
  const numberOf = linkNumbers(d.targets);
  const rows = d.openers.slice(0, shown).map((o) => {
    // Plakietki w kolejności wierszy tabeli „Linki”; pełny adres w podpowiedzi.
    const links = o.targets
      .map((t) => ({ t, n: numberOf(t) }))
      .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity))
      .map(({ t, n }) => `<span class="tag" title="${esc(t)}">${n === undefined ? 'link' : `link ${n}`}</span>`)
      .join(' ');
    return `<tr class="opener">
      <td class="m">${esc(o.dest)}</td>
      <td class="m">${o.clientId === null ? '<span class="dim">-</span>' : esc(o.clientId)}</td>
      <td class="m dim">${esc(short(o.firstOpenedAt))}</td>
      <td class="m dim">${esc(short(o.lastClickedAt))}</td>
      <td class="m r">${num(o.clicks)}</td>
      <td>${links}</td>
    </tr>`;
  }).join('');
  const note = d.row.opens > d.openers.length
    ? `pierwszych ${d.openers.length} z ${d.row.opens} - pełna lista w CSV`
    : String(d.openers.length);
  return `<div class="panel">
      <div class="panel-h"><div class="lab">Odbiorcy, którzy otworzyli link</div><div class="m dim">${esc(note)}</div></div>
      <table>
        <tr><th style="width: 130px;">Numer</th><th style="width: 160px;">Identyfikator klienta</th><th style="width: 140px;">Pierwsze otwarcie</th>
          <th style="width: 140px;">Ostatnie kliknięcie</th><th class="r" style="width: 90px;">Kliknięcia</th><th>Linki</th></tr>
        ${rows || '<tr><td class="dim" colspan="6">Żaden odbiorca nie otworzył jeszcze linku</td></tr>'}
      </table>
    </div>`;
}

function actions(d: CampaignDetail): string {
  const c = d.row;
  if (c.detailsPurgedAt !== null) return '';
  const toggle = c.linksDisabledAt === null
    ? `<form method="post" action="/kampanie/${esc(c.id)}/wylacz"
        data-confirm="Wyłączyć linki kampanii ${esc(c.name)}? Wszystkie krótkie linki tej kampanii, także w wysłanych SMS-ach, będą prowadzić do strony „Link wygasł”." data-confirm-ok="Wyłącz">
        <button class="btn btn-s" type="submit">Wyłącz linki</button>
      </form>`
    : `<form method="post" action="/kampanie/${esc(c.id)}/wlacz">
        <button class="btn btn-s" type="submit">Włącz linki</button>
      </form>`;
  return `<a class="btn btn-s" href="/kampanie/${esc(c.id)}/odbiorcy.csv">Pobierz CSV</a>${toggle}`;
}

export function campaignPage(v: CampaignView, now: Date): string {
  const d = v.detail;
  const c = d.row;
  const sources = [
    d.packages > 0 ? plural(d.packages, 'rozsyłka', 'rozsyłki', 'rozsyłek') : '',
    d.messages > 0 ? plural(d.messages, 'pojedynczy SMS', 'pojedyncze SMS-y', 'pojedynczych SMS-ów') : '',
  ].filter(Boolean).join(' i ');
  const disabled = c.linksDisabledAt === null ? ''
    : `<span class="pill"><span class="dot dot-wait"></span>linki wyłączone ${esc(minute(c.linksDisabledAt))}</span>`;

  return `<div class="head">
    <div>
      <div class="crumb"><a href="/kampanie">Kampanie</a> / szczegóły</div>
      <h1 class="h1">${esc(c.name)}</h1>
      <p class="sub">${esc(period(c))} · klucz „${esc(d.keyName)}”${sources === '' ? '' : ` · ${esc(sources)}`}</p>
    </div>
    <div style="display: flex; align-items: center; gap: 10px;">${disabled}${actions(d)}</div>
  </div>
  <div class="scroll">
    ${tiles(d)}
    ${chartPanel(v)}
    <div class="cols cols-links">
      ${linksPanel(d, v.shown)}
      ${analyticsPanel(d, now)}
    </div>
    ${openersPanel(d, v.shown)}
  </div>`;
}
