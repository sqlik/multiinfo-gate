// Domeny skracacza: zapis, wyłączenie, usunięcie i sprawdzenie domeny (spec 4). Panel woła usługę
// z tras „Skracacz linków”, a w 1.12 także serwer MCP.
import { promises as dns } from 'node:dns';
import { domainToASCII } from 'node:url';
import type { PanelUser } from '../m365/service.ts';
import type { AuditRepo } from '../store/audit.ts';
import type { LinkDomainInput, LinkDomainsRepo } from '../store/link-domains.ts';
import type { ShortLinksRepo } from '../store/short-links.ts';
import { warsawStamp } from '../time/warsaw.ts';
import type { DomainChecks } from './domain-checks.ts';

export type DomainCheckStep = 'dns' | 'connect' | 'tls' | 'response';
export interface DomainCheckResult { ok: boolean; step?: DomainCheckStep; detail?: string }

export interface DomainServiceDeps {
  linkDomains: LinkDomainsRepo;
  shortLinks: Pick<ShortLinksRepo, 'domainPurgeAfter'>;
  audit: AuditRepo;
  checks: DomainChecks;
  lookup?: (host: string) => Promise<unknown>;
  fetch?: typeof fetch;
}

/** Błąd z tekstem do pokazania w panelu. */
export class LinkDomainError extends Error {}

const CHECK_TIMEOUT_MS = 10_000;
/** Odpowiedź z tokenem ma kilkadziesiąt bajtów; dłuższej treści sprawdzenie nie czyta do końca. */
const MAX_BODY = 4096;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLS_CODE = /^(?:CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$)/;
const STEPS: readonly DomainCheckStep[] = ['dns', 'connect', 'tls', 'response'];

const INVALID = 'Wpisz poprawną nazwę domeny, na przykład l.firma.pl albo firma-link.pl';

/** Domena w postaci zapisu: małe litery, bez kropki na końcu, nazwy z polskimi znakami w postaci xn--. */
export function normalizeDomain(raw: string): string {
  const d = raw.trim();
  if (d === '') throw new LinkDomainError('Podaj domenę skracacza, na przykład l.firma.pl');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(d) || /[/?#\\]/.test(d)) {
    throw new LinkDomainError('Wpisz samą domenę, bez https:// i bez ścieżki, na przykład l.firma.pl');
  }
  if (d.includes(':')) {
    throw new LinkDomainError('Wpisz domenę bez portu, na przykład l.firma.pl. Port przekierowań wystawia serwer pośredniczący pod portem 443');
  }
  const ascii = domainToASCII(d.replace(/\.$/, ''));
  const labels = ascii.split('.');
  if (ascii === '' || ascii.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1)!)) {
    throw new LinkDomainError(INVALID);
  }
  return ascii;
}

function normalizeInput(input: LinkDomainInput): LinkDomainInput {
  const displayName = input.displayName.trim();
  if (displayName === '') throw new LinkDomainError('Podaj nazwę wyświetlaną, na przykład nazwę firmy');
  if (displayName.length > 100) throw new LinkDomainError('Nazwa wyświetlana może mieć najwyżej 100 znaków');
  const home = (input.homeUrl ?? '').trim();
  let homeUrl: string | null = null;
  if (home !== '') {
    if (home.length > 2000) throw new LinkDomainError('Adres strony głównej może mieć najwyżej 2000 znaków');
    const url = URL.canParse(home) ? new URL(home) : null;
    if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      throw new LinkDomainError('Adres strony głównej musi zaczynać się od https:// albo http://, na przykład https://firma.pl');
    }
    homeUrl = home;
  }
  return { domain: normalizeDomain(input.domain), displayName, homeUrl, bareLinks: input.bareLinks };
}

/** Kod błędu z łańcucha przyczyn: `fetch` z Node zgłasza `TypeError: fetch failed` z kodem w `cause`. */
function codeOf(error: unknown): string | undefined {
  let e: unknown = error;
  for (let i = 0; i < 4 && e !== null && typeof e === 'object'; i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Krok sprawdzenia, na którym zatrzymał się błąd połączenia. */
export function stepOf(error: unknown): { step: DomainCheckStep; detail: string } {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return { step: 'connect', detail: 'timeout' };
  const code = codeOf(error);
  if (code === undefined) return { step: 'connect', detail: 'error' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return { step: 'dns', detail: code };
  if (TLS_CODE.test(code)) return { step: 'tls', detail: code };
  return { step: 'connect', detail: code };
}

/** Wynik zapisany przy domenie (`check_detail`): krok i szczegół rozdzielone spacją. */
export function parseCheckDetail(stored: string | null): { step: DomainCheckStep; detail: string } | null {
  if (stored === null) return null;
  const [step, ...rest] = stored.split(' ');
  return STEPS.includes(step as DomainCheckStep) ? { step: step as DomainCheckStep, detail: rest.join(' ') } : null;
}

async function readLimited(response: Response): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const minute = (iso: string) => warsawStamp(iso).slice(0, 16);

export class LinkDomainService {
  private readonly lookup: (host: string) => Promise<unknown>;
  private readonly fetch: typeof fetch;

  constructor(private readonly deps: DomainServiceDeps) {
    this.lookup = deps.lookup ?? ((host) => dns.lookup(host));
    this.fetch = deps.fetch ?? globalThis.fetch;
  }

  create(input: LinkDomainInput, user: PanelUser, now: Date): number {
    const v = normalizeInput(input);
    this.assertFree(v.domain, null);
    const id = this.deps.linkDomains.create(v, now);
    this.record(user, 'skracacz.domena.utworzenie', id, { domain: v.domain, displayName: v.displayName, homeUrl: v.homeUrl, bareLinks: v.bareLinks });
    return id;
  }

  update(id: number, input: LinkDomainInput, user: PanelUser, now: Date): void {
    const row = this.must(id);
    const v = normalizeInput(input);
    const renamed = v.domain !== row.domain;
    if (renamed) {
      this.assertFree(v.domain, id);
      if (this.deps.shortLinks.domainPurgeAfter(id) !== null) {
        throw new LinkDomainError(`Zmiana nazwy domeny nie jest możliwa, ponieważ wysłane SMS-y zawierają linki domeny ${row.domain}. `
          + 'Dodaj nową domenę, a tę wyłącz, gdy przestanie być potrzebna');
      }
    }
    this.deps.linkDomains.update(id, v, now);
    if (renamed) this.deps.linkDomains.clearCheck(id);
    this.record(user, 'skracacz.domena.zmiana', id, {
      domain: v.domain, ...(renamed ? { previous: row.domain } : {}), displayName: v.displayName, homeUrl: v.homeUrl, bareLinks: v.bareLinks,
    });
  }

  setEnabled(id: number, enabled: boolean, user: PanelUser, now: Date): void {
    const row = this.must(id);
    this.deps.linkDomains.setEnabled(id, enabled, now);
    this.record(user, enabled ? 'skracacz.domena.wlaczenie' : 'skracacz.domena.wylaczenie', id, { domain: row.domain });
  }

  /** Błąd, gdy domena jest przypisana do klucza albo ma kody przed retencją; panel podaje wtedy datę, od której usunięcie będzie możliwe, i proponuje wyłączenie. */
  remove(id: number, user: PanelUser, _now: Date): void {
    const row = this.must(id);
    const keys = this.deps.linkDomains.keysUsing(id);
    if (keys.length > 0) {
      const names = keys.map((k) => k.name).join(', ');
      throw new LinkDomainError(`Domena ${row.domain} jest przypisana do ${keys.length === 1 ? 'klucza' : 'kluczy'} ${names}. `
        + 'Usunięcie będzie możliwe po odpięciu domeny w ustawieniach skracania klucza. Do tego czasu domenę można wyłączyć');
    }
    const last = this.deps.shortLinks.domainPurgeAfter(id);
    if (last !== null) {
      throw new LinkDomainError(`Usunięcie domeny będzie możliwe od ${minute(last)}, gdy bramka usunie dane wysłanych linków. `
        + 'Do tego czasu domenę można wyłączyć');
    }
    this.deps.linkDomains.remove(id);
    this.record(user, 'skracacz.domena.usuniecie', id, { domain: row.domain });
  }

  async check(id: number, user: PanelUser, now: Date): Promise<DomainCheckResult> {
    const row = this.must(id);
    const token = this.deps.checks.issue(id, now);
    const result = await this.probe(row.domain, token);
    this.deps.linkDomains.setCheck(id, result.ok, result.ok ? null : `${result.step} ${result.detail}`, now);
    this.record(user, 'skracacz.domena.sprawdzenie', id, { domain: row.domain, ...result });
    return result;
  }

  private async probe(domain: string, token: string): Promise<DomainCheckResult> {
    try {
      await this.lookup(domain);
    } catch (error) {
      return { ok: false, step: 'dns', detail: codeOf(error) ?? 'error' };
    }
    try {
      const response = await this.fetch(`https://${domain}/.well-known/multiinfo-gate/${token}`, {
        redirect: 'manual', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return { ok: false, step: 'response', detail: `HTTP ${response.status}` };
      }
      const body = await readLimited(response);
      return body !== null && body.trim() === token ? { ok: true } : { ok: false, step: 'response', detail: 'token' };
    } catch (error) {
      return { ok: false, ...stepOf(error) };
    }
  }

  private must(id: number) {
    const row = this.deps.linkDomains.get(id);
    if (!row) throw new LinkDomainError('Nie znaleziono domeny');
    return row;
  }

  private assertFree(domain: string, self: number | null): void {
    const other = this.deps.linkDomains.byDomain(domain);
    if (other && other.id !== self) throw new LinkDomainError(`Domena ${domain} jest już dodana`);
  }

  private record(user: PanelUser, action: string, id: number, meta: Record<string, unknown>): void {
    this.deps.audit.record({ actor: user.login, action, target: `skracacz:${id}`, meta });
  }
}
