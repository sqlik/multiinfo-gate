import type { Database } from 'better-sqlite3';
import { handleClick, type ClickDeps } from '../../src/links/clicks.ts';
import { CampaignsRepo } from '../../src/store/campaigns.ts';
import { LinkDomainsRepo } from '../../src/store/link-domains.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo, type RecipientInput } from '../../src/store/packages.ts';
import { ShortLinksRepo } from '../../src/store/short-links.ts';

export const SPRING = 'przeglad-klimatyzacji-wiosna';
export const SPRING_PACKAGE = 'pkg_7c1e9a2b3d4f5a6b7c8d';
export const FOLDER = 'https://firma.pl/promocje/folder-przeglad.pdf';
export const OFFER = (i: number) => `https://firma.pl/oferta/KL-${10000 + i}`;
export const SENT = 1240;
export const DELIVERED = 1204;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const pad = (i: number) => String(i).padStart(6, '0');
export const dest = (i: number) => `48601${pad(i)}`;
export const folderCode = (i: number) => `f${pad(i)}`;
export const offerCode = (i: number) => `o${pad(i)}`;

/** Chwila kliknięcia odbiorcy `i`: kliknięcia rozłożone na pierwsze 48 godzin od wysyłki. */
export const clickAt = (start: Date, i: number, extra = 0) => new Date(start.getTime() + ((i * 7) % 48) * HOUR + 60_000 + extra * 1000);

/**
 * Kampania firmy serwisowej z makiety: rozsyłka do 1 240 odbiorców z raportem doręczenia, w każdym SMS-ie
 * link wspólny do folderu i link indywidualny do oferty. 1 204 doręczone, 312 odbiorców otworzyło link:
 * folder 251 otwarć i 300 kliknięć, oferta 129 otwarć i 155 kliknięć, do tego 41 wejść automatów.
 */
export function seedSpringCampaign(db: Database, o: { apiKeyId: number; accountId: number; domain: string; start: Date }) {
  const campaigns = new CampaignsRepo(db);
  const shortLinks = new ShortLinksRepo(db);
  const linkDomains = new LinkDomainsRepo(db);
  const domainId = linkDomains.byDomain(o.domain)!.id;
  const campaignId = campaigns.open(o.apiKeyId, SPRING, o.start);
  const recipients: RecipientInput[] = [];
  for (let i = 1; i <= SENT; i++) recipients.push({ dest: dest(i), text: null, clientId: `KL-${10000 + i}`, links: 2 });
  new PackagesRepo(db).insert({
    id: SPRING_PACKAGE, apiKeyId: o.apiKeyId, accountId: o.accountId, serviceId: '24138', defaultText: 'Zapraszamy na przegląd',
    orig: null, costCenter: null, startAt: null, deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: o.start.toISOString(),
    campaignId,
  }, recipients);
  const expiresAt = new Date(o.start.getTime() + 90 * DAY).toISOString();
  const purgeAfter = new Date(o.start.getTime() + 120 * DAY).toISOString();
  db.transaction(() => {
    for (let i = 1; i <= SENT; i++) {
      for (const [code, target] of [[folderCode(i), FOLDER], [offerCode(i), OFFER(i)]] as const) {
        shortLinks.insert({
          code, domainId, apiKeyId: o.apiKeyId, campaignId, target, utm: 1, recipientKey: `${SPRING_PACKAGE}#${i}`, messageId: null,
          packageId: SPRING_PACKAGE, seq: i, dest: dest(i), clientId: `KL-${10000 + i}`, expiresAt, purgeAfter, createdAt: o.start.toISOString(),
        });
        campaigns.addTarget(campaignId, target, purgeAfter);
      }
    }
    campaigns.addSent(campaignId, SENT);
    db.prepare('UPDATE package_recipients SET status = ? WHERE package_id = ? AND seq <= ?').run('delivered', SPRING_PACKAGE, DELIVERED);
  })();

  const deps: ClickDeps = {
    linkDomains, shortLinks, campaigns, messages: new MessagesRepo(db), transaction: (fn) => db.transaction(fn)(), opened: () => {},
  };
  const click = (code: string, at: Date, automated = false) => handleClick(deps, o.domain, code, automated, at);
  for (let i = 1; i <= 251; i++) click(folderCode(i), clickAt(o.start, i));
  for (let i = 1; i <= 49; i++) click(folderCode(i), clickAt(o.start, i, 30));
  for (let i = 184; i <= 312; i++) click(offerCode(i), clickAt(o.start, i, 10));
  for (let i = 184; i <= 209; i++) click(offerCode(i), clickAt(o.start, i, 40));
  for (let n = 0; n < 41; n++) click(folderCode(1000), clickAt(o.start, n), true);

  return { campaignId, domainId, expiresAt, click };
}
