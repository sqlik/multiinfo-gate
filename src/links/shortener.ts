// Usługa skracania wołana we wszystkich drogach wysyłki przed pomiarem i przycięciem treści.
// Działa na szablonie: treść z kodem zastępczym w każdym skracanym linku ma tę samą długość co
// treść końcowa, dlatego pomiar, kodowanie i przycięcie wykonuje się raz, a kody per odbiorca
// podstawia `materialize`.
import { ApiError } from '../api/errors.ts';
import type { ApiKeysRepo, KeyLinkSettings } from '../store/api-keys.ts';
import type { CampaignsRepo } from '../store/campaigns.ts';
import type { LinkDomainRow, LinkDomainsRepo } from '../store/link-domains.ts';
import type { ShortLinksRepo } from '../store/short-links.ts';
import { fitToParts } from '../text/fit.ts';
import { measureText, type EncodingRequest } from '../text/measure.ts';
import { segmentText } from '../text/segment.ts';
import { CODE_LENGTH, PLACEHOLDER_CODE, newCode as randomCode } from './codes.ts';
import { findLinks, hostOf } from './detect.ts';
import { decideShortening, normalizeDomain, targetAllowed, type LinkNotice } from './policy.ts';
import type { LinksServerState } from './server-state.ts';

const DAY_MS = 86_400_000;
/** Kod i adres docelowy zostają w bazie 30 dni po wygaśnięciu linku. */
const RETENTION_DAYS = 30;
const MAX_CAMPAIGN_NAME = 100;
/** Kolizja kodu jest skrajnie mało prawdopodobna; limit chroni przed pętlą przy wadliwym źródle losowości. */
const CODE_ATTEMPTS = 20;
/** Każdy odbiorca otrzymuje w bazie własną kopię adresu docelowego, dlatego dłuższy adres zostaje bez zmian. */
export const MAX_TARGET_LENGTH = 2048;
/** Najwięcej skracanych linków w jednej treści; kolejne zostają bez zmian. */
export const MAX_LINKS = 10;

export interface LinkRequest { shorten?: boolean; campaign?: string; domain?: string; validityDays?: number }
export interface LinkSlot { start: number; length: number; target: string }
/** `too_long`: adres dłuższy niż 2048 znaków, `too_many`: link po dziesiątym skracanym linku w treści. */
export type SkippedLink = { url: string; reason: 'domain_not_allowed' | 'too_long' | 'too_many' };
export interface LinkInfo {
  domainId: number; domain: string; bare: boolean; utm: boolean; validityDays: number;
  /** null: nazwa domyślna (identyfikator rozsyłki, nazwa integracji albo nazwa klucza) nadawana przy zapisie. */
  campaign: string | null;
  notice: LinkNotice | null; skipped: SkippedLink[];
}
/** Szablon: treść z `shortUrl(domain, PLACEHOLDER_CODE)` w miejscu każdego skracanego linku. `info` null, gdy nic nie jest skracane. */
export interface PreparedText { text: string; slots: LinkSlot[]; info: LinkInfo | null; notice: LinkNotice | null }
export type ShortenerDeps = {
  apiKeys: Pick<ApiKeysRepo, 'linkSettings'>; linkDomains: Pick<LinkDomainsRepo, 'get' | 'byDomain'>;
  /** Stan serwera przekierowań; bez niego bramka przyjmuje, że serwer działa. */
  linksServer?: Pick<LinksServerState, 'available'>;
};
export interface LinkPersistDeps {
  campaigns: Pick<CampaignsRepo, 'open' | 'addTarget'>;
  shortLinks: Pick<ShortLinksRepo, 'insert' | 'exists'>;
  /** Źródło kodów; testy podstawiają kody stałe. */
  newCode?: () => string;
}
export interface LinkRecipient {
  recipientKey: string; messageId: string | null; packageId: string | null; seq: number | null; dest: string; clientId: string | null;
}
export interface LinksResponse {
  shortened: number; domain: string | null; campaign: string | null; expiresAt: string | null;
  notice: LinkNotice | null; skipped: SkippedLink[];
}

/** `https://l.firma.pl/aB3xK9q` albo, dla domeny z linkami bez schematu, `l.firma.pl/aB3xK9q`. */
export function shortUrl(domain: string, code: string, bare: boolean): string {
  return bare ? `${domain}/${code}` : `https://${domain}/${code}`;
}

const unchanged = (text: string, notice: LinkNotice | null): PreparedText => ({ text, slots: [], info: null, notice });

/** Treść bez skracania w postaci szablonu, na przykład dla podglądu bez klucza. */
export const plainText = (text: string): PreparedText => unchanged(text, null);

/** Ustawienia klucza i domeny skracacza odczytane raz na wywołanie, a nie raz na każdą z 5000 treści rozsyłki. */
export function onceSettings(deps: ShortenerDeps): ShortenerDeps {
  const cache = new Map<number, KeyLinkSettings>();
  const domains = new Map<string, LinkDomainRow | undefined>();
  return {
    linkDomains: {
      get: (id: number) => deps.linkDomains.get(id),
      byDomain: (domain: string) => {
        if (!domains.has(domain)) domains.set(domain, deps.linkDomains.byDomain(domain));
        return domains.get(domain);
      },
    },
    ...(deps.linksServer ? { linksServer: deps.linksServer } : {}),
    apiKeys: {
      linkSettings: (id: number) => {
        let settings = cache.get(id);
        if (settings === undefined) {
          settings = deps.apiKeys.linkSettings(id);
          cache.set(id, settings);
        }
        return settings;
      },
    },
  };
}

function campaignName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const name = raw.trim();
  if (name === '' || name.length > MAX_CAMPAIGN_NAME) {
    throw new ApiError(400, 'invalid_campaign', `Nazwa kampanii musi zawierać od 1 do ${MAX_CAMPAIGN_NAME} znaków.`);
  }
  return name;
}

/** Domena wskazana w żądaniu albo domyślna domena klucza; null, gdy domena jest wyłączona. */
function pickDomain(deps: ShortenerDeps, settings: KeyLinkSettings, requested: string | undefined): LinkDomainRow | null {
  if (requested !== undefined) {
    const normalized = normalizeDomain(requested);
    const row = normalized === null ? undefined : deps.linkDomains.byDomain(normalized);
    if (!row || !settings.domainIds.includes(row.id)) {
      throw new ApiError(400, 'link_domain_not_allowed', `Domena skracacza ${requested} nie jest przypisana do klucza API.`);
    }
    return row.enabled === 1 ? row : null;
  }
  const id = settings.defaultDomainId ?? settings.domainIds[0];
  const row = id === undefined ? undefined : deps.linkDomains.get(id);
  return row?.enabled === 1 ? row : null;
}

/** Rzuca ApiError 400 `link_domain_not_allowed` (domena spoza klucza) i `invalid_campaign` (ponad 100 znaków albo pusta). */
export function prepareLinks(deps: ShortenerDeps, apiKeyId: number, text: string, req: LinkRequest, opts: { system?: boolean }): PreparedText {
  // SMS-y powiadomień bramki nie są skracane bez względu na ustawienia klucza.
  if (opts.system) return unchanged(text, null);
  const campaign = campaignName(req.campaign);
  const settings = deps.apiKeys.linkSettings(apiKeyId);
  const decision = decideShortening(settings.mode, req.shorten);
  if (!decision.shorten) return unchanged(text, decision.notice);
  const domain = pickDomain(deps, settings, req.domain);
  // Krótki link bez działającego serwera przekierowań nigdzie nie prowadzi, dlatego link zostaje w pełnej postaci.
  if (domain === null || deps.linksServer?.available() === false) return unchanged(text, 'domain_unavailable');

  const bare = domain.bareLinks === 1;
  const short = shortUrl(domain.domain, PLACEHOLDER_CODE, bare);
  const slots: LinkSlot[] = [];
  const skipped: SkippedLink[] = [];
  let out = '';
  let last = 0;
  for (const link of findLinks(text)) {
    const host = hostOf(link.url);
    // Krótki link bramki skrócony ponownie prowadziłby przez dwa przekierowania i liczył otwarcia dwa razy.
    if (host !== null && deps.linkDomains.byDomain(host) !== undefined) continue;
    const reason = host === null || !targetAllowed(host, settings.targets) ? 'domain_not_allowed'
      : link.url.length > MAX_TARGET_LENGTH ? 'too_long'
      : slots.length >= MAX_LINKS ? 'too_many' : null;
    if (reason !== null) {
      skipped.push({ url: link.url, reason });
      continue;
    }
    out += text.slice(last, link.start);
    slots.push({ start: out.length, length: short.length, target: link.url });
    out += short;
    last = link.end;
  }
  out += text.slice(last);
  return {
    text: out, slots, notice: decision.notice,
    info: {
      domainId: domain.id, domain: domain.domain, bare, utm: settings.utm,
      validityDays: req.validityDays ?? settings.validityDays, campaign, notice: decision.notice, skipped,
    },
  };
}

/** `fitToParts` na szablonie; cięcie nigdy w środku slotu - slot przecięty wypada razem z resztą treści. */
export function fitPrepared(p: PreparedText, maxParts: number, encoding: EncodingRequest = 'auto'): { prepared: PreparedText; parts: number; over: boolean } {
  const fitted = fitToParts(p.text, maxParts, encoding);
  if (!fitted.over) return { prepared: p, parts: fitted.parts, over: false };
  // `fitToParts` kończy przyciętą treść znakiem wielokropka (UCS-2) albo trzema kropkami (GSM-7).
  const suffix = fitted.text.endsWith('…') ? '…' : '...';
  let kept = fitted.text.length - suffix.length;
  // Link kończący się dokładnie w miejscu cięcia też wypada: wielokropek doklejony do kodu zmieniłby adres w telefonie.
  const cut = p.slots.find((s) => s.start < kept && kept <= s.start + s.length);
  if (cut === undefined) {
    return { prepared: { ...p, text: fitted.text, slots: p.slots.filter((s) => s.start + s.length < kept) }, parts: fitted.parts, over: true };
  }
  kept = cut.start;
  const text = `${p.text.slice(0, kept)}${suffix}`;
  const parts = segmentText(text, measureText(text, encoding), maxParts).parts;
  return { prepared: { ...p, text, slots: p.slots.filter((s) => s.start + s.length <= kept) }, parts, over: true };
}

/** Treść końcowa: kody w kolejności slotów w miejsce kodu zastępczego. */
export function materialize(p: PreparedText, codes: readonly string[]): string {
  if (codes.length !== p.slots.length) {
    throw new Error(`Liczba kodów (${codes.length}) różni się od liczby skracanych linków (${p.slots.length})`);
  }
  let text = p.text;
  p.slots.forEach((slot, i) => {
    const at = slot.start + slot.length - CODE_LENGTH;
    text = `${text.slice(0, at)}${codes[i]}${text.slice(at + CODE_LENGTH)}`;
  });
  return text;
}

/** `linksDisabled`: kampania ma wyłączone linki, dlatego kody tej wysyłki powstają wyłączone. */
export function openCampaign(
  deps: { campaigns: Pick<CampaignsRepo, 'open' | 'get'> }, apiKeyId: number, name: string, now: Date,
): { id: number; linksDisabled: boolean } {
  const id = deps.campaigns.open(apiKeyId, name, now);
  return { id, linksDisabled: (deps.campaigns.get(id)?.linksDisabledAt ?? null) !== null };
}

/** Data wygaśnięcia linków: termin wysyłki (albo chwila przyjęcia) plus ważność w dniach. */
export function linkExpiry(startAt: Date, validityDays: number): string {
  return new Date(startAt.getTime() + validityDays * DAY_MS).toISOString();
}

function uniqueCode(deps: LinkPersistDeps): string {
  const draw = deps.newCode ?? (() => randomCode());
  for (let i = 0; i < CODE_ATTEMPTS; i++) {
    const code = draw();
    if (!deps.shortLinks.exists(code)) return code;
  }
  throw new Error(`Nie udało się wylosować wolnego kodu w ${CODE_ATTEMPTS} próbach`);
}

/** Kody dla jednego odbiorcy w kolejności slotów; zapis `short_links` i `campaign_targets`. */
export function createCodes(
  deps: LinkPersistDeps, p: PreparedText, campaignId: number, apiKeyId: number, r: LinkRecipient, startAt: Date, now: Date,
): string[] {
  const info = p.info;
  if (info === null || p.slots.length === 0) return [];
  const expiresAt = linkExpiry(startAt, info.validityDays);
  const purgeAfter = linkExpiry(new Date(expiresAt), RETENTION_DAYS);
  const codes = p.slots.map((slot) => {
    const code = uniqueCode(deps);
    deps.shortLinks.insert({
      code, domainId: info.domainId, apiKeyId, campaignId, target: slot.target, utm: info.utm ? 1 : 0,
      recipientKey: r.recipientKey, messageId: r.messageId, packageId: r.packageId, seq: r.seq, dest: r.dest, clientId: r.clientId,
      expiresAt, purgeAfter, createdAt: now.toISOString(),
    });
    return code;
  });
  // Ten sam adres dwa razy w treści jednego odbiorcy liczy się jako jeden odbiorca tego adresu.
  for (const target of new Set(p.slots.map((s) => s.target))) deps.campaigns.addTarget(campaignId, target, purgeAfter);
  return codes;
}

function block(
  templates: readonly PreparedText[], shortened: number, domain: string | null, campaign: string | null, expiresAt: string | null,
  linksDisabled: boolean,
): LinksResponse | undefined {
  // Wyłączone linki kampanii mają pierwszeństwo, ponieważ krótkie linki nie prowadzą do celu.
  const notice = linksDisabled && shortened > 0 ? 'campaign_links_disabled' : templates.find((t) => t.notice !== null)?.notice ?? null;
  const seen = new Set<string>();
  const skipped: SkippedLink[] = [];
  for (const t of templates) {
    for (const s of t.info?.skipped ?? []) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      skipped.push(s);
    }
  }
  if (shortened === 0 && skipped.length === 0 && notice === null) return undefined;
  if (shortened === 0) return { shortened: 0, domain: null, campaign: null, expiresAt: null, notice, skipped };
  return { shortened, domain, campaign, expiresAt, notice, skipped };
}

/** Blok odpowiedzi API dla jednej wiadomości. */
export function linksBlock(p: PreparedText, campaign: string | null, expiresAt: string | null, linksDisabled = false): LinksResponse | undefined {
  return block([p], p.slots.length, p.info?.domain ?? null, campaign, expiresAt, linksDisabled);
}

/** Blok odpowiedzi API dla rozsyłki: `shortened` to liczba kodów wszystkich odbiorców. */
export function packageLinksBlock(
  templates: readonly PreparedText[], shortened: number, campaign: string | null, expiresAt: string | null, linksDisabled = false,
): LinksResponse | undefined {
  const domain = templates.find((t) => t.slots.length > 0)?.info?.domain ?? null;
  return block(templates, shortened, domain, campaign, expiresAt, linksDisabled);
}

/** Blok odpowiedzi na powtórzone żądanie: liczby z zapisanych kodów, zgłoszenia z szablonu i bieżącego stanu kampanii. */
export function storedLinksBlock(
  templates: readonly PreparedText[],
  stored: { count: number; domain: string | null; campaign: string | null; expiresAt: string | null; linksDisabled: boolean } | undefined,
): LinksResponse | undefined {
  if (stored === undefined) return block(templates, 0, null, null, null, false);
  return block(templates, stored.count, stored.domain, stored.campaign, stored.expiresAt, stored.linksDisabled);
}
