// Widok „Rozsyłka z pliku”: pracownik wybiera plik z odbiorcami, a widok czyta go na komputerze pracownika,
// rozpoznaje nagłówek i kolumnę numeru, pokazuje pierwsze wiersze i po zatwierdzeniu przekazuje wiersze
// do bramki porcjami narzędziem upload_file_rows, widocznym wyłącznie dla widoku. Agent otrzymuje tylko
// stałą wiadomość o wczytaniu pliku, a wartości z pliku do niego nie trafiają. Wynik prepare_file_sms widok
// pokazuje jako podgląd z gotowymi wiadomościami, a po wysyłce i z wyniku file_send_status jako postęp wysyłki.

import {
  applyTheme, button, buttons, CANCEL_WINDOW, cancelledText, createBridge, esc, failure, field, fields, forwardedText, messageBox, note, num, numbers,
  openDownload, pluralWord, retryable, retryText, sayIn, section, share, smsCounter, stamp, textOf, tile, tiles, txt, wideField,
} from './bridge.js';
import { stackBar } from './chart.js';
import { latinText, measure } from './measure.js';
import {
  analyze, FILE_BYTES_MAX, FILE_TOO_BIG, nextChunk, readFileBytes, ROWS_MAX, UPLOAD_BYTES, UPLOAD_CHUNK,
} from './plik-tabela.js';
import { parseCsv, SEPARATOR_CHARS } from './plik-csv.js';
import { readSheet } from './plik-xlsx.js';
import { APPROVAL_TEXT, clock, FIX_MESSAGE, option, recipientsLeftTile, REPEATED_NOTE, scheduleField, select } from './send.js';

/** Wiadomość do rozmowy po przekazaniu pliku: stały tekst bramki, jak FILE_LOADED_MESSAGE w narzędziach. */
export const FILE_LOADED = 'Plik z odbiorcami jest wczytany w widoku bramki. Przygotuj treść SMS-a z polami pliku.';

/** Liczba wierszy danych pokazywanych pracownikowi przed przekazaniem pliku. */
const PREVIEW_ROWS = 5;

const ENCODINGS = {
  'utf-8': 'UTF-8', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16', 'windows-1250': 'Windows-1250', 'x-mac-ce': 'MacCentralEurope z Excela dla macOS',
};
const SEPARATORS = { ';': 'średnik', ',': 'przecinek', '\t': 'tabulator' };
/** Wartość separatora na liście: tabulator jako „tab”, ponieważ znak tabulatora w atrybucie jest nieczytelny. */
const separatorValue = (c) => (c === '\t' ? 'tab' : c);
const separatorChar = (v) => (v === 'tab' ? '\t' : v);

/** Pole wyboru pliku: ukryte pole systemowe, przycisk i nazwa pliku wyśrodkowane w pionie w jednej ramce. */
const PICKER = '<label class="pick"><input type="file" id="plik" accept=".csv,.txt,.xlsx">'
  + '<span class="btn pick-btn">Wybierz plik</span><span class="pick-name" id="plik-nazwa">Nie wybrano pliku</span></label>';

/**
 * Przesłanie wierszy porcjami w kolejności offsetów: najwyżej `size` wierszy i `bytes` bajtów w porcji. Nagłówek
 * pliku przechodzi wyłącznie w pierwszej porcji. Odmowa limitu żądań klucza wstrzymuje przesyłanie
 * na `retryAfterSec` i ponawia tę samą porcję. Po komplecie widok wysyła do rozmowy stałą wiadomość.
 * Wynik: { error, forwarded }.
 */
export async function transferFile(bridge, file, { size = UPLOAD_CHUNK, bytes = UPLOAD_BYTES, wait, onChunk = () => undefined }) {
  const total = file.rows.length;
  let fileId = null;
  let offset = 0;
  for (;;) {
    const end = nextChunk(file.rows, offset, { size, bytes });
    const rows = file.rows.slice(offset, end);
    const last = end >= total;
    const head = fileId === null ? { name: file.name, columns: file.columns, phoneColumn: file.phoneColumn, totalRows: total } : { fileId };
    const result = await bridge.callTool('upload_file_rows', { ...head, offset, rows, ...(last ? { done: true } : {}) });
    const out = result.structuredContent ?? {};
    if (result.isError) {
      if (out.error !== 'rate_limited') return { error: textOf(result), forwarded: false };
      onChunk({ offset, rows: rows.length, retried: true });
      await wait((out.retryAfterSec ?? 60) * 1000);
      continue;
    }
    onChunk({ offset, rows: rows.length, retried: false });
    fileId = out.fileId;
    if (out.complete) break;
    if (last || !(out.received > offset)) return { error: 'Bramka nie przyjęła wszystkich wierszy pliku. Wybierz plik ponownie.', forwarded: false };
    offset = out.received;
  }
  return { error: null, forwarded: await bridge.sendMessage(FILE_LOADED) };
}

const selectOf = (id, options) => `<select class="sel" id="${id}">${options.join('')}</select>`;

/** Komunikat w sekcji, gdy pliku nie można przekazać; null, gdy można. */
function blocker(t) {
  if (t.data.length === 0) return 'Plik nie zawiera wierszy danych';
  if (t.data.length > ROWS_MAX) {
    return `Plik zawiera ${num(t.data.length)} wierszy danych, a bramka przyjmuje najwyżej ${num(ROWS_MAX)} wierszy. Podziel plik na mniejsze części.`;
  }
  return null;
}

/** Postęp przekazywania i wynik: pasek przekazanych wierszy i liczba wierszy przyjętych przez bramkę. */
function renderProgress(s) {
  if (!s.progress) return '';
  const { sent, total } = s.progress;
  const text = s.done ? `Bramka przyjęła ${num(total)} ${pluralWord(total, 'wiersz', 'wiersze', 'wierszy')} z pliku`
    : `Przekazano ${num(sent)} z ${num(total)} ${pluralWord(total, 'wiersza', 'wierszy', 'wierszy')}`;
  return section('Przekazanie do bramki', stackBar([{ tone: s.done ? 'ok' : 'wait', value: sent }, { tone: 'rest', value: total - sent }]) + note(text));
}

/**
 * Rozpoznanie pliku i pierwsze wiersze danych. Wartości z pliku widzi wyłącznie pracownik w widoku, a zdanie
 * pod tabelą mówi, że agent zobaczy tylko nazwy kolumn. Wszystkie wartości trafiają do widoku jako tekst.
 */
export function renderLoaded(s) {
  const t = s.table;
  const xlsx = s.source.kind === 'xlsx';
  const picked = s.phoneColumn !== null && s.phoneColumn !== undefined;
  const phoneHint = picked ? '' : t.phoneCandidates.length > 1
    ? 'Numery telefonów występują w kilku kolumnach, dlatego wybierz właściwą z listy'
    : 'Widok nie rozpoznał kolumny z numerami telefonów, dlatego wybierz ją z listy';
  const phoneSelect = selectOf('numer', [...(picked ? [] : [option('', 'Wybierz kolumnę z numerami', true)]),
    ...t.columns.map((c, i) => option(i, c, i === s.phoneColumn))]);
  const stop = blocker(t);
  const recognition = fields(
    field('Kolumna numeru', phoneSelect, phoneHint),
    field('Wiersze danych', txt(num(t.data.length))),
    xlsx ? field('Arkusz', selectOf('arkusz', s.source.book.sheets.map((sheet, i) => option(i, sheet.name, i === s.source.sheet))))
      : field('Kodowanie znaków', txt(ENCODINGS[s.source.encoding] ?? s.source.encoding)),
    xlsx ? field('Format pliku', txt('Skoroszyt programu Excel (.xlsx)'))
      : field('Separator kolumn', selectOf('separator', [...new Set([...SEPARATOR_CHARS, s.source.separator])]
        .map((c) => option(separatorValue(c), SEPARATORS[c] ?? c, c === s.source.separator)))),
  ) + `<label class="check"><input type="checkbox" id="naglowek"${t.header ? ' checked' : ''}> Pierwszy wiersz zawiera nazwy kolumn</label>`
    + (stop ? `<p class="notice n-fail">${esc(stop)}</p>` : '');
  const head = `<tr>${t.columns.map((c, i) => `<th${i === s.phoneColumn ? ' class="ph"' : ''}>${esc(c)}</th>`).join('')}</tr>`;
  const body = t.data.slice(0, PREVIEW_ROWS).map((r) => `<tr>${r.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  const disabled = s.busy || s.done || !picked || stop !== null;
  return section('Rozpoznanie pliku', recognition)
    + section('Pierwsze wiersze danych', `<div class="scroll"><table>${head}${body}</table></div>`
      + note(`Agent zobaczy wyłącznie nazwy kolumn: ${t.columns.join(', ')}`)
      + buttons(button('Przekaż plik do bramki', { act: 'upload', kind: 'primary', disabled })))
    + renderProgress(s);
}

/** Odświeżanie postępu wysyłki z pliku: co 30 s, najwyżej 30 minut, jak w widoku rozsyłki. */
export const FILE_REFRESH_MS = 30_000;
export const FILE_REFRESH_MAX_MS = 1_800_000;
const LIVE_TEXT = { watching: '● na żywo, co 30 s', timeout: 'odświeżanie zatrzymane po 30 minutach' };

/** Powody wyłączenia wiersza w kolejności ze specyfikacji podglądu. */
const REASONS = [
  ['invalid_phone', 'błędny numer telefonu'], ['invalid_client_id', 'błędny identyfikator klienta'], ['empty_field', 'puste pole użyte w treści'],
  ['too_many_parts', 'treść ponad limit części integracji'], ['columns', 'wiersz niezgodny z nagłówkiem'],
];
const REASON_LABELS = Object.fromEntries(REASONS);

const recipientsWord = (n) => `${num(n)} ${pluralWord(n, 'odbiorcy', 'odbiorców', 'odbiorców')}`;
const partsWord = (n) => `${num(n)} ${pluralWord(n, 'część', 'części', 'części')}`;
const packagesIn = (n) => `${num(n)} ${pluralWord(n, 'rozsyłce', 'rozsyłkach', 'rozsyłkach')}`;
const foldColumn = (name) => String(name).trim().toLocaleLowerCase('pl-PL');

/** Treść z polami: pola {Nazwa kolumny} wyróżnione, pozostała treść jako tekst. */
export function templateMarkup(text) {
  const source = String(text ?? '');
  let out = '';
  let at = 0;
  for (const m of source.matchAll(/\{[^{}]*\}/g)) {
    out += `${esc(source.slice(at, m.index))}<span class="slot">${esc(m[0])}</span>`;
    at = m.index + m[0].length;
  }
  return out + esc(source.slice(at));
}

/** Kodowanie wysyłki słowami: rozsyłki GSM i Unicode powstają osobno. */
function encodingText(e) {
  if (e.ucs2 === 0) return 'GSM, bez polskich znaków';
  if (e.gsm === 0) return 'Unicode, z polskimi znakami';
  return `GSM: ${num(e.gsm)} ${pluralWord(e.gsm, 'SMS', 'SMS-y', 'SMS-ów')}, Unicode: ${num(e.ucs2)} ${pluralWord(e.ucs2, 'SMS', 'SMS-y', 'SMS-ów')}`;
}

/** Liczba części wszystkich SMS-ów: jedna liczba albo przedział. */
function partsRange(histogram) {
  const keys = Object.keys(histogram ?? {}).map(Number).filter((k) => histogram[k] > 0).sort((a, b) => a - b);
  if (keys.length === 0) return 'brak SMS-ów do wysłania';
  if (keys.length === 1) return `${num(histogram[keys[0]])} × ${partsWord(keys[0])}`;
  return `od ${keys[0]} do ${partsWord(keys[keys.length - 1])} w SMS-ie`;
}

/** Przełącznik gotowych wiadomości: numer wiersza w pliku każdej z nich. */
const sampleSwitch = (samples, current) => `<div class="seg2 narrow">${samples.map((x, i) => `<button type="button"${i === current ? ' class="on"' : ''} `
  + `data-act="sample" data-i="${i}">wiersz ${esc(x.line)}</button>`).join('')}</div>`;

function samplesSection(p, meta, state, sender) {
  const samples = meta.samples ?? [];
  if (samples.length === 0) return '';
  const current = Math.min(Math.max(0, state.sample ?? 0), samples.length - 1);
  const x = samples[current];
  const requested = state.input?.encoding ?? 'auto';
  const m = measure(x.text, requested);
  const body = esc(requested === 'gsm' ? latinText(x.text) : x.text);
  return section('Gotowe wiadomości', sampleSwitch(samples, current)
    + messageBox({ sender, counter: smsCounter({ characters: m.characters, parts: x.parts, encoding: m.encoding }), body })
    + note(`Odbiorca ${x.to}, wiersz ${x.line} w pliku`));
}

function settingsSection(p, meta, state, locked) {
  const service = (s) => (s.label === s.id ? s.id : `${s.label} (${s.id})`);
  const services = p.services.some((s) => s.id === p.serviceId) ? p.services : [...p.services, { id: p.serviceId, label: p.serviceId }];
  const columns = meta.columns ?? [];
  const wanted = state.input?.clientIdColumn;
  const chosen = wanted === undefined || wanted === null ? null : columns.find((c) => foldColumn(c) === foldColumn(wanted)) ?? null;
  return section('Ustawienia wysyłki', fields(
    wideField('Plik', txt(meta.name ?? '-')),
    field('Nadawca', select('orig', p.senders.map((s) => option(s.value ?? '', s.label, s.value === p.orig)), locked),
      p.orig === null ? 'Integracja, klucz i konto nie określają nadpisu domyślnego, dlatego SMS zostanie wysłany z numeru usługi, a odbiorca będzie mógł odpowiedzieć' : ''),
    field('Usługa Multiinfo', select('service', services.map((s) => option(s.id, service(s), s.id === p.serviceId)), locked)),
    field('Kolumna identyfikatora klienta', select('clientIdColumn',
      [option('', 'bez identyfikatora', chosen === null), ...columns.map((c) => option(c, c, c === chosen))], locked),
    'Wartość z tej kolumny trafia do raportu rozsyłki jako identyfikator klienta'),
    field('Kodowanie', txt(encodingText(p.encodings)),
      'Bramka dzieli odbiorców na rozsyłki według kodowania, dlatego polska litera w jednym wierszu nie zmienia kodowania pozostałych SMS-ów'),
    p.schedule ? scheduleField(p.schedule) : '',
  ));
}

function summarySection(p, meta) {
  const repeated = p.sameNumberDifferentText > 0
    ? `<p class="notice n-wait">Numery z różnymi treściami: ${esc(num(p.sameNumberDifferentText))}. Każdy z tych numerów otrzyma wszystkie przeznaczone dla niego SMS-y.</p>`
      + foldList('Lista numerów', (meta.repeatedNumbers ?? []).length, 'numer', 'numery', 'numerów',
        numbers((meta.repeatedNumbers ?? []).map((phone) => ({ phone })))) : '';
  return section('Podsumowanie', tiles(
    tile('Odbiorcy', num(p.recipients), 'po jednym SMS-ie'),
    tile('Części SMS razem', num(p.parts), partsRange(p.partsHistogram)),
    recipientsLeftTile(p.guard, 'w oknie ochrony'),
    tile('Podgląd ważny do', clock(p.expiresAt), 'potem nowy podgląd'),
  )
    + (p.packages > 0 ? note(`Bramka ${p.schedule ? 'zaplanuje' : 'wyśle'} SMS-y w ${packagesIn(p.packages)}. `
      + 'Każda rozsyłka obejmuje najwyżej 5000 odbiorców i jedno kodowanie, GSM albo Unicode.') : '')
    + (p.duplicates > 0 ? note(`Wiersze z tym samym numerem i tą samą treścią: ${num(p.duplicates)}. Bramka wyśle każdą taką wiadomość raz.`) : '')
    + (p.truncated > 0 ? note(`Wiadomości skrócone do limitu części integracji: ${num(p.truncated)}`) : '')
    + note(p.guard.resetsAt ? `Okno ochrony przed burzą kończy się o ${clock(p.guard.resetsAt)}` : 'Okno ochrony przed burzą otworzy się przy pierwszej wysyłce')
    + repeated);
}

/** Lista rozwijana na życzenie z liczbą pozycji w nagłówku: wiersze wyłączone, numery z różnymi treściami. */
const foldList = (title, count, one, few, many, body) => `<div class="inbox"><details class="it"><summary><div class="it-top"><b>${esc(title)}</b>`
  + `<span class="it-tag">${esc(num(count))} ${pluralWord(count, one, few, many)}</span></div></summary><div class="it-body">${body}</div></details></div>`;

/** Wartość z kolumny numeru w liście wyłączonych: „puste” dla pustej komórki, „-” dla wiersza niezgodnego z nagłówkiem. */
const phoneCell = (phone) => (phone === null || phone === undefined ? '-' : phone.trim() === '' ? 'puste' : phone);

/** Wiersze wyłączone: liczby według powodu i lista rozwijana z numerem wiersza i wartością numeru z pliku. */
function excludedSection(p, meta) {
  const total = REASONS.reduce((sum, [r]) => sum + (p.excluded[r] ?? 0), 0);
  if (total === 0) return '';
  const counts = REASONS.filter(([r]) => (p.excluded[r] ?? 0) > 0).map(([r, label]) => `${label} - ${num(p.excluded[r])} ${pluralWord(p.excluded[r], 'wiersz', 'wiersze', 'wierszy')}`).join(', ');
  const rows = meta.excludedRows ?? [];
  const list = rows.length === 0 ? '' : foldList('Lista wierszy wyłączonych', rows.length, 'wiersz', 'wiersze', 'wierszy', '<table><tr><th class="fit">Wiersz pliku</th><th class="fit">Numer w pliku</th><th>Powód</th></tr>'
    + rows.map((r) => `<tr><td class="fit">${esc(r.line)}</td><td class="fit">${esc(phoneCell(r.phone))}</td>`
      + `<td>${esc(REASON_LABELS[r.reason] ?? r.reason)}</td></tr>`).join('') + '</table>');
  const more = meta.excludedMore > 0 ? note(`Lista zawiera pierwsze ${num(rows.length)} wierszy. Pozostałe wiersze wyłączone: ${num(meta.excludedMore)}.`) : '';
  return section(`Wiersze wyłączone z wysyłki: ${num(total)}`, note(`Przyczyny: ${counts}`) + list + more);
}

/** Sekcja po wysyłce, zanim widok odczyta postęp: przyjęcie albo termin z anulowaniem. */
function sentFileSection(sent, state) {
  const repeated = sent.repeated ? note(REPEATED_NOTE) : '';
  if (state.cancelled) return section('Wysyłka', `<div class="sent">${esc(state.cancelled)}</div>${repeated}`);
  const head = `wysyłkę z pliku <span class="mono">${esc(sent.id)}</span> do ${esc(recipientsWord(sent.recipients))} w ${esc(packagesIn(sent.packages.length))}`;
  if (sent.schedule) {
    return section('Wysyłka', `<div class="sent">Zaplanowano ${head} na ${esc(stamp(sent.schedule.startAt))}</div>`
      + buttons(button('Anuluj wysyłkę', { act: 'cancel-file', kind: 'danger', disabled: state.busy === true })) + repeated);
  }
  return section('Wysyłka', `<div class="sent">Przyjęto ${head}</div>${repeated}`);
}

/**
 * HTML podglądu wysyłki z pliku według wyniku prepare_file_sms. `meta` to `_meta` wyniku: nazwa pliku, kolumny,
 * gotowe wiadomości i wiersze wyłączone. `state`: `input` dane wejściowe narzędzia z treścią z polami, `sample`
 * pokazana wiadomość, `busy` i `sending` w trakcie wywołania, `sent` wynik send_file_sms, `cancelled` tekst anulowania.
 */
export function renderFilePreview(p, meta = {}, state = {}) {
  const sent = state.sent ?? null;
  const busy = state.busy === true || state.sending === true;
  const locked = sent !== null || busy || !state.input;
  const sender = p.senders.find((s) => s.value === p.orig)?.label ?? p.orig ?? '';
  const template = state.input?.text;
  const content = section('Treść SMS-a z polami', messageBox({
    sender, counter: '', body: template === undefined ? '<span class="muted">Aplikacja AI nie przekazała widokowi treści z polami</span>' : templateMarkup(template),
  }) + note(p.fields.length > 0 ? `Pola w treści: ${p.fields.join(', ')}` : 'Treść nie zawiera pól, dlatego każdy odbiorca otrzyma tę samą treść'));
  const label = p.schedule ? `Zaplanuj wysyłkę do ${recipientsWord(p.recipients)}` : `Wyślij do ${recipientsWord(p.recipients)}`;
  const finish = sent ? sentFileSection(sent, state) : section('Zatwierdzenie',
    (p.blocked ? `<p class="notice n-fail">${esc(p.blocked)}</p>` : `<p class="say">${APPROVAL_TEXT}</p>`)
    + buttons(button(state.sending ? 'Wysyłanie…' : label, { act: 'send', kind: 'primary', disabled: busy || p.blocked !== null }),
      button('Popraw treść w rozmowie', { act: 'fix', disabled: busy })));
  return content + samplesSection(p, meta, state, sender) + settingsSection(p, meta, state, locked) + summarySection(p, meta) + excludedSection(p, meta) + finish;
}

/** Raport CSV wysyłki z pliku jest gotowy, dlatego stan nie zmieni się już sam z siebie. */
export const fileSettled = (d) => d.reportReady === true || d.cancelled === true;

/** Wszystkie rozsyłki czekają w bramce na termin albo na decyzję administratora. */
export const filePending = (d) => d.packages > 0 && Object.keys(d.byStatus ?? {}).every((s) => s === 'scheduled' || s === 'overdue');

const OVERDUE_TEXT = 'Bramka nie przekazała rozsyłek do Multiinfo w ciągu 60 minut od terminu. Decyzję o wysłaniu albo anulowaniu podejmuje administrator bramki.';

/**
 * Odświeżanie stanu wysyłki z pliku przez file_send_status co 30 s, do gotowego raportu, najwyżej 30 minut.
 * `handlers.onData` otrzymuje stan i `_meta`, a `handlers.onEnd` powód końca: settled, timeout albo error z tekstem.
 * Po błędzie połączenia `handlers.onRetry` otrzymuje szczegóły błędu, a odświeżanie ponawia odczyt.
 */
export function watchFileSend(bridge, win, id, handlers, now = () => Date.now()) {
  const started = now();
  async function tick() {
    let result;
    try {
      result = await bridge.callTool('file_send_status', { id });
    } catch (error) {
      // Błąd połączenia, na przykład przy restarcie bramki, nie przerywa odświeżania przed upływem 30 minut.
      if (retryable(error) && now() - started < FILE_REFRESH_MAX_MS) {
        handlers.onRetry?.(failure(error)[1]);
        win.setTimeout(tick, FILE_REFRESH_MS);
      } else handlers.onEnd('error', ...failure(error));
      return;
    }
    if (result.isError || !result.structuredContent) {
      handlers.onEnd('error', textOf(result), '');
      return;
    }
    handlers.onData(result.structuredContent, result._meta);
    if (fileSettled(result.structuredContent)) handlers.onEnd('settled');
    else if (now() - started >= FILE_REFRESH_MAX_MS) handlers.onEnd('timeout');
    else win.setTimeout(tick, FILE_REFRESH_MS);
  }
  win.setTimeout(tick, FILE_REFRESH_MS);
}

/** HTML postępu wysyłki z pliku według wyniku file_send_status; `state.name` nazwa pliku z `_meta`, `state.busy` w trakcie wywołania. */
export function renderFileProgress(d, state = {}) {
  const busy = state.busy === true;
  const head = section(`Wysyłka z pliku ${d.id}`, fields(
    field('Plik', txt(state.name ?? '-')), field('Przyjęta', txt(stamp(d.created.at))),
    field('Odbiorcy', txt(num(d.recipients))), field('Rozsyłki', txt(num(d.packages))),
  ));
  const refresh = button('Odśwież stan', { act: 'refresh', disabled: busy });
  const cancel = d.cancellable > 0 ? button('Anuluj wysyłkę', { act: 'cancel-file', kind: 'danger', disabled: busy }) : '';
  if (filePending(d)) {
    const scheduled = (d.byStatus.overdue ?? 0) === 0;
    return head + section(scheduled ? 'Zaplanowana wysyłka' : 'Termin minął', fields(
      d.schedule ? field('Zaplanowana na', txt(stamp(d.schedule.startAt.at))) : '',
      scheduled && d.schedule?.handoverAt ? field('Przekazanie do Multiinfo', txt(stamp(d.schedule.handoverAt.at))) : '',
    ) + note(scheduled ? CANCEL_WINDOW : OVERDUE_TEXT) + buttons(cancel, refresh));
  }
  const waiting = Math.max(0, d.recipients - d.delivered - d.failed - d.other - d.notSent);
  const states = Object.entries(d.byStatus).map(([s, n]) => `${d.statusLabels?.[s] ?? s} ${num(n)}`).join(', ');
  const undelivered = d.failed + d.other + d.notSent;
  return head + section('Postęp', stackBar([
    { tone: 'ok', value: d.delivered }, { tone: 'fail', value: d.failed }, { tone: 'plain', value: d.other + d.notSent }, { tone: 'wait', value: waiting },
  ])
    + tiles(
      tile('W trakcie', num(waiting), 'przed raportem'),
      tile('Doręczone', num(d.delivered), share(d.delivered, d.recipients), 'ok'),
      tile('Niedoręczone', num(d.failed), share(d.failed, d.recipients)),
      tile('Pozostałe', num(d.other), 'bez potwierdzenia'),
    )
    + note(`Rozsyłki według stanu: ${states}`)
    + (d.notSent > 0 ? note(`Odbiorcy rozsyłek anulowanych albo zakończonych błędem: ${num(d.notSent)}`) : '')
    + (d.cancelled === true ? note('Wysyłka została anulowana, dlatego raport doręczeń nie powstanie')
      : d.reportReady ? '' : note('Raport CSV wszystkich rozsyłek będzie dostępny po ich zakończeniu i odbiorze raportów doręczeń'))
    + buttons(
      d.reportReady ? button('Pobierz raport CSV', { act: 'csv', kind: 'primary', disabled: busy, data: { file: 'report' } }) : '',
      d.reportReady && undelivered > 0 ? button('Pobierz CSV niedoręczonych', { act: 'csv', disabled: busy, data: { file: 'failed' } }) : '',
      cancel, refresh,
    ));
}

/**
 * Podgląd i postęp wysyłki z pliku w elemencie `root`: przyjmuje wynik prepare_file_sms albo file_send_status,
 * tworzy nowe szkice po zmianie ustawień, wysyła z kluczem potwierdzenia, anuluje i odświeża postęp.
 */
export function mountFileSend(root, { bridge, say, win, live }) {
  const f = {
    input: null, preview: null, meta: {}, confirm: null, sample: 0, busy: false, sending: false, sent: null, cancelled: null,
    status: null, name: null, watching: false, retrying: false,
  };
  const draw = () => {
    if (f.status) root.innerHTML = renderFileProgress(f.status, { name: f.name, busy: f.busy });
    else if (f.preview) root.innerHTML = renderFilePreview(f.preview, f.meta, f);
  };
  const run = async (task) => {
    if (f.busy) return;
    // Komunikat działania pracownika zastępuje komunikat o ponowieniu odczytu i zostaje po udanym odczycie.
    f.retrying = false;
    f.busy = true;
    draw();
    try {
      await task();
    } catch (error) {
      say('fail', ...failure(error));
    } finally {
      f.busy = false;
      f.sending = false;
      draw();
    }
  };
  const retry = (detail) => {
    f.retrying = true;
    say('wait', retryText(FILE_REFRESH_MS), detail);
  };
  const end = (why, text, detail) => {
    f.watching = false;
    f.retrying = false;
    live.textContent = LIVE_TEXT[why] ?? '';
    if (why === 'error') say('fail', text, detail);
  };
  const watch = () => {
    // Wysyłka przed przekazaniem nie zmienia stanu przez wiele godzin, dlatego widok nie odświeża jej na żywo.
    if (f.watching || fileSettled(f.status) || filePending(f.status)) {
      if (!f.watching) live.textContent = '';
      return;
    }
    f.watching = true;
    live.textContent = LIVE_TEXT.watching;
    watchFileSend(bridge, win, f.status.id, {
      onData: (data, meta) => {
        if (f.retrying) {
          f.retrying = false;
          say('plain', '');
        }
        f.status = data;
        if (meta?.name) f.name = meta.name;
        draw();
      },
      onEnd: end,
      onRetry: retry,
    });
  };

  function showPreview(result) {
    Object.assign(f, {
      preview: result.structuredContent, meta: result._meta ?? {}, confirm: result._meta?.confirm ?? null, sample: 0, sent: null, cancelled: null, status: null,
    });
    f.name = f.meta.name ?? null;
    draw();
  }

  function showStatus(result) {
    f.status = result.structuredContent;
    if (result._meta?.name) f.name = result._meta.name;
    draw();
    watch();
  }

  /** Stan wysyłki po wysyłce, anulowaniu albo odświeżeniu; bez uprawnienia do odczytu widok zostaje przy wyniku wysyłki. */
  async function loadStatus(id) {
    const result = await bridge.callTool('file_send_status', { id });
    if (result.isError || !result.structuredContent) return say(f.sent ? 'plain' : 'fail', textOf(result));
    return showStatus(result);
  }

  const prepare = (changes) => run(async () => {
    if (f.input === null) return say('fail', 'Aplikacja AI nie przekazała widokowi danych wejściowych. Poproś agenta w rozmowie o zmianę.');
    const input = { ...f.input, ...changes };
    for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key];
    const result = await bridge.callTool('prepare_file_sms', input);
    if (result.isError) return say('fail', textOf(result));
    f.input = input;
    say('plain', '');
    return showPreview(result);
  });

  const send = () => run(async () => {
    f.sending = true;
    draw();
    const result = await bridge.callTool('send_file_sms', { draftId: f.preview.draftId, ...(f.confirm ? { confirm: f.confirm } : {}) });
    if (result.isError) return say('fail', textOf(result));
    f.sent = result.structuredContent;
    f.sending = false;
    say('plain', '');
    return loadStatus(f.sent.id);
  });

  const cancel = () => run(async () => {
    const id = f.status?.id ?? f.sent.id;
    const result = await bridge.callTool('cancel_package', { id });
    if (result.isError) return say('fail', textOf(result));
    if (f.status) await loadStatus(id);
    else f.cancelled = textOf(result);
    return say(result.structuredContent?.cancelled > 0 ? 'ok' : 'wait', textOf(result));
  });

  const fix = () => run(async () => {
    const sent = await bridge.sendMessage(FIX_MESSAGE);
    say(sent ? 'ok' : 'plain', sent ? forwardedText('Prośba o poprawę treści') : 'Napisz w rozmowie, co zmienić w treści SMS-a');
  });

  const download = (file) => run(async () => {
    const result = await bridge.callTool('package_report', { packageId: f.status.id, file });
    if (result.isError) return say('fail', textOf(result));
    return openDownload(bridge, say, result.structuredContent);
  });

  return {
    /** Dane wejściowe narzędzia: treść z polami podglądu albo identyfikator wysyłki. */
    input(args) {
      f.input = args;
    },
    /** Wynik narzędzia przekazany przez aplikację; false, gdy wynik nie dotyczy podglądu ani postępu. */
    show(result) {
      const sc = result.structuredContent;
      if (!sc) return false;
      if ('excluded' in sc && 'draftId' in sc) showPreview(result);
      else if ('byStatus' in sc) showStatus(result);
      else return false;
      say('plain', '');
      return true;
    },
    click(act, button) {
      if (act === 'sample') {
        f.sample = Number(button.dataset.i);
        draw();
      } else if (act === 'send') send();
      else if (act === 'fix') fix();
      else if (act === 'cancel-file') cancel();
      else if (act === 'refresh') run(() => loadStatus(f.status.id));
      else if (act === 'csv') download(button.dataset.file);
    },
    change(t) {
      if (t.name === 'orig') prepare({ orig: t.value === '' ? null : t.value });
      else if (t.name === 'service') prepare({ serviceId: t.value });
      else if (t.name === 'clientIdColumn') prepare({ clientIdColumn: t.value === '' ? undefined : t.value });
      else return false;
      return true;
    },
  };
}

/**
 * Uruchomienie widoku: wybór pliku, odczyt, rozpoznanie, przekazanie porcjami i wiadomość do rozmowy, a z wynikiem
 * prepare_file_sms albo file_send_status podgląd albo postęp wysyłki z pliku.
 */
export function startFile(win, env) {
  const doc = win.document;
  const root = doc.getElementById('tresc');
  const say = sayIn(doc);
  const s = { name: '', source: null, rows: [], table: null, phoneColumn: null, busy: false, done: false, progress: null };

  root.innerHTML = '<div class="align">' + section('Plik z odbiorcami', fields(
    field('Plik CSV, TXT albo XLSX', PICKER),
    field('Limity pliku', txt(`${num(ROWS_MAX)} wierszy danych i ${FILE_BYTES_MAX / 1024 / 1024} MB`)),
  )) + '<div id="stan"></div></div>';
  const state = doc.getElementById('stan');
  const draw = () => {
    state.innerHTML = s.table ? renderLoaded(s) : '';
  };

  let sending = null;
  const bridge = createBridge(win, {
    version: env.version,
    onContext: (context) => applyTheme(doc, context),
    onToolInput: (args) => {
      sending.input(args);
      // Podgląd i postęp zastępują pole wyboru pliku już przy danych wejściowych narzędzia.
      if (typeof args.text === 'string') root.innerHTML = '<p class="muted">Oczekiwanie na podgląd wysyłki z pliku z bramki</p>';
      else if (typeof args.id === 'string') root.innerHTML = '<p class="muted">Oczekiwanie na stan wysyłki z pliku z bramki</p>';
    },
    onToolResult: (result) => {
      if (result.isError) return say('fail', textOf(result));
      return sending.show(result);
    },
    onToolCancelled: (reason) => say('wait', cancelledText(reason)),
  });
  sending = mountFileSend(root, { bridge, say, win, live: doc.getElementById('na-zywo') });

  /** Nowe rozpoznanie tabeli; wybrana wcześniej kolumna numeru zostaje, gdy `keep` i kolumna istnieje. */
  function apply(table, keep = false) {
    const previous = s.phoneColumn;
    s.table = table;
    s.phoneColumn = table.phoneCandidates.length === 1 ? table.phoneCandidates[0] : null;
    if (keep && previous !== null && previous < table.columns.length) s.phoneColumn = previous;
    s.done = false;
    s.progress = null;
    draw();
  }

  /** Numer kolejnego wyboru pliku: odczyt wcześniejszego pliku, który skończy się później, nie zmienia rozpoznania. */
  let picks = 0;

  async function read(picked) {
    picks += 1;
    const pick = picks;
    Object.assign(s, { name: picked.name, source: null, rows: [], table: null, phoneColumn: null, done: false, progress: null });
    const name = doc.getElementById('plik-nazwa');
    name.textContent = picked.name;
    name.className = 'pick-name set';
    draw();
    if (picked.size > FILE_BYTES_MAX) return say('fail', FILE_TOO_BIG);
    say('wait', 'Widok odczytuje plik');
    const bytes = new Uint8Array(await picked.arrayBuffer());
    if (pick !== picks) return undefined;
    const result = await readFileBytes(picked.name, bytes);
    if (pick !== picks) return undefined;
    if ('error' in result) return say('fail', result.error);
    s.source = result;
    s.rows = result.rows;
    apply(analyze(s.rows));
    return say('plain', '');
  }

  /** Pole wyboru pliku jest wyłączone w trakcie przekazywania, dlatego plik nie zmienia się w połowie przesyłania. */
  const lockPicker = (locked) => {
    doc.getElementById('plik').disabled = locked;
  };

  async function upload() {
    const t = s.table;
    s.busy = true;
    lockPicker(true);
    s.done = false;
    s.progress = { sent: 0, total: t.data.length };
    say('wait', 'Widok przekazuje plik do bramki');
    draw();
    try {
      const wait = (ms) => new Promise((resolve) => win.setTimeout(resolve, ms));
      const result = await transferFile(bridge, { name: s.name, columns: t.columns, phoneColumn: s.phoneColumn, rows: t.data }, {
        wait,
        onChunk: (c) => {
          if (c.retried) return say('wait', 'Bramka wstrzymała przekazywanie z powodu limitu żądań klucza. Widok wznowi je automatycznie.');
          s.progress = { sent: c.offset + c.rows, total: t.data.length };
          say('wait', 'Widok przekazuje plik do bramki');
          return draw();
        },
      });
      if (result.error !== null) return say('fail', result.error);
      s.done = true;
      return say(result.forwarded ? 'ok' : 'plain', result.forwarded
        ? forwardedText('Informacja o wczytaniu pliku') : 'Bramka przyjęła plik. Napisz w rozmowie, jaką treść SMS-a przygotować.');
    } catch (error) {
      return say('fail', ...failure(error));
    } finally {
      s.busy = false;
      lockPicker(false);
      draw();
    }
  }

  const fail = (error) => say('fail', ...failure(error));

  root.addEventListener('change', (event) => {
    const t = event.target;
    if (sending.change(t)) return undefined;
    // Podczas przekazywania widok nie zmienia pliku ani rozpoznania. Pole wyboru wraca do stanu bez wyboru,
    // dzięki czemu ponowny wybór tego samego pliku po przekazaniu wywoła zdarzenie.
    if (s.busy) {
      if (t.id === 'plik') t.value = '';
      return draw();
    }
    if (t.id === 'plik') {
      if (t.files && t.files.length > 0) void read(t.files[0]).catch(fail);
    } else if (t.id === 'arkusz' && s.source?.kind === 'xlsx') {
      try {
        s.source = { ...s.source, sheet: Number(t.value) };
        s.rows = readSheet(s.source.book, s.source.sheet);
        apply(analyze(s.rows));
      } catch (error) {
        fail(error);
      }
    } else if (t.id === 'separator' && s.source?.kind === 'csv') {
      const separator = separatorChar(t.value);
      s.source = { ...s.source, separator };
      s.rows = parseCsv(s.source.text, separator);
      apply(analyze(s.rows));
    } else if (t.id === 'naglowek' && s.table) apply(analyze(s.rows, { header: t.checked }), true);
    else if (t.id === 'numer' && s.table) {
      s.phoneColumn = t.value === '' ? null : Number(t.value);
      s.done = false;
      s.progress = null;
      draw();
    }
    return undefined;
  });
  root.addEventListener('click', (event) => {
    const target = event.target.closest?.('button[data-act]');
    if (!target || target.disabled) return;
    if (target.dataset.act !== 'upload') {
      sending.click(target.dataset.act, target);
      return;
    }
    if (s.table === null || s.busy || s.done || s.phoneColumn === null || blocker(s.table) !== null) return;
    void upload();
  });
}
