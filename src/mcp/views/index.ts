import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPE_LABELS } from '../../agents/scopes.ts';
import { esc } from '../../admin/views/layout.ts';
import { GATE_VERSION } from '../../version.ts';
import { APP_MIME } from '../apps.ts';
import { VIEW_STYLE } from './style.ts';

/** Widoki MCP Apps bramki. */
export type ViewId = 'wysylka' | 'grupa' | 'przebieg' | 'co-moge' | 'kampania' | 'rozsylka' | 'odpowiedzi' | 'plik' | 'rozmowa';

export const viewUri = (id: ViewId): string => `ui://multiinfo-gate/${id}`;

interface ViewDef {
  title: string;
  /** Pliki z `client/` po moście, w kolejności wklejenia; pliki dzielą jeden moduł, więc nazwy nie mogą się powtarzać. */
  files: readonly string[];
  /** Funkcja uruchamiająca widok, `(win, env)`, z jednego z plików. */
  entry: string;
  /** Przyciski w nagłówku widoku. */
  tools: string;
  body: string;
}

const REFRESH = '<button type="button" id="odswiez" class="btn">Odśwież</button>';
const NOTICE = '<div class="foot"><p id="komunikat" class="notice" role="status" hidden></p></div>';
const waiting = (text: string) => `<main id="tresc" class="body"><p class="muted">${text}</p></main>${NOTICE}`;

const VIEWS: Partial<Record<ViewId, ViewDef>> = {
  'co-moge': {
    title: 'Co mogę?',
    files: ['co-moge.js'],
    entry: 'start',
    tools: '<button type="button" id="odswiez" class="btn">Odśwież</button>',
    body: waiting('Oczekiwanie na dane połączenia z bramki'),
  },
  wysylka: { title: 'Wysyłka SMS', files: ['measure.js', 'doreczenia.js', 'send.js'], entry: 'startSend', tools: '', body: waiting('Oczekiwanie na podgląd SMS-a z bramki') },
  grupa: { title: 'SMS do grupy', files: ['measure.js', 'doreczenia.js', 'send.js', 'grupa.js'], entry: 'startGroup', tools: '', body: waiting('Oczekiwanie na podgląd SMS-a do grupy z bramki') },
  przebieg: {
    title: 'Przebieg doręczenia', files: ['measure.js', 'doreczenia.js', 'send.js', 'przebieg.js'], entry: 'startTrace',
    tools: REFRESH, body: waiting('Oczekiwanie na przebieg doręczenia z bramki'),
  },
  kampania: {
    title: 'Wyniki kampanii', files: ['chart.js', 'kampania.js'], entry: 'startCampaign', tools: REFRESH, body: waiting('Oczekiwanie na wyniki kampanii z bramki'),
  },
  rozsylka: {
    title: 'Postęp rozsyłki', files: ['chart.js', 'doreczenia.js', 'rozsylka.js'], entry: 'startPackage',
    tools: `<span id="na-zywo" class="live" role="status"></span>${REFRESH}`, body: waiting('Oczekiwanie na stan rozsyłki z bramki'),
  },
  odpowiedzi: {
    title: 'Odpowiedzi klientów', files: ['measure.js', 'odpowiedzi.js'], entry: 'startReplies', tools: REFRESH, body: waiting('Oczekiwanie na odebrane SMS-y z bramki'),
  },
  plik: {
    title: 'Rozsyłka z pliku', files: ['measure.js', 'chart.js', 'doreczenia.js', 'send.js', 'plik-csv.js', 'plik-xlsx.js', 'plik-tabela.js', 'plik.js'],
    entry: 'startFile', tools: '<span id="na-zywo" class="live" role="status"></span>', body: waiting('Oczekiwanie na widok rozsyłki z pliku'),
  },
  rozmowa: {
    title: 'Rozmowa z numerem', files: ['rozmowa.js'], entry: 'startConversation',
    tools: `<span id="na-zywo" class="live" role="status"></span>${REFRESH}`, body: waiting('Oczekiwanie na rozmowę z bramki'),
  },
};

/** Widoki, które mają dokument; tylko je wymienia `resources/list`. */
export const BUILT_VIEWS = Object.keys(VIEWS) as ViewId[];

/** Widok nie pobiera niczego z zewnątrz: aplikacja dostaje pustą listę domen dla połączeń i zasobów. */
const RESOURCE_UI = { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true };

export const viewMeta = (): Record<string, unknown> => ({ ui: structuredClone(RESOURCE_UI) });

export function viewResources(): Array<{ uri: string; name: string; title: string; mimeType: string; _meta: Record<string, unknown> }> {
  return BUILT_VIEWS.map((id) => ({ uri: viewUri(id), name: id, title: VIEWS[id]!.title, mimeType: APP_MIME, _meta: viewMeta() }));
}

/** Widok o adresie `ui://multiinfo-gate/<id>`, jeżeli ma dokument. */
export function viewByUri(uri: unknown): ViewId | null {
  return BUILT_VIEWS.find((id) => viewUri(id) === uri) ?? null;
}

/** Pliki dokumentu widoku w kolejności wklejenia: most i pliki widoku. */
export function viewFiles(id: ViewId): string[] {
  const def = VIEWS[id];
  if (!def) throw new Error(`Widok ${id} nie ma dokumentu.`);
  return ['bridge.js', ...def.files];
}

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'client');
const sources = new Map<string, string>();
const documents = new Map<ViewId, string>();

/** Plik logiki widoku bez wierszy `import`: w dokumencie wszystkie pliki dzielą jeden moduł. */
function client(file: string): string {
  let source = sources.get(file);
  if (source === undefined) {
    source = readFileSync(join(CLIENT_DIR, file), 'utf8').replace(/^import\s[^;]*;\n/gm, '');
    if (/<\/script/i.test(source)) throw new Error(`Plik widoku ${file} zawiera znacznik zamykający script.`);
    sources.set(file, source);
  }
  return source;
}

/** JSON wklejony do skryptu: `<` zapisany kodem, żeby treść nie mogła zamknąć elementu script. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/** Dokument widoku: style, nagłówek z przyciskami widoku, most i logika widoku w jednym module. */
export function viewHtml(id: ViewId): string {
  const cached = documents.get(id);
  if (cached !== undefined) return cached;
  const def = VIEWS[id];
  if (!def) throw new Error(`Widok ${id} nie ma dokumentu.`);
  const env = { version: GATE_VERSION, scopes: SCOPE_LABELS };
  const script = [...viewFiles(id).map(client), `${def.entry}(window, ${scriptJson(env)});`].join('\n');
  const html = '<!doctype html><html lang="pl"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${esc(def.title)} - Multiinfo Gate</title><style>${VIEW_STYLE}</style></head><body>`
    + '<header class="head"><div class="brand"><span class="dot">●</span> <b>Multiinfo Gate</b> '
    + `${esc(GATE_VERSION)} · ${esc(def.title)}</div>`
    + `<div class="tools">${def.tools}</div></header>`
    + `${def.body}<script type="module">${script}</script></body></html>`;
  documents.set(id, html);
  return html;
}
