import { Liquid, type LiquidOptions } from 'liquidjs';
import { normalizePhone } from '../text/phone.ts';
import { warsawStamp } from '../time/warsaw.ts';

export const RENDER_LIMIT_MS = 100;
export const OUTPUT_LIMIT_CHARS = 4096;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** Polskie znaki na łacińskie odpowiedniki - SMS mieści wtedy 160 znaków zamiast 70. */
const GSM_MAP: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z',
};
export const toGsm = (text: string): string => text.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (c) => GSM_MAP[c] ?? c);

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

/**
 * HTML z helpdesku na tekst do SMS-a: koniec bloku i `<br>` to spacja (samo `strip_html` skleja
 * „rozwiązana.Pozdrawiam”), znaczniki znikają, podstawowe encje wracają do znaków, białe znaki zbite.
 */
export function htmlText(html: string): string {
  return html
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|td|th)>|<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Czas w Polsce po ludzku: `DD.MM.RRRR GG:MM`. */
function datePl(iso: string): string {
  const s = warsawStamp(iso);
  return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} ${s.slice(11, 16)}`;
}

const noFiles = (): never => { throw new TemplateError('Znaczniki include i render są wyłączone.'); };

/**
 * Liquid w trybie bez dostępu do niczego poza kontekstem: brak systemu plików (include i render
 * odrzucane przy walidacji, a przemycone padają na atrapie fs), ścisłe filtry (literówka to błąd
 * zapisu, nie pusty SMS), łagodne zmienne (ładunki obcych aplikacji bywają nierówne). Limity
 * chronią worker przed szablonem, który zapętla się na tablicy z tysiącem alertów.
 */
export class TemplateEngine {
  private readonly liquid: Liquid;

  constructor(opts: { countryCode?: string } = {}) {
    const countryCode = opts.countryCode ?? '48';
    const options: LiquidOptions = {
      strictFilters: true,
      strictVariables: false,
      ownPropertyOnly: true,
      renderLimit: RENDER_LIMIT_MS,
      memoryLimit: 4 * 1024 * 1024,
      relativeReference: false,
      fs: {
        readFileSync: noFiles,
        readFile: async () => noFiles(),
        existsSync: () => false,
        exists: async () => false,
        resolve: () => '',
        contains: async () => false,
        containsSync: () => false,
      },
    };
    this.liquid = new Liquid(options);
    this.liquid.registerFilter('gsm', (v: unknown) => toGsm(String(v ?? '')));
    this.liquid.registerFilter('phone', (v: unknown) => {
      const raw = String(v ?? '');
      try {
        return normalizePhone(raw.replace(/^\s*00/, ''), countryCode);
      } catch {
        return raw;
      }
    });
    this.liquid.registerFilter('sms_truncate', (v: unknown, n: unknown) => {
      const text = String(v ?? '');
      const limit = Math.max(1, Number(n) || 160);
      const chars = [...text];
      return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`;
    });
    this.liquid.registerFilter('html_text', (v: unknown) => htmlText(String(v ?? '')));
    this.liquid.registerFilter('date_pl', (v: unknown) => {
      const time = Date.parse(String(v ?? ''));
      return Number.isNaN(time) ? String(v ?? '') : datePl(new Date(time).toISOString());
    });
  }

  /** Komunikat błędu składni po polsku z numerem linii, albo null. */
  validate(template: string): string | null {
    if (/{%-?\s*(include|render)\b/.test(template)) return 'Znaczniki include i render są wyłączone.';
    try {
      this.liquid.parse(template);
      return null;
    } catch (e) {
      return describe(e);
    }
  }

  render(template: string, context: Record<string, unknown>): string {
    let out: unknown;
    try {
      out = this.liquid.parseAndRenderSync(template, context);
    } catch (e) {
      throw new TemplateError(describe(e));
    }
    const text = String(out ?? '');
    if (text.length > OUTPUT_LIMIT_CHARS) throw new TemplateError(`Wynik szablonu ma ${text.length} znaków, dozwolone ${OUTPUT_LIMIT_CHARS}.`);
    return text;
  }
}

/** Błędy liquidjs niosą `line`/`col` w polu `token`; z nich składamy komunikat dla panelu. */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { originalError?: unknown }).originalError;
  if (cause instanceof TemplateError) return cause.message;
  const token = (e as { token?: { getPosition?: () => number[] } }).token;
  const pos = token?.getPosition?.();
  const where = pos && pos.length >= 2 ? ` (linia ${pos[0]}, kolumna ${pos[1]})` : '';
  const message = e.message.replace(/, line:\d+, col:\d+/g, '').replace(/, file:.*$/, '');
  return `${message}${where}`;
}
