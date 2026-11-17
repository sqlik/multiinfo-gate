// Most widoku z aplikacją AI według rozszerzenia MCP Apps 2026-01-26. Widok działa w ramce aplikacji
// i rozmawia z nią komunikatami JSON-RPC przez postMessage. Plik trafia do dokumentu widoku razem
// z plikiem widoku, dlatego nie importuje niczego i nie korzysta z zasobów zewnętrznych.

export const APPS_PROTOCOL_VERSION = '2026-01-26';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Ucieczka wartości wstawianej do HTML: treść od obcych i nazwy zawsze trafiają do widoku jako tekst. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

const WARSAW = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Chwila w czasie polskim w zapisie panelu: RRRR-MM-DD GG:MM. */
export function stamp(iso) {
  const parts = Object.fromEntries(WARSAW.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Okno anulowania rozsyłki z terminem, jak w panelu, API i konektorze. */
export const CANCEL_WINDOW = 'Anulowanie jest możliwe do chwili przekazania rozsyłki do Multiinfo, zwykle 10 minut przed terminem';

/** Liczba z odstępem tysięcy, jak w panelu kampanii: 1 240. */
export const num = (n) => Number(n).toLocaleString('pl-PL', { useGrouping: 'always' });

/** Forma rzeczownika po liczebniku: 1 część, 2 części, 5 części. */
export function pluralWord(n, one, few, many) {
  if (n === 1) return one;
  const tens = n % 100;
  return n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14) ? few : many;
}

/** Liczebnik z rzeczownikiem: 1 SMS, 2 SMS-y, 12 SMS-ów. */
export const plural = (n, one, few, many) => `${n} ${pluralWord(n, one, few, many)}`;

/** Tekst wyniku narzędzia, także komunikat błędu. */
export const textOf = (result) => (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');

/** Plakietka stanu: ok, wait, fail albo plain. */
export const badge = (tone, text) => `<span class="badge b-${tone}">${esc(text)}</span>`;

/** Notatka pod polem albo sekcją. */
export const note = (text) => `<p class="note">${esc(text)}</p>`;

/** Numer w zapisie panelu: 48601000021, bez plusa i odstępów. */
export const phoneLabel = (phone) => String(phone ?? '');

/** Sekcja karty: pogrubiona nazwa, opcjonalny opis pod nazwą i treść. Nazwa i opis trafiają do widoku jako tekst. */
export const section = (title, body, lead = '') => `<section class="sec"><h3>${esc(title)}</h3>`
  + `${lead ? `<p class="lead">${esc(lead)}</p>` : ''}${body}</section>`;

/** Pole albo informacja: etykieta nad wartością i opcjonalna podpowiedź pod nią. `control` jest gotowym HTML. */
export const field = (label, control, hint = '', wide = false) =>
  `<div class="field${wide ? ' wide' : ''}"><span class="lbl">${esc(label)}</span>${control}${hint ? note(hint) : ''}</div>`;

/** Pole w osobnym wierszu na całą szerokość siatki: wartość z podpowiedzią obok pary list wyglądałaby nierówno. */
export const wideField = (label, control, hint = '') => field(label, control, hint, true);

/** Pola i informacje w dwóch równych kolumnach; puste pozycje są pomijane. */
export const fields = (...items) => `<div class="fields">${items.filter(Boolean).join('')}</div>`;

/** Wartość tekstowa pola. */
export const txt = (value) => `<div class="txt">${esc(value)}</div>`;

/** Kafel podsumowania: etykieta, wartość i opis jako tekst; `tone` 'ok' wyróżnia stan pomyślny. */
export const tile = (label, value, sub, tone = '') => `<div class="tile${tone ? ` ${tone}` : ''}"><div class="lbl">${esc(label)}</div>`
  + `<div class="v">${esc(value)}</div><div class="s">${esc(sub)}</div></div>`;

/**
 * Udział w procentach z jednym miejscem po przecinku. Wartość niezerowa nie zaokrągla się do „0,0 %”, a niepełna do
 * „100,0 %”, dlatego 3 niedoręczone z 9899 nie znikają w kafelku.
 */
export function share(part, whole) {
  if (whole === 0) return '-';
  const value = (part / whole) * 100;
  if (part > 0 && value < 0.05) return 'poniżej 0,1 %';
  if (part < whole && value >= 99.95) return 'ponad 99,9 %';
  return `${value.toFixed(1).replace('.', ',')} %`;
}

/** Cztery równe kafle w rzędzie, w wąskiej ramce dwa. */
export const tiles = (...items) => `<div class="tiles">${items.join('')}</div>`;

/**
 * Przycisk: `kind` primary dla działania głównego, danger dla nieodwracalnego, bez rodzaju dla pomocniczego.
 * `data` dopisuje atrybuty data-*, a `disabled` wyłącza przycisk.
 */
export function button(label, { act, kind, disabled = false, data = {} } = {}) {
  const attrs = Object.entries({ act, ...data }).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `<button type="button" class="btn${kind ? ` btn-${kind}` : ''}"${attrs}${disabled ? ' disabled' : ''}>${esc(label)}</button>`;
}

/** Przyciski równej szerokości, które razem wypełniają szerokość karty; cztery przyciski stoją w dwóch kolumnach. */
export function buttons(...list) {
  const shown = list.filter(Boolean);
  if (shown.length === 0) return '';
  const columns = shown.length === 4 ? 2 : Math.min(shown.length, 3);
  return `<div class="btns n${columns}">${shown.join('')}</div>`;
}

/** Najwięcej numerów na liście odbiorców w widoku; dłuższa lista kończy się wielokropkiem. */
export const NUMBERS_MAX = 500;

/** Numery odbiorców po przecinku, z nazwą albo identyfikatorem klienta przed numerem; pozycje { phone, label }. */
export function numbers(list) {
  if (!list || list.length === 0) return '';
  // Twarda spacja wiąże nazwę z numerem, dlatego wiersz nie kończy się nazwą bez jej numeru.
  const shown = list.slice(0, NUMBERS_MAX).map((r) => esc(r.label ? `${r.label}\u00a0${phoneLabel(r.phone)}` : phoneLabel(r.phone)));
  return `<p class="nums">${shown.join(', ')}${list.length > NUMBERS_MAX ? ', …' : ''}</p>`;
}

/** Liczba znaków i części SMS-a z kodowaniem: <b>131</b> znaków · <b>2</b> części · UCS-2. */
export const smsCounter = (m) => `<b>${m.characters}</b> ${pluralWord(m.characters, 'znak', 'znaki', 'znaków')} · `
  + `<b>${m.parts}</b> ${pluralWord(m.parts, 'część', 'części', 'części')} · ${m.encoding === 'gsm' ? 'GSM' : 'UCS-2'}`;

/** Okno treści SMS-a: nadawca na telefonie, licznik i treść. `body` jest gotowym HTML z treścią po ucieczce. */
export const messageBox = ({ sender, counter, body }) => '<div class="msg"><div class="msg-head">'
  + `<span>${sender ? `Nadawca na telefonie: <b>${esc(sender)}</b>` : ''}</span><span>${counter}</span></div>`
  + `<div class="msg-text">${body}</div></div>`;

/**
 * Komunikat po błędzie aplikacji AI przy wywołaniu narzędzia bramki, na przykład po odpowiedzi 502, gdy bramka jest
 * chwilowo niedostępna. Oryginalny tekst aplikacji, zwykle angielski, widok pokazuje w rozwijanych szczegółach.
 */
export const HOST_TOOL_ERROR = 'Aplikacja AI zgłosiła błąd połączenia z bramką. Spróbuj ponownie za kilka minut, '
  + 'a gdy błąd się powtarza, zwróć się do administratora bramki.';
/** Komunikat po błędzie aplikacji AI przy innym żądaniu widoku niż wywołanie narzędzia. */
export const HOST_ERROR = 'Aplikacja AI zgłosiła błąd i nie wykonała prośby widoku';

/** Tekst i szczegóły błędu do komunikatu: `say('fail', ...failure(error))`. */
export const failure = (error) => (error instanceof Error ? [error.message, typeof error.detail === 'string' ? error.detail : ''] : [String(error), '']);

/** Komunikat w elemencie: tekst, a przy błędzie aplikacji AI także jej oryginalny tekst w rozwijanych szczegółach. */
export function showNotice(notice, tone, text, detail = '') {
  notice.hidden = !text;
  notice.className = `notice n-${tone}`;
  if (text && detail) {
    notice.innerHTML = `${esc(text)}<details class="why"><summary>Szczegóły błędu</summary><div class="mono">${esc(detail)}</div></details>`;
  } else notice.textContent = text;
}

/** Komunikat pod widokiem w elemencie #komunikat; pusty tekst ukrywa komunikat. */
export function sayIn(doc) {
  const notice = doc.getElementById('komunikat');
  return (tone, text, detail = '') => showNotice(notice, tone, text, detail);
}

/**
 * Link do pliku z wyniku narzędzia { url, expiresAt }: otwiera go aplikacja AI, a bez tej możliwości komunikat
 * pokazuje adres do skopiowania.
 */
export async function openDownload(bridge, say, link) {
  const until = stamp(link.expiresAt);
  if (await bridge.openLink(link.url)) return say('ok', `Plik zawiera numery telefonów odbiorców. Link jest ważny do ${until}.`);
  return say('plain', `Aplikacja AI nie otwiera linków z widoku, dlatego skopiuj adres pliku ważnego do ${until}: ${link.url}`);
}

/**
 * Komunikat po wiadomości do rozmowy (`ui/message`). Aplikacja przyjmuje wiadomość, ale może jeszcze poprosić
 * człowieka o zgodę, dlatego widok nie twierdzi, że wiadomość jest już w rozmowie.
 */
export const forwardedText = (what) => `${what} została przekazana aplikacji AI. Jeżeli aplikacja poprosi o zgodę na wiadomość, zatwierdź ją w rozmowie.`;

/** Komunikat o wywołaniu przerwanym przez aplikację. */
export const cancelledText = (reason) => (reason ? `Aplikacja AI przerwała wywołanie narzędzia: ${reason}` : 'Aplikacja AI przerwała wywołanie narzędzia');

/** Motyw aplikacji w dokumencie widoku; bez motywu widok kieruje się ustawieniem systemu. */
export function applyTheme(doc, context) {
  const theme = context && (context.theme === 'dark' || context.theme === 'light') ? context.theme : null;
  if (theme) doc.documentElement.dataset.theme = theme;
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Most: uzgodnienie `ui/initialize`, przyjmowanie wyniku narzędzia i kontekstu aplikacji, wywołania
 * narzędzi bramki, wiadomość do rozmowy, otwarcie linku, tryb wyświetlania i zgłaszanie rozmiaru.
 * Komunikaty spoza okna nadrzędnego są pomijane.
 */
export function createBridge(win, handlers = {}) {
  const parent = win.parent;
  const pending = new Map();
  let nextId = 1;
  let host = { capabilities: {}, context: {} };
  let lastSize = '';

  const post = (message) => parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const notify = (method, params = {}) => post({ method, params });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      post({ id, method, params });
    });
  }

  function onRequest(msg) {
    if (msg.method === 'ui/resource-teardown' || msg.method === 'ping') post({ id: msg.id, result: {} });
    else post({ id: msg.id, error: { code: -32601, message: `Widok nie obsługuje metody ${msg.method}.` } });
  }

  function onNotification(msg) {
    const params = isObject(msg.params) ? msg.params : {};
    switch (msg.method) {
      case 'ui/notifications/tool-input': handlers.onToolInput?.(isObject(params.arguments) ? params.arguments : {}); break;
      case 'ui/notifications/tool-result': handlers.onToolResult?.(params); break;
      case 'ui/notifications/host-context-changed':
        host = { ...host, context: { ...host.context, ...params } };
        handlers.onContext?.(host.context);
        break;
      case 'ui/notifications/tool-cancelled': handlers.onToolCancelled?.(typeof params.reason === 'string' ? params.reason : null); break;
      default: break;
    }
  }

  win.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const msg = event.data;
    if (!isObject(msg) || msg.jsonrpc !== '2.0') return;
    if (typeof msg.method === 'string') {
      if ('id' in msg) onRequest(msg);
      else onNotification(msg);
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (isObject(msg.error)) {
      // Tekst błędu pochodzi od aplikacji, na przykład surowa odpowiedź 502 serwera pośredniczącego, dlatego widok
      // pokazuje polski komunikat, a tekst aplikacji tylko w szczegółach.
      const error = new Error(entry.method === 'tools/call' ? HOST_TOOL_ERROR : HOST_ERROR);
      error.detail = typeof msg.error.message === 'string' ? msg.error.message : '';
      entry.reject(error);
    } else entry.resolve(isObject(msg.result) ? msg.result : {});
  });

  function notifySize(size) {
    let measured = size;
    if (!measured) {
      const doc = win.document;
      if (!doc) return;
      const root = doc.documentElement;
      const previous = root.style.height;
      root.style.height = 'max-content';
      measured = { width: Math.ceil(win.innerWidth), height: Math.ceil(root.getBoundingClientRect().height) };
      root.style.height = previous;
    }
    const key = `${measured.width}x${measured.height}`;
    if (key === lastSize) return;
    lastSize = key;
    notify('ui/notifications/size-changed', { width: measured.width, height: measured.height });
  }

  function watchSize() {
    if (typeof win.ResizeObserver !== 'function' || !win.document) return;
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      win.requestAnimationFrame(() => { scheduled = false; notifySize(); });
    };
    const observer = new win.ResizeObserver(schedule);
    observer.observe(win.document.documentElement);
    observer.observe(win.document.body);
    schedule();
  }

  const ready = request('ui/initialize', {
    protocolVersion: APPS_PROTOCOL_VERSION,
    appInfo: { name: 'multiinfo-gate', version: handlers.version ?? '' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
  }).then((result) => {
    host = {
      info: isObject(result.hostInfo) ? result.hostInfo : {},
      capabilities: isObject(result.hostCapabilities) ? result.hostCapabilities : {},
      context: isObject(result.hostContext) ? result.hostContext : {},
    };
    notify('ui/notifications/initialized');
    handlers.onContext?.(host.context);
    watchSize();
    return host;
  });

  return {
    ready,
    /** Wywołanie narzędzia bramki przez aplikację; wynik z isError jest zwykłym wynikiem, błąd protokołu odrzuca obietnicę. */
    async callTool(name, args = {}) {
      await ready;
      if (!isObject(host.capabilities.serverTools)) {
        throw new Error('Aplikacja AI nie pozwala widokowi wywoływać narzędzi bramki. Poproś agenta w rozmowie o to samo działanie.');
      }
      return request('tools/call', { name, arguments: args });
    },
    /** Wiadomość do rozmowy w imieniu użytkownika; false, gdy aplikacja jej nie obsługuje albo odmówiła. */
    async sendMessage(text) {
      await ready;
      if (!isObject(host.capabilities.message)) return false;
      const result = await request('ui/message', { role: 'user', content: [{ type: 'text', text }] });
      return result.isError !== true;
    },
    /** Otwarcie linku przez aplikację; false, gdy aplikacja tego nie obsługuje albo odmówiła. */
    async openLink(url) {
      await ready;
      if (!isObject(host.capabilities.openLinks)) return false;
      const result = await request('ui/open-link', { url });
      return result.isError !== true;
    },
    /** Prośba o tryb wyświetlania; wynikiem jest tryb, który aplikacja faktycznie ustawiła. */
    async requestDisplayMode(mode) {
      await ready;
      const result = await request('ui/request-display-mode', { mode });
      return typeof result.mode === 'string' ? result.mode : host.context.displayMode ?? 'inline';
    },
    notifySize,
    host: () => host,
  };
}
