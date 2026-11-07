// Wejście w krótki link: rozpoznanie domeny i kodu, liczniki kampanii oraz adres przekierowania.
// Linki już wysłane zatrzymuje wyłącznie wyłączenie domeny, „Wyłącz linki” w kampanii, anulowanie
// wiadomości albo koniec ważności. Klucz API i jego ustawienia skracania nie mają tu znaczenia.
import { silentLogger, type Logger } from '../log.ts';
import type { CampaignRow, CampaignsRepo } from '../store/campaigns.ts';
import type { LinkDomainRow, LinkDomainsRepo } from '../store/link-domains.ts';
import type { MessagesRepo } from '../store/messages.ts';
import type { ShortLinkRow, ShortLinksRepo } from '../store/short-links.ts';
import { isCode } from './codes.ts';
import { withUtm } from './utm.ts';

export interface ClickDeps {
  linkDomains: LinkDomainsRepo;
  shortLinks: ShortLinksRepo;
  campaigns: CampaignsRepo;
  messages: Pick<MessagesRepo, 'get'>;
  transaction<T>(fn: () => T): T;
  /** Pierwsze wejście odbiorcy w dany link, z pominięciem automatów; wołane po zapisie liczników. */
  opened(link: ShortLinkRow, campaign: CampaignRow, domain: LinkDomainRow, now: Date): void;
  log?: Logger;
}

/** Wynik wejścia. Strona „Link wygasł” ma status 404 dla kodu nieznanego tej domenie i 410 dla kodu nieważnego. */
export type ClickResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'expired'; domain: LinkDomainRow | null; status: 404 | 410 }
  | { kind: 'home'; domain: LinkDomainRow };

/** Nazwa domeny z nagłówka `Host`: małe litery, bez portu i kropki na końcu. Adres IP w nawiasach nie jest domeną. */
export function hostName(host: string | null | undefined): string | null {
  if (!host) return null;
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) return null;
  const name = value.replace(/:\d*$/, '').replace(/\.$/, '');
  return name === '' ? null : name;
}

/** Domena skracacza wskazana nagłówkiem `Host`, aktywna albo wyłączona. */
export function domainFor(linkDomains: Pick<LinkDomainsRepo, 'byDomain'>, host: string | null | undefined): LinkDomainRow | null {
  const name = hostName(host);
  return name === null ? null : (linkDomains.byDomain(name) ?? null);
}

const percentEncode = (char: string): string =>
  Array.from(new TextEncoder().encode(char), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

/**
 * Adres do nagłówka `Location`, który przyjmuje wyłącznie znaki ASCII. Adres ASCII zostaje bez zmian,
 * dzięki czemu podpisane parametry nie są kodowane ponownie. Polskie znaki koduje parser adresów
 * tak samo jak przeglądarka, a adres, którego parser nie przyjmuje, jest kodowany znak po znaku.
 */
export function locationHeader(url: string): string {
  if (/^[\x21-\x7e]*$/.test(url)) return url;
  try {
    return new URL(url).href;
  } catch {
    return url.replace(/[^\x21-\x7e]/gu, percentEncode);
  }
}

function active(deps: ClickDeps, link: ShortLinkRow, now: Date): boolean {
  if (link.disabledAt !== null) return false;
  if (now.getTime() >= Date.parse(link.expiresAt)) return false;
  // Kody anulowanej wiadomości są wyłączane przy anulowaniu; stan wiadomości chroni także przed
  // anulowaniem, które dotarło inną drogą.
  return link.messageId === null || deps.messages.get(link.messageId)?.status !== 'cancelled';
}

/**
 * Liczniki jednego wejścia; zwraca true przy pierwszym otwarciu adresu docelowego przez odbiorcę (człowieka).
 * Drugie wystąpienie tego samego linku w SMS-ie ma własny kod, ale nie jest nowym otwarciem.
 */
function count(deps: ClickDeps, link: ShortLinkRow, campaignId: number, automated: boolean, now: Date): boolean {
  const { firstOpen } = deps.shortLinks.click(link.code, now, automated);
  deps.campaigns.countClick(campaignId, now.toISOString().slice(0, 13), automated);
  if (automated) return false;
  deps.campaigns.countTargetClick(campaignId, link.target);
  if (!firstOpen) return false;
  // Otwarcie kampanii i adresu docelowego liczy się raz na odbiorcę, także gdy ten sam link wystąpił w SMS-ie dwa razy.
  if (!deps.shortLinks.recipientOpenedOther(campaignId, link.recipientKey, link.code)) deps.campaigns.countOpen(campaignId);
  if (deps.shortLinks.recipientOpenedOther(campaignId, link.recipientKey, link.code, link.target)) return false;
  deps.campaigns.countTargetOpen(campaignId, link.target);
  return true;
}

export function handleClick(deps: ClickDeps, host: string | null, code: string | null, automated: boolean, now: Date): ClickResult {
  const domain = domainFor(deps.linkDomains, host);
  if (domain === null) return { kind: 'expired', domain: null, status: 404 };
  if (code === null) return domain.enabled === 1 ? { kind: 'home', domain } : { kind: 'expired', domain, status: 404 };

  const link = isCode(code) ? deps.shortLinks.get(code) : undefined;
  // Kod innej domeny tej samej bramki jest dla tej domeny nieznany: odpowiedź nie zdradza, że istnieje.
  if (link === undefined || link.domainId !== domain.id) return { kind: 'expired', domain, status: 404 };
  const campaign = deps.campaigns.get(link.campaignId);
  if (domain.enabled !== 1 || campaign === undefined || !active(deps, link, now)) return { kind: 'expired', domain, status: 410 };

  const location = locationHeader(link.utm === 1 ? withUtm(link.target, campaign.name) : link.target);
  const targetOpened = deps.transaction(() => count(deps, link, campaign.id, automated, now));
  if (targetOpened) {
    try {
      deps.opened(link, campaign, domain, now);
    } catch (error) {
      (deps.log ?? silentLogger).error('przekierowania.blad_zdarzenia', { campaignId: campaign.id, error });
    }
  }
  return { kind: 'redirect', location };
}
