import { PRIVATE_TARGET_MESSAGE, systemResolver, webhookTarget, type Resolver } from '../net/private-address.ts';
import type { InboundConfig } from './config.ts';
import { TemplateEngine } from './templates.ts';

export type EnrichConfig = NonNullable<InboundConfig['enrich']>;

/** Odpowiedź czytamy do tylu bajtów; kartoteka klienta mieści się w tym z zapasem. */
export const READ_LIMIT = 256 * 1024;

/** Nazwy zajęte w kontekście szablonu - pole `as` nie może ich przykryć. */
const ZAJETE = new Set(['p', 'now', 'integration']);

export type EnrichResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

export type EnrichGet = (url: string, headers: Record<string, string>, method: 'GET' | 'POST', timeoutMs: number)
  => Promise<{ status: number; body: string }>;

export interface EnrichOptions {
  config: EnrichConfig;
  secrets: Record<string, string>;
  context: Record<string, unknown>;
  engine: TemplateEngine;
  resolve?: Resolver;
  get?: EnrichGet;
  /** MIG_WEBHOOK_ALLOW_PRIVATE: zgoda na pytanie aplikacji w sieci wewnętrznej, jak przy webhookach. */
  allowPrivate?: boolean;
}

/**
 * Bez przekierowań: przekierowanie mogłoby zaprowadzić żądanie z sekretem w sieć wewnętrzną.
 * Odpowiedź czytamy strumieniem z licznikiem, a nie w całości do pamięci: aplikacja, która
 * odpowiada bez końca, ma zająć `READ_LIMIT` bajtów, a nie tyle, ile zdąży wysłać do czasu odcięcia.
 */
export const httpGet: EnrichGet = async (url, headers, method, timeoutMs) => {
  const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  const zapowiedziane = Number(res.headers.get('content-length'));
  if (Number.isFinite(zapowiedziane) && zapowiedziane > READ_LIMIT) {
    await res.body?.cancel();
    return { status: res.status, body: '' };
  }
  if (res.body === null) return { status: res.status, body: '' };
  const reader = res.body.getReader();
  const dekoder = new TextDecoder();
  let body = '';
  let przeczytane = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      przeczytane += value.byteLength;
      body += dekoder.decode(value, { stream: true });
      if (przeczytane >= READ_LIMIT) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  // Ostatni kawałek bywa większy niż to, czego brakowało do limitu, więc przycinamy na koniec.
  return { status: res.status, body: body.slice(0, READ_LIMIT) };
};

/**
 * Jedno pytanie do aplikacji o pole, którego nie ma w ładunku. Bez łańcuchów, bez ponowień.
 * Sekrety podstawiane poza silnikiem szablonów, tak samo jak w dostawie wychodzącej: szablon
 * ich nie widzi, więc nie wyciekną przez treść SMS-a ani przez podgląd.
 */
export async function enrich(opts: EnrichOptions): Promise<EnrichResult> {
  const { config, secrets, context, engine } = opts;
  if (ZAJETE.has(config.as)) return { ok: false, reason: `nazwa ${config.as} jest zajęta w kontekście szablonu` };

  let url: string;
  try {
    url = engine.render(config.url, context).trim();
  } catch (e) {
    return { ok: false, reason: `adres zapytania: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (url === '') return { ok: false, reason: 'adres zapytania wyszedł pusty' };

  let adres: URL;
  try {
    adres = new URL(url);
  } catch {
    return { ok: false, reason: 'adres zapytania nie jest poprawnym adresem' };
  }
  if (adres.protocol !== 'https:' && adres.protocol !== 'http:') {
    return { ok: false, reason: 'adres zapytania musi zaczynać się od https:// albo http://' };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  try {
    for (const q of config.query) {
      adres.searchParams.set(q.name, q.valueRef !== undefined ? (secrets[q.valueRef] ?? '') : engine.render(q.value ?? '', context));
    }
    for (const h of config.headers) {
      headers[h.name] = h.valueRef !== undefined ? (secrets[h.valueRef] ?? '') : engine.render(h.value ?? '', context);
    }
  } catch (e) {
    return { ok: false, reason: `parametry zapytania: ${e instanceof Error ? e.message : String(e)}` };
  }

  const target = await webhookTarget(adres.toString(), opts.resolve ?? systemResolver);
  if (target.kind === 'private' && opts.allowPrivate !== true) return { ok: false, reason: `${PRIVATE_TARGET_MESSAGE} (${target.address})` };
  if (target.kind === 'unresolved') return { ok: false, reason: `nazwa nie rozwiązuje się: ${target.reason}` };

  let odpowiedz: { status: number; body: string };
  try {
    odpowiedz = await (opts.get ?? httpGet)(adres.toString(), headers, config.method, config.timeoutMs);
  } catch (e) {
    return { ok: false, reason: `zapytanie nie doszło do skutku: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Treść odpowiedzi błędnej nie idzie dalej: bywa w niej szczegół konta, a wpis w dzienniku
  // widzi każdy administrator bramki.
  if (odpowiedz.status < 200 || odpowiedz.status >= 300) return { ok: false, reason: `aplikacja odpowiedziała kodem ${odpowiedz.status}` };

  try {
    return { ok: true, value: JSON.parse(odpowiedz.body) };
  } catch {
    return { ok: false, reason: 'odpowiedź aplikacji nie jest JSON-em' };
  }
}

/**
 * Adres do dziennika: bez części zapytania, bo tam siedzą tokeny. Obcinamy tekstem, nie przez
 * `URL`, żeby administrator zobaczył swój adres tak, jak go wpisał - z klamrami szablonu, a nie
 * z `%7B%7B`. Wszystko od pierwszego znaku zapytania odpada, więc token nie ma którędy wyjść.
 */
export function safeUrl(url: string): string {
  const bez = url.split('?')[0]!.trim();
  return bez === '' ? '(adres nie do odczytania)' : bez;
}
