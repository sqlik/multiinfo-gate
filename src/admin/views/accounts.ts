import type { AccountRow } from '../../store/accounts.ts';
import type { InboundServiceState } from '../../store/inbound-services.ts';
import type { CertBundle } from '../../secrets/pkcs12.ts';
import type { CertificateView } from '../../multiinfo/client.ts';
import { warsawDay, warsawStamp } from '../../time/warsaw.ts';
import { esc } from './layout.ts';

export interface AccountView {
  row: AccountRow;
  serviceIds: string[];
  origs: string[];
  keyCount: number;
  /** Stan odbioru per usługa: kto subskrybuje i co ostatnio robił odbiornik. */
  inbound: Array<{ serviceId: string; subscribers: string[]; state: InboundServiceState }>;
}

/** Wynik sprawdzenia połączenia, gotowy do pokazania razem ze śladem żądania. */
export interface ProbeView {
  accountId: number;
  ok: boolean;
  code: number | null;
  message: string;
  durationMs: number;
  at: Date;
  /** Czy to sprawdzenie zdjęło wstrzymanie założone przez workera. */
  resumed: boolean;
  /** Odpowiedź strony test.aspx; null, gdy nie odpowiedziała. */
  certificate: CertificateView | null;
}

/** Poniżej tylu dni certyfikat opisujemy jako wygasający, a nie ważny. */
const CERT_WARNING_DAYS = 30;

/**
 * Dni liczymy w górę do pełnego dnia: certyfikat ważny jeszcze przez trzynaście dni
 * i czternaście godzin wygasa czternastego dnia, a nie trzynastego.
 */
export function daysUntil(iso: string, now: Date): number {
  return Math.ceil((Date.parse(iso) - now.getTime()) / 86_400_000);
}

/** Podpowiedź pod listą nadpisów: pierwsi użytkownicy oczekiwali, że konto pobierze nadpisy
 *  z Multiinfo - stąd na początku przyczyna, dopiero potem co wpisać. */
const ZDANIE_O_NADPISACH =
  'Multiinfo nie udostępnia listy nadpisów przez API, więc bramka nie może jej pobrać. ' +
  'Wpisz nadpisy uruchomione przez Polkomtel dla tego użytkownika API (panel Multiinfo, edycja użytkownika API, ' +
  'zakładka Nadpisy). Żądanie z nadpisem spoza listy bramka odrzuci kodem 403, zanim trafi do Multiinfo; ' +
  'nadpis wpisany, lecz nieuruchomiony, Multiinfo odrzuci kodem -14';

/** Instrukcja Polkomtela do wygenerowania certyfikatu użytkownika API. Adres stały, nie z danych. */
const CERT_INSTRUCTION_URL = 'https://plk-assets.s3.pl-waw.scw.cloud/certyfikaty-multiinfo.zip';

export const BASE_URLS = [
  'https://api1.multiinfo.plus.pl/Api61/',
  'https://api2.multiinfo.plus.pl/Api61/',
] as const;

function certCell(row: AccountRow, now: Date): string {
  const days = daysUntil(row.certNotAfter, now);
  if (days <= 0) return `<td class="m fail">wygasł ${esc(warsawDay(row.certNotAfter))}</td>`;
  if (days <= CERT_WARNING_DAYS) return `<td class="m wait">wygasa za ${esc(days)} dni</td>`;
  return `<td class="m">ważny do ${esc(warsawDay(row.certNotAfter))}</td>`;
}

/** Adres bazowy skracamy do samego hosta - pełny URL powtarza się w każdym wierszu. */
function host(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Formularz nowego konta. Certyfikat jest wymagany od razu - konto bez niego nic nie wyśle. */
export function newAccountPage(error: string | null = null, values: Record<string, string> = {}): string {
  const val = (name: string) => esc(values[name] ?? '');
  return `<div class="head">
    <div>
      <h1 class="h1">Nowe konto Multiinfo</h1>
      <p class="sub">Dane użytkownika API należy utworzyć w panelu Multiinfo. Instrukcje generowania certyfikatu dla użytkownika API znajdziesz <a href="${CERT_INSTRUCTION_URL}">tutaj</a>.</p>
    </div>
  </div>
  <div class="scroll">
    ${error === null ? '' : `<div class="warn">${esc(error)}</div>`}
    <div class="panel" style="max-width: 560px;">
      <form class="form" method="post" action="/konta" enctype="multipart/form-data">
        <div class="field">
          <label for="name">Nazwa w panelu</label>
          <input id="name" name="name" value="${val('name')}" required>
        </div>
        <div class="field">
          <label for="baseUrl">Adres bazowy</label>
          <select id="baseUrl" name="baseUrl">
            ${BASE_URLS.map((u) => `<option value="${esc(u)}"${(values.baseUrl ?? BASE_URLS[1]) === u ? ' selected' : ''}>${esc(u)}</option>`).join('')}
          </select>
          <div class="hint">api1 lub api2 - informacje o właściwej instancji otrzymasz od przedstawiciela Polkomtel.</div>
        </div>
        <div class="field">
          <label for="login">Login</label>
          <input id="login" name="login" value="${val('login')}" required>
          <div class="hint">Musi być zgodny z polem CN certyfikatu, inaczej Multiinfo odrzuci wysyłkę błędem -85.</div>
        </div>
        <div class="field">
          <label for="password">Hasło konta Multiinfo</label>
          <input id="password" name="password" type="password" autocomplete="off" required>
        </div>
        <div class="field">
          <label for="serviceIds">ID usług, jedno w wierszu</label>
          <textarea id="serviceIds" name="serviceIds" rows="3" required>${val('serviceIds')}</textarea>
        </div>
        <div class="field">
          <label for="defaultCountryCode">Domyślny kraj numerów</label>
          <input id="defaultCountryCode" name="defaultCountryCode" value="${values.defaultCountryCode ? esc(values.defaultCountryCode) : '48'}" required>
        </div>
        <div class="field">
          <label for="storeContent">Przechowywanie treści wiadomości</label>
          <select id="storeContent" name="storeContent">
            <option value="0"${values.storeContent === '1' ? '' : ' selected'}>nie przechowuj treści</option>
            <option value="1"${values.storeContent === '1' ? ' selected' : ''}>przechowuj treść w bazie</option>
          </select>
        </div>
        <div class="field">
          <label for="pfx">Plik .pfx albo .p12</label>
          <input id="pfx" name="pfx" type="file" accept=".pfx,.p12" required>
        </div>
        <div class="field">
          <label for="passphrase">Hasło do pliku .pfx</label>
          <input id="passphrase" name="passphrase" type="password" autocomplete="off" required>
        </div>
        <div><button class="btn btn-p" type="submit">Załóż konto</button></div>
      </form>
    </div>
  </div>`;
}

export function accountsPage(views: AccountView[], now: Date, notice: string | null = null): string {
  const rows = views.map((v) => `<tr>
      <td><strong>${esc(v.row.name)}</strong></td>
      <td class="m dim">${esc(host(v.row.baseUrl))}</td>
      <td class="m">${esc(v.row.login)}</td>
      <td class="m">${esc(v.serviceIds.join(', '))}</td>
      ${certCell(v.row, now)}
      <td class="m">${esc(v.keyCount)}</td>
      <td class="row-actions"><a href="/konta/${esc(v.row.id)}">Otwórz</a></td>
    </tr>`).join('');

  const dictionaries = views.map((v) => `<div class="panel">
      <div class="panel-h">
        <div class="lab">${esc(v.row.name)} - nadpisy nadawcy</div>
      </div>
      <div class="form">
        ${origsForm(v)}
      </div>
    </div>`).join('');

  return `<div class="head">
    <div>
      <h1 class="h1">Konta Multiinfo</h1>
      <p class="sub">Adres bazowy, dane logowania i certyfikat kliencki - po jednym zestawie na konto</p>
    </div>
    <a class="btn btn-p" href="/konta/nowe">Dodaj konto</a>
  </div>
  <div class="scroll">
    ${notice === null ? '' : `<div class="warn">${esc(notice)}</div>`}
    <div class="panel">
      <table>
        <tr>
          <th style="width: 160px;">Konto</th>
          <th style="width: 220px;">Adres bazowy</th>
          <th style="width: 130px;">Login</th>
          <th style="width: 150px;">ID usług</th>
          <th style="width: 200px;">Certyfikat</th>
          <th style="width: 110px;">Klucze API</th>
          <th></th>
        </tr>
        ${rows}
      </table>
    </div>
    ${dictionaries}
  </div>`;
}

function origsForm(v: AccountView): string {
  const options = v.origs.map((o) =>
    `<option value="${esc(o)}"${o === v.row.defaultOrig ? ' selected' : ''}>${esc(o)}</option>`).join('');

  return `<form method="post" action="/konta/${esc(v.row.id)}/nadpisy">
      <div class="field">
        <label for="origs-${esc(v.row.id)}">Nadpisy dozwolone dla konta, jeden w wierszu</label>
        <textarea id="origs-${esc(v.row.id)}" name="origs" rows="4">${esc(v.origs.join('\n'))}</textarea>
        <div class="hint">${esc(ZDANIE_O_NADPISACH)}</div>
      </div>
      <div class="field">
        <label for="default-${esc(v.row.id)}">Wartość domyślna konta</label>
        <select id="default-${esc(v.row.id)}" name="defaultOrig">
          <option value="">bez wartości domyślnej</option>
          ${options}
        </select>
      </div>
      <div><button class="btn btn-p" type="submit">Zapisz nadpisy</button></div>
    </form>`;
}

/** Szczegół konta: wymiana certyfikatu, odczytane pola i ślad sprawdzenia połączenia. */
export interface AccountFormValues {
  name: string; baseUrl: string; defaultCountryCode: string; storeContent: '0' | '1'; serviceIds: string;
}

export function accountValuesOf(v: AccountView): AccountFormValues {
  return {
    name: v.row.name, baseUrl: v.row.baseUrl, defaultCountryCode: v.row.defaultCountryCode,
    storeContent: v.row.storeContent === 1 ? '1' : '0', serviceIds: v.serviceIds.join('\n'),
  };
}

/** Adres spoza listy (np. z ręcznej migracji) zostaje na liście, żeby zapis bez zmian go nie zgubił. */
function baseUrlSelect(current: string): string {
  const options = [...new Set<string>([...BASE_URLS, current])].filter((u) => u !== '').map((u) =>
    `<option value="${esc(u)}"${u === current ? ' selected' : ''}>${esc(u)}</option>`).join('');
  return `<select id="baseUrl" name="baseUrl">${options}</select>
    <div class="hint">api1 lub api2 - informacje o właściwej instancji otrzymasz od przedstawiciela Polkomtel.</div>`;
}

export function editAccountPage(v: AccountView, error: string | null = null,
                                values: AccountFormValues = accountValuesOf(v)): string {
  return `<div class="head">
    <div>
      <div class="crumb"><a href="/konta">Konta Multiinfo</a> / <a href="/konta/${esc(v.row.id)}">${esc(v.row.name)}</a> / edycja</div>
      <h1 class="h1">${esc(v.row.name)}</h1>
      <p class="sub">Certyfikat wymienia się na ekranie konta; nadpisy na liście kont.</p>
    </div>
  </div>
  <div class="scroll">
    ${error === null ? '' : `<div class="warn">${esc(error)}</div>`}
    <div class="panel" style="max-width: 560px;">
      <form class="form" method="post" action="/konta/${esc(v.row.id)}/edytuj">
        <div class="field">
          <label for="name">Nazwa w panelu</label>
          <input id="name" name="name" value="${esc(values.name)}" required>
        </div>
        <div class="field">
          <label for="baseUrl">Adres bazowy</label>
          ${baseUrlSelect(values.baseUrl)}
        </div>
        <div class="field">
          <label>Login</label>
          <div class="box m">${esc(v.row.login)}</div>
          <div class="hint">Login jest związany z polem CN certyfikatu. Zmiana loginu oznacza nowe konto.</div>
        </div>
        <div class="field">
          <label for="password">Hasło konta Multiinfo</label>
          <input id="password" name="password" type="password" autocomplete="new-password">
          <div class="hint">Puste pole zostawia dotychczasowe hasło.</div>
        </div>
        <div class="field">
          <label for="serviceIds">ID usług, jedno w wierszu</label>
          <textarea id="serviceIds" name="serviceIds" rows="3" required>${esc(values.serviceIds)}</textarea>
          <div class="hint">ID usługi używanego przez czynny klucz API nie da się usunąć - najpierw zmień klucz.</div>
        </div>
        <div class="field">
          <label for="defaultCountryCode">Domyślny kraj numerów</label>
          <input id="defaultCountryCode" name="defaultCountryCode" value="${esc(values.defaultCountryCode)}" required>
        </div>
        <div class="field">
          <label for="storeContent">Przechowywanie treści wiadomości</label>
          <select id="storeContent" name="storeContent">
            <option value="0"${values.storeContent === '1' ? '' : ' selected'}>nie przechowuj treści</option>
            <option value="1"${values.storeContent === '1' ? ' selected' : ''}>przechowuj treść w bazie</option>
          </select>
        </div>
        <div><button class="btn btn-p" type="submit">Zapisz konto</button></div>
      </form>
    </div>
  </div>`;
}

export function accountPage(
  v: AccountView, now: Date, opts: { error?: string | null; bundle?: CertBundle | null; probe?: ProbeView | null } = {},
): string {
  const error = opts.error ?? null;
  const bundle = opts.bundle ?? null;
  const probe = opts.probe ?? null;

  return `<div class="head">
    <div>
      <h1 class="h1">${esc(v.row.name)}</h1>
      <p class="sub">${esc(v.row.login)} · ${esc(host(v.row.baseUrl))}</p>
    </div>
    <div style="display: flex; gap: 8px;">
      <a class="btn btn-s" href="/konta/${esc(v.row.id)}/edytuj">Edytuj</a>
      <form method="post" action="/konta/${esc(v.row.id)}/sprawdz">
        <button class="btn btn-s" type="submit">Sprawdź połączenie</button>
      </form>
    </div>
  </div>
  <div class="scroll">
    ${error === null ? '' : `<div class="warn">${esc(error)}</div>`}
    ${pausedBanner(v.row)}
    <div class="cols">
      <div class="panel">
        <div class="panel-h"><div class="lab">Wymiana certyfikatu</div></div>
        <form class="form" method="post" action="/konta/${esc(v.row.id)}/certyfikat" enctype="multipart/form-data">
          <div class="drop">
            <div class="field" style="gap: 3px;">
              <label for="pfx">Plik .pfx albo .p12 od Polkomtela</label>
              <input id="pfx" name="pfx" type="file" accept=".pfx,.p12" required>
            </div>
          </div>
          <div class="field">
            <label for="passphrase">Hasło do pliku .pfx</label>
            <input id="passphrase" name="passphrase" type="password" autocomplete="off" required>
            <div class="hint">Plik zostaje rozpakowany na bramce. Klucz prywatny trafia do bazy
              zaszyfrowany i nigdy jej nie opuszcza.</div>
          </div>
          <div><button class="btn btn-p" type="submit">Wczytaj certyfikat</button></div>
        </form>
      </div>
      <div class="stack">
        ${certificatePanel(v, now, bundle)}
        ${probe === null ? '' : probePanel(v, probe)}
        ${inboundPanel(v, now)}
      </div>
    </div>
  </div>`;
}

/**
 * Wstrzymanie zakłada worker po odrzuceniu certyfikatu. Zdejmuje je wgranie nowego
 * pliku albo udane sprawdzenie połączenia - obie drogi są tu wskazane wprost.
 */
function pausedBanner(row: AccountRow): string {
  if (row.pausedReason === null) return '';
  return `<div class="alert stop" style="margin-bottom: 14px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <div class="sq"></div>
        <div>Konto jest <strong>wstrzymane</strong>: ${esc(row.pausedReason)}.
          Wiadomości czekają w kolejce. Wgraj poprawny certyfikat albo - po naprawie
          po stronie Polkomtela - użyj sprawdzenia połączenia; wynik pozytywny wznowi wysyłkę.</div>
      </div>
    </div>`;
}

function certificatePanel(v: AccountView, now: Date, bundle: CertBundle | null): string {
  const days = daysUntil(v.row.certNotAfter, now);
  const cnMatches = v.row.certCn === v.row.login;

  const detail = bundle === null ? '' : `
      <div>Podmiot O / L / C</div><div class="m">${esc([bundle.organization, bundle.locality, bundle.country]
        .filter((x) => x !== null).join(' / '))}</div>
      <div>Klucz</div><div class="m">RSA ${esc(bundle.keyBits)}</div>`;

  return `<div class="panel">
      <div class="panel-h"><div class="lab">Odczytane dane certyfikatu</div></div>
      <div class="kv">
        <div>Podmiot CN</div><div class="m">${esc(v.row.certCn)}</div>
        ${detail}
        <div>Wystawca</div><div class="m">${esc(v.row.certIssuerCn)}</div>
        <div>Odcisk SHA-1</div><div class="m" style="word-break: break-all;">${esc(v.row.certFingerprintSha1)}</div>
        <div style="border-bottom: none;">Ważny</div>
        <div style="border-bottom: none;" class="m">${esc(warsawDay(v.row.certNotBefore))} →
          ${esc(warsawDay(v.row.certNotAfter))} <span class="dim">(${esc(days)} dni)</span></div>
      </div>
      <div style="padding: 12px 0 14px; display: flex; flex-direction: column; gap: 7px;">
        <div class="check">
          <div class="sq ${cnMatches ? 'sq-ok' : 'sq-fail'}"></div>
          <div>${cnMatches
            ? 'Pole CN zgadza się z loginem konta - bez tego Multiinfo zwróci błąd -85.'
            : `Pole CN certyfikatu (${esc(v.row.certCn)}) nie zgadza się z loginem konta ` +
              `(${esc(v.row.login)}). Multiinfo odrzuci każdą wysyłkę błędem -85.`}</div>
        </div>
        <div class="check">
          <div class="sq sq-wait"></div>
          <div>Przed pierwszym użyciem uzupełnij wystawcę, podmiot i odcisk palca w panelu Multiinfo (edycja użytkownika API, zakładka Uwierzytelnianie).
            Do tego czasu wysyłka będzie odrzucana błędem -84.</div>
        </div>
      </div>
    </div>`;
}

/**
 * Kody sprawdzenia mówią bardzo różne rzeczy i mylenie ich kosztuje godziny:
 * -1 to hasło, -80 brak certyfikatu w uzgodnieniu TLS, -85 niezgodny CN.
 */
function explainProbe(code: number, message: string): string {
  switch (code) {
    case -1:
      return `Logowanie odrzucone. Sprawdź login i hasło konta Multiinfo - ${message}.`;
    case -80:
      return 'Połączenie stanęło, ale certyfikat nie został przedstawiony. Sprawdź, czy konto ma wgrany plik .pfx.';
    case -84:
      return 'Certyfikat nie jest jeszcze uzgodniony po stronie Polkomtela. Prześlij wystawcę, podmiot i odcisk palca.';
    case -85:
      return 'Pole CN certyfikatu nie zgadza się z loginem konta.';
    default:
      return message;
  }
}

function probePanel(v: AccountView, probe: ProbeView): string {
  const stamp = `${warsawStamp(probe.at.toISOString())} · ${probe.durationMs} ms`;
  const trace = probe.ok
    ? `<span class="ar">→</span> POST ${esc(host(v.row.baseUrl))}/infosms.aspx?smsId=0\n\n` +
      `<span class="ar">←</span> 200 OK · uzgodniono TLS z certyfikatem CN=${esc(v.row.certCn)}\n` +
      `<span class="ln">   1</span>  -31\n` +
      `<span class="ln">   2</span>  Nieprawidłowa wartość identyfikatora wiadomości`
    : `<span class="ar">→</span> POST ${esc(host(v.row.baseUrl))}/infosms.aspx?smsId=0\n\n` +
      `<span class="ar">←</span> ${esc(probe.code)}\n` +
      `<span class="ln">   1</span>  ${esc(probe.code)}\n` +
      `<span class="ln">   2</span>  ${esc(probe.message)}`;

  const verdict = probe.ok
    ? 'Certyfikat przyjęty, logowanie poprawne. Błąd -31 jest oczekiwany: sprawdzenie celowo ' +
      'pyta o nieistniejącą wiadomość, żeby nie wysyłać SMS-a.' +
      (probe.resumed ? ' Konto zostało wznowione - wiadomości z kolejki ruszą w ciągu minuty.' : '')
    : explainProbe(probe.code ?? 0, probe.message);

  return `<div class="panel">
      <div class="panel-h">
        <div class="lab">Sprawdzenie połączenia</div>
        <div class="m dim">${esc(stamp)}</div>
      </div>
      <div class="trace">${trace}\n\n${certificateTrace(v, probe.certificate)}</div>
      <div style="padding: 0 16px 16px; display: flex; flex-direction: column; gap: 7px;">
        <div class="check" style="padding: 0;">
          <div class="sq ${probe.ok ? 'sq-ok' : 'sq-fail'}"></div>
          <div>${esc(verdict)}</div>
        </div>
        ${certificateCheck(v, probe.certificate)}
      </div>
    </div>`;
}

/**
 * Ślad drugiego zapytania: strona test.aspx pokazuje certyfikat oczami serwera Multiinfo.
 * To jedyne miejsce, gdzie widać, co Polkomtel odczytał, a nie co my odczytaliśmy z .pfx.
 */
function certificateTrace(v: AccountView, certificate: CertificateView | null): string {
  const head = `<span class="ar">→</span> GET ${esc(host(v.row.baseUrl))}/test.aspx\n\n`;
  if (certificate === null) return `${head}<span class="ar">←</span> brak odpowiedzi`;
  if (!certificate.seen) {
    return `${head}<span class="ar">←</span> 200 OK\n<span class="ln">   1</span>  ${esc(certificate.message)}`;
  }
  return `${head}<span class="ar">←</span> 200 OK · Certyfikat widziany przez Multiinfo\n` +
    `<span class="ln">   1</span>  Podmiot: ${esc(certificate.subject)}\n` +
    `<span class="ln">   2</span>  Wystawca: ${esc(certificate.issuer)}\n` +
    `<span class="ln">   3</span>  Ważny do: ${esc(certificate.validTo)}`;
}

function certificateCheck(v: AccountView, certificate: CertificateView | null): string {
  if (certificate === null) {
    return `<div class="check" style="padding: 0;">
          <div class="sq sq-wait"></div>
          <div>Strona test.aspx nie odpowiedziała. Wynik powyżej pozostaje w mocy - ta strona
            tylko pokazuje, co Multiinfo odczytało z certyfikatu.</div>
        </div>`;
  }
  if (!certificate.seen) {
    return `<div class="check" style="padding: 0;">
          <div class="sq sq-fail"></div>
          <div>Multiinfo nie zobaczyło certyfikatu w uzgodnieniu TLS. Bramka wysłała plik wczytany
            na tej karcie - jeżeli był wgrany ponownie, sprawdź, czy wczytanie się powiodło.</div>
        </div>`;
  }
  const cnMatches = certificate.subjectCn === v.row.login;
  return `<div class="check" style="padding: 0;">
          <div class="sq ${cnMatches ? 'sq-ok' : 'sq-fail'}"></div>
          <div>${cnMatches
            ? `CN widziane przez Multiinfo zgadza się z loginem konta (${esc(v.row.login)}).`
            : `CN widziane przez Multiinfo (${esc(certificate.subjectCn ?? '-')}) nie zgadza się z loginem konta ` +
              `(${esc(v.row.login)}). Wystaw certyfikat z CN równym loginowi.`}
            Wystawca ${esc(certificate.issuerCn ?? certificate.issuer)}, ważny do ${esc(certificate.validTo)}.</div>
        </div>`;
}

/** „12 s temu”, „3 min temu”, „2 h temu” - do stanu odbiornika; dokładny czas i tak jest w dzienniku. */
function ago(iso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s temu`;
  if (s < 3600) return `${Math.round(s / 60)} min temu`;
  return `${Math.round(s / 3600)} h temu`;
}

/**
 * Odbiór wiadomości przychodzących per usługa. Kolejność rozstrzygania jest celowa: konto
 * wstrzymane gasi wszystko, błąd Multiinfo jest ważniejszy niż lista subskrybentów, a brak
 * subskrybentów to stan zwykły, nie awaria.
 */
function inboundPanel(v: AccountView, now: Date): string {
  const rows = v.inbound.map(({ serviceId, subscribers, state }) => {
    let status: string;
    if (v.row.pausedReason !== null) status = '<span class="st"><span class="dot dot-wait"></span>wstrzymany razem z kontem</span>';
    else if (state.error !== null) status = `<span class="st"><span class="dot dot-fail"></span>zatrzymany: ${esc(state.error)}</span>`;
    else if (subscribers.length === 0) status = '<span class="dim">nieaktywny (brak subskrybujących kluczy)</span>';
    else {
      const polled = state.lastPollAt === null ? 'jeszcze nie pytano' : `ostatnio pytano ${ago(state.lastPollAt, now)}`;
      const received = state.lastReceivedAt === null ? 'nic jeszcze nie odebrano' : `ostatnia odebrana ${warsawStamp(state.lastReceivedAt)}`;
      status = `<span class="st"><span class="dot dot-ok"></span>aktywny</span>
        <div class="dim" style="font-size: 11.5px; margin-top: 2px;">${esc(polled)} · ${esc(received)}</div>`;
    }
    return `<tr>
      <td class="m">${esc(serviceId)}</td>
      <td>${subscribers.length === 0 ? '<span class="dim">-</span>' : esc(subscribers.join(', '))}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
  return `<div class="panel">
    <div class="panel-h"><div class="lab">Odbiór wiadomości</div><a href="/klucze">Subskrypcje przy kluczach</a></div>
    <table>
      <tr><th style="width: 70px;">ID usługi</th><th style="width: 140px;">Odbierają klucze</th><th>Stan odbiornika</th></tr>
      ${rows}
    </table>
    <div class="hint" style="padding: 10px 16px;">Odebrane SMS-y trafiają do API Multiinfo tylko wtedy, gdy administrator Polkomtel ustawi
      na koncie kierowanie do API - domyślnie lądują w panelu WWW Multiinfo.</div>
  </div>`;
}
