import { LINKS_DOCS_URL, problemUrl } from '../../docs-links.ts';
import { parseCheckDetail, type DomainCheckStep } from '../../links/domains.ts';
import type { LinkDomainRow } from '../../store/link-domains.ts';
import { warsawStamp } from '../../time/warsaw.ts';
import { esc } from './layout.ts';

export interface LinkDomainView { row: LinkDomainRow; keys: number }

export interface LinkDomainFormValues { domain: string; displayName: string; homeUrl: string; bareLinks: boolean }

type Tone = 'ok' | 'fail' | 'wait' | 'dim';

const pill = (tone: Tone, label: string) => `<span class="pill"><span class="dot dot-${tone}"></span>${esc(label)}</span>`;

const minute = (iso: string) => warsawStamp(iso).slice(0, 16);

const statePill = (row: LinkDomainRow) => (row.enabled === 1 ? pill('ok', 'aktywna') : pill('dim', 'wyłączona'));

/** Plakietka sprawdzenia z datą ostatniego sprawdzenia. */
function checkPill(row: LinkDomainRow): string {
  if (row.checkedAt === null || row.checkOk === null) return pill('wait', 'niesprawdzona');
  const when = `<span class="dim m" style="margin-left: 8px;">${esc(minute(row.checkedAt))}</span>`;
  return row.checkOk === 1 ? `${pill('ok', 'sprawdzona')}${when}` : `${pill('fail', 'sprawdzenie nieudane')}${when}`;
}

/** „1 klucz”, „3 klucze”, „5 kluczy”. */
export function keyCount(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (n === 1) return '1 klucz';
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return `${n} klucze`;
  return `${n} kluczy`;
}

export function linkDomainListPage(views: LinkDomainView[]): string {
  const rows = views.length === 0
    ? '<tr><td class="dim" colspan="6">Brak domen skracacza. Dodaj domenę, aby bramka zamieniała linki w SMS-ach na krótkie linki tej domeny.</td></tr>'
    : views.map((v) => `<tr>
      <td class="m"><strong>${esc(v.row.domain)}</strong></td>
      <td>${esc(v.row.displayName)}</td>
      <td>${statePill(v.row)}</td>
      <td>${checkPill(v.row)}</td>
      <td>${v.keys === 0 ? '<span class="dim">brak</span>' : esc(keyCount(v.keys))}</td>
      <td class="row-actions">
        <form method="post" action="/skracacz/${esc(v.row.id)}/sprawdz">
          <input type="hidden" name="back" value="lista">
          <button class="btn btn-s" type="submit">Sprawdź domenę</button>
        </form>
        <a href="/skracacz/${esc(v.row.id)}">Otwórz</a>
      </td>
    </tr>`).join('');

  return `<div class="head">
    <div>
      <h1 class="h1">Skracacz linków</h1>
      <p class="sub">Domeny, w których bramka tworzy krótkie linki do SMS-ów i liczy ich otwarcia</p>
    </div>
    <a class="btn btn-p" href="/skracacz/nowa">Dodaj domenę</a>
  </div>
  <div class="scroll">
    <div class="panel">
      <table>
        <tr>
          <th style="width: 200px;">Domena</th>
          <th style="width: 200px;">Nazwa wyświetlana</th>
          <th style="width: 120px;">Stan</th>
          <th style="width: 260px;">Sprawdzenie</th>
          <th>Klucze</th>
          <th></th>
        </tr>
        ${rows}
      </table>
    </div>
  </div>`;
}

/** Opis kroku, na którym zatrzymało się sprawdzenie domeny (spec 4.2). */
export function checkMessage(domain: string, step: DomainCheckStep, detail: string): string {
  switch (step) {
    case 'dns':
      return `Nie można ustalić adresu domeny ${domain}. Sprawdź u dostawcy DNS rekord A albo CNAME tej domeny.`;
    case 'connect':
      return `Bramka nie może połączyć się z adresem https://${domain}. Sprawdź, czy serwer pośredniczący wystawia port `
        + 'przekierowań pod tą domeną i czy zapora przepuszcza ruch na porcie 443. W sieci bez pętli zwrotnej NAT serwer '
        + 'nie może połączyć się z własnym adresem publicznym. Sprawdzenie kończy się wtedy tym błędem, chociaż linki mogą działać u odbiorców.';
    case 'tls':
      return `Certyfikat HTTPS domeny ${domain} jest nieważny albo nie obejmuje tej domeny. Sprawdź certyfikat na serwerze pośredniczącym.`;
    case 'response':
      return detail === 'token'
        ? `Pod adresem domeny ${domain} odpowiada inny serwer albo inna instancja bramki. Sprawdź, czy serwer pośredniczący `
          + 'kieruje tę domenę na port przekierowań tej bramki.'
        : `Serwer pod adresem domeny ${domain} odpowiedział kodem ${detail} zamiast tokenu sprawdzenia. Sprawdź, czy serwer `
          + 'pośredniczący kieruje tę domenę na port przekierowań bramki, a nie na panel albo API.';
  }
}

const detailLabel = (detail: string) => (detail === 'timeout' ? 'przekroczony czas oczekiwania 10 s' : detail);

const STEP_LABEL: Record<DomainCheckStep, string> = {
  dns: 'rozwiązanie nazwy', connect: 'połączenie', tls: 'certyfikat', response: 'odpowiedź',
};

/** Panel „Sprawdzenie domeny”: ostatni wynik z opisem kroku i przycisk sprawdzenia. */
function checkPanel(row: LinkDomainRow): string {
  const failure = row.checkOk === 0 ? parseCheckDetail(row.checkDetail) : null;
  const result = row.checkedAt === null
    ? '<div class="hint">Domena nie była jeszcze sprawdzana. Sprawdzenie potwierdza za jednym razem rekord DNS, serwer pośredniczący, certyfikat i przypisanie domeny do tej bramki. Domena niesprawdzona może być używana</div>'
    : failure === null
      ? '<div class="hint">Bramka pobrała token sprawdzenia spod adresu domeny. Linki tej domeny trafiają do tej bramki</div>'
      : `<div class="warn">${esc(checkMessage(row.domain, failure.step, failure.detail))}</div>
        <div class="hint">Krok sprawdzenia: ${esc(STEP_LABEL[failure.step])}, kod błędu: <span class="m">${esc(detailLabel(failure.detail))}</span>.
          Opis znajdziesz w <a href="${problemUrl('skracacz-sprawdzenie-domeny')}" target="_blank" rel="noopener noreferrer">rozwiązywaniu problemów, w punkcie „Sprawdzenie domeny skracacza kończy się błędem”</a></div>`;
  return `<div class="panel">
      <div class="panel-h"><div class="lab">Sprawdzenie domeny</div></div>
      <div class="form">
        <div>${checkPill(row)}</div>
        ${result}
        <form method="post" action="/skracacz/${esc(row.id)}/sprawdz">
          <button class="btn btn-s" type="submit">Sprawdź domenę</button>
        </form>
      </div>
    </div>`;
}

function keysPanel(keys: Array<{ id: number; name: string }>): string {
  const body = keys.length === 0
    ? '<div class="dim">Domena nie jest przypisana do żadnego klucza. Przypisanie wykonuje się w sekcji „Skracanie linków” formularza klucza w „Klucze API”.</div>'
    : `<ul style="margin: 0; padding-left: 18px;">${keys.map((k) => `<li><a href="/klucze/${esc(k.id)}/edytuj">${esc(k.name)}</a></li>`).join('')}</ul>`;
  return `<div class="panel">
      <div class="panel-h"><div class="lab">Klucze API</div></div>
      <div class="form">${body}</div>
    </div>`;
}

function statePanel(row: LinkDomainRow): string {
  const toggle = row.enabled === 1
    ? `<form method="post" action="/skracacz/${esc(row.id)}/wylacz"
        data-confirm="Wyłączyć domenę ${esc(row.domain)}? Wszystkie linki tej domeny, także w wysłanych SMS-ach, będą prowadzić do strony „Link wygasł”." data-confirm-ok="Wyłącz">
        <button class="btn btn-s" type="submit">Wyłącz domenę</button>
      </form>`
    : `<form method="post" action="/skracacz/${esc(row.id)}/wlacz">
        <button class="btn btn-s" type="submit">Włącz domenę</button>
      </form>`;
  return `<div class="panel">
      <div class="panel-h"><div class="lab">Stan i usunięcie</div></div>
      <div class="form">
        <div>${statePill(row)}</div>
        <div class="hint">Wyłączona domena nie przekierowuje linków do adresów docelowych, dlatego odbiorca widzi stronę „Link wygasł”. Usunięcie jest możliwe, gdy domena nie jest przypisana do klucza, a bramka usunęła dane wysłanych linków po okresie retencji</div>
        <div style="display: flex; gap: 8px;">
          ${toggle}
          <form method="post" action="/skracacz/${esc(row.id)}/usun" data-confirm="Usunąć domenę ${esc(row.domain)}?" data-confirm-ok="Usuń">
            <button class="btn btn-s" type="submit">Usuń</button>
          </form>
        </div>
      </div>
    </div>`;
}

/** Wskazówka o rekordach DNS nad polami formularza (spec 4.3). */
function dnsGuide(): string {
  return `<div class="hint" style="font-size: 12.5px; line-height: 1.55;">
      Przed dodaniem domeny skieruj ją u dostawcy DNS na serwer bramki. Domena główna, na przykład firma-link.pl, wymaga
      rekordu A z publicznym adresem serwera. Subdomena, na przykład l.firma.pl, może zamiast niego używać rekordu CNAME
      z nazwą serwera. Serwer pośredniczący wystawia pod tą domeną port przekierowań bramki z certyfikatem HTTPS.
      Opis znajdziesz w <a href="${LINKS_DOCS_URL}" target="_blank" rel="noopener noreferrer">dokumentacji, w artykule „Skracacz linków”</a>.
    </div>`;
}

export function linkDomainFormPage(opts: {
  values: LinkDomainFormValues; row?: LinkDomainRow; keys?: Array<{ id: number; name: string }>; error?: string | null;
}): string {
  const v = opts.values;
  const row = opts.row;
  const action = row ? `/skracacz/${esc(row.id)}` : '/skracacz';
  const form = `<div class="panel">
      <form class="form" method="post" action="${action}" autocomplete="off">
        ${row ? '' : dnsGuide()}
        <div class="field">
          <label for="domain">Domena</label>
          <input id="domain" name="domain" value="${esc(v.domain)}" maxlength="253" required>
          <div class="hint">Domena główna albo subdomena, bez https:// i bez ścieżki, na przykład l.firma.pl albo firma-link.pl</div>
        </div>
        <div class="field">
          <label for="displayName">Nazwa wyświetlana</label>
          <input id="displayName" name="displayName" value="${esc(v.displayName)}" maxlength="100" required>
          <div class="hint">Nazwa firmy na stronie głównej domeny i na stronie „Link wygasł”</div>
        </div>
        <div class="field">
          <label for="homeUrl">Adres strony głównej</label>
          <input id="homeUrl" name="homeUrl" value="${esc(v.homeUrl)}" maxlength="2000" placeholder="https://firma.pl">
          <div class="hint">Adres, do którego prowadzi sama domena bez kodu. Puste pole oznacza neutralną stronę z nazwą wyświetlaną</div>
        </div>
        <div class="field">
          <label class="choice"><input type="checkbox" name="bareLinks" value="1"${v.bareLinks ? ' checked' : ''}> Linki w treści bez https://</label>
          <div class="hint">Krótki link w SMS-ie bez https://, na przykład l.firma.pl/aB3xK9q, jest krótszy o 8 znaków. Niektóre telefony mogą nie rozpoznać takiego zapisu jako linku</div>
        </div>
        <div><button class="btn btn-p" type="submit">Zapisz</button></div>
      </form>
    </div>`;

  const title = row ? row.domain : 'Nowa domena skracacza';
  const sub = row ? `Domena skracacza · ${row.displayName}` : 'Domena, w której bramka tworzy krótkie linki do SMS-ów';
  const content = row
    ? `<div class="cols">
        <div class="stack">${form}</div>
        <div class="stack">
          ${checkPanel(row)}
          ${keysPanel(opts.keys ?? [])}
          ${statePanel(row)}
        </div>
      </div>`
    : form;

  return `<div class="head">
    <div>
      <h1 class="h1">${esc(title)}</h1>
      <p class="sub">${esc(sub)}</p>
    </div>
  </div>
  <div class="scroll">
    ${opts.error ? `<div class="warn">${esc(opts.error)}</div>` : ''}
    ${content}
  </div>`;
}
