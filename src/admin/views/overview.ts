import type { AccountRow } from '../../store/accounts.ts';
import type { MessageRow } from '../../store/messages.ts';
import { describeSubstatus } from '../../multiinfo/status.ts';
import { warsawDay, warsawStamp } from '../../time/warsaw.ts';
import { daysUntil } from './accounts.ts';
import { esc } from './layout.ts';

export interface OverviewData {
  counts: { total: number; delivered: number; failed: number; cancelled: number; transit: number };
  queueDepth: number;
  accounts: Array<{ row: AccountRow; serviceIds: string[] }>;
  failures: MessageRow[];
  keyNames: Map<number, string>;
  webhooks: { pending: number; failed: number };
  /** Odebrane od abonentów w oknie przeglądu. */
  inboundToday: number;
}

/** „1 webhook nie dotarł”, „3 webhooki nie dotarły”, „5 webhooków nie dotarło”. */
export function undeliveredWebhooks(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (n === 1) return '1 webhook nie dotarł';
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return `${n} webhooki nie dotarły`;
  return `${n} webhooków nie dotarło`;
}

/** Od tylu dni do wygaśnięcia certyfikat trafia na pasek ostrzeżeń. */
const CERT_WARNING_DAYS = 30;

/** Lista niepowodzeń nie jest ograniczona do doby - sama godzina bez daty myliłaby. */
const time = (iso: string | null) => (iso === null ? '' : warsawStamp(iso));

function host(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Udział doręczeń liczony bez dzielenia przez zero, w formacie z przecinkiem. */
function share(part: number, whole: number): string {
  if (whole === 0) return 'brak ruchu';
  return `${((part / whole) * 100).toFixed(1).replace('.', ',')} % wychodzących`;
}

function alerts(data: OverviewData, now: Date): string {
  const items: string[] = [];

  if (data.webhooks.failed > 0) {
    items.push(`<div class="alert stop">
      <div style="display: flex; align-items: center; gap: 10px;">
        <div class="sq"></div>
        <div>${esc(undeliveredWebhooks(data.webhooks.failed))} do odbiorcy mimo ponowień w ostatniej dobie.
          Aplikacja kliencka nie wie o tych zdarzeniach - sprawdź adres webhooka przy kluczu.</div>
      </div>
      <a href="/klucze">Zobacz klucze</a>
    </div>`);
  }

  for (const { row } of data.accounts) {
    if (row.pausedReason !== null) {
      items.push(`<div class="alert stop">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div class="sq"></div>
          <div>Konto <strong>${esc(row.name)}</strong> jest wstrzymane: ${esc(row.pausedReason)}.
            Wiadomości czekają w kolejce i pójdą po usunięciu przyczyny.</div>
        </div>
        <a href="/konta/${esc(row.id)}">Otwórz konto</a>
      </div>`);
      continue;
    }

    const days = daysUntil(row.certNotAfter, now);
    if (days > CERT_WARNING_DAYS) continue;
    items.push(`<div class="alert">
      <div style="display: flex; align-items: center; gap: 10px;">
        <div class="sq"></div>
        <div>${days <= 0
          ? `Certyfikat konta <strong>${esc(row.name)}</strong> wygasł ${esc(warsawDay(row.certNotAfter))}. `
            + 'Wysyłka z tego konta zwraca błąd -82.'
          : `Certyfikat konta <strong>${esc(row.name)}</strong> wygasa za ${esc(days)} dni `
            + `(${esc(warsawDay(row.certNotAfter))}). Po tej dacie wysyłka z tego konta zwróci błąd -82.`}</div>
      </div>
      <a href="/konta/${esc(row.id)}">Wgraj nowy certyfikat</a>
    </div>`);
  }

  return items.join('');
}

function accountRow(entry: { row: AccountRow; serviceIds: string[] }, now: Date): string {
  const { row } = entry;
  const days = daysUntil(row.certNotAfter, now);
  const state = row.pausedReason !== null
    ? { tone: 'fail', label: 'wstrzymane' }
    : days <= 0 ? { tone: 'fail', label: 'certyfikat wygasł' }
    : days <= CERT_WARNING_DAYS ? { tone: 'wait', label: 'wygasa' }
    : { tone: 'ok', label: 'czynne' };

  return `<tr>
      <td><strong>${esc(row.name)}</strong></td>
      <td class="m dim">${esc(host(row.baseUrl))}</td>
      <td class="m">${esc(entry.serviceIds.join(', '))}</td>
      <td class="m">${esc(row.defaultOrig ?? '-')}</td>
      <td class="m">${esc(warsawDay(row.certNotAfter))}
        <span class="${days <= CERT_WARNING_DAYS ? 'wait' : 'dim'}">/ ${esc(days)} dni</span></td>
      <td><span class="st"><span class="dot dot-${state.tone}"></span>${esc(state.label)}</span></td>
    </tr>`;
}

function failureRow(m: MessageRow, keyNames: Map<number, string>): string {
  const code = m.miStatus === null
    ? esc(m.providerCode ?? '')
    : `${esc(m.miStatus)} / ${esc(m.miSubstatus ?? 0)}`;
  const opis = m.miStatus === null
    ? (m.error ?? '')
    : describeSubstatus(m.miStatus, m.miSubstatus ?? 0);

  return `<tr>
      <td class="m dim">${esc(time(m.finalAt ?? m.createdAt))}</td>
      <td class="m">${esc(m.dest)}</td>
      <td class="m fail">${code}</td>
      <td class="m">${esc(opis)}</td>
      <td class="m dim">${esc(keyNames.get(m.apiKeyId) ?? '')}</td>
    </tr>`;
}

export function overviewPage(data: OverviewData, now: Date): string {
  const failures = data.failures.length === 0
    ? '<tr><td class="dim" colspan="5">Brak niepowodzeń w ostatnich godzinach.</td></tr>'
    : data.failures.map((m) => failureRow(m, data.keyNames)).join('');

  return `<div class="head">
    <div>
      <h1 class="h1">Przegląd</h1>
      <p class="sub">Ostatnie 24 godziny, wszystkie konta</p>
    </div>
  </div>
  <div class="scroll">
    ${alerts(data, now)}
    <div class="tiles tiles-6">
      <a class="tile" href="/wiadomosci">
        <div class="lab">Wychodzące</div>
        <div class="n">${esc(data.counts.total)}</div>
        <div class="d">wiadomości zleconych do wysyłki przez aplikacje</div>
      </a>
      <a class="tile" href="/wiadomosci?status=delivered">
        <div class="lab">Doręczone</div>
        <div class="n ok">${esc(data.counts.delivered)}</div>
        <div class="d">${esc(share(data.counts.delivered, data.counts.total))}</div>
      </a>
      <a class="tile" href="/wiadomosci?status=failed">
        <div class="lab">Niedoręczone</div>
        <div class="n fail">${esc(data.counts.failed)}</div>
        <div class="d">${esc(share(data.counts.failed, data.counts.total))}</div>
      </a>
      <a class="tile" href="/wiadomosci?status=cancelled">
        <div class="lab">Anulowane</div>
        <div class="n">${esc(data.counts.cancelled)}</div>
        <div class="d">${esc(share(data.counts.cancelled, data.counts.total))}</div>
      </a>
      <a class="tile" href="/wiadomosci?status=transit">
        <div class="lab">W drodze</div>
        <div class="n">${esc(data.counts.transit)}</div>
        <div class="d">${esc(share(data.counts.transit, data.counts.total))}<br>${esc(data.queueDepth)} zadań czeka w kolejce workera</div>
      </a>
      <a class="tile" href="/odebrane">
        <div class="lab">Odebrane</div>
        <div class="n">${esc(data.inboundToday)}</div>
        <div class="d">SMS-ów od abonentów</div>
      </a>
    </div>

    <div class="panel">
      <div class="panel-h">
        <div class="lab">Połączenia z Multiinfo</div>
        <a href="/konta">Zarządzaj kontami</a>
      </div>
      <table>
        <tr>
          <th style="width: 170px;">Konto</th>
          <th style="width: 230px;">Adres bazowy</th>
          <th style="width: 110px;">ID usług</th>
          <th style="width: 130px;">Nadpis</th>
          <th style="width: 220px;">Certyfikat ważny do</th>
          <th>Stan</th>
        </tr>
        ${data.accounts.map((entry) => accountRow(entry, now)).join('')}
      </table>
    </div>

    <div class="panel">
      <div class="panel-h">
        <div class="lab">Ostatnie niepowodzenia</div>
        <a href="/wiadomosci?status=failed">Wszystkie błędy</a>
      </div>
      <table>
        <tr>
          <th class="nw" style="width: 150px;">Czas</th>
          <th style="width: 150px;">Numer</th>
          <th style="width: 90px;">Kod</th>
          <th>Odpowiedź Multiinfo</th>
          <th style="width: 170px;">Klucz</th>
        </tr>
        ${failures}
      </table>
    </div>
  </div>`;
}
