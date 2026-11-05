import type { ClickDeps } from '../../src/links/clicks.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { CampaignsRepo } from '../../src/store/campaigns.ts';
import { openDatabase } from '../../src/store/db.ts';
import { LinkDomainsRepo } from '../../src/store/link-domains.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { ShortLinksRepo, type ShortLinkInput } from '../../src/store/short-links.ts';
import { accountInput, testKey } from '../store/helpers.ts';

export const NOW = new Date('2026-11-05T10:00:00Z');
export const CAMPAIGN = 'przeglad-klimatyzacji-wiosna';

/**
 * Bramka z dwiema domenami skracacza i kampanią firmy serwisowej: `l.firma.pl` bez strony głównej,
 * `firma-link.pl` ze stroną główną. Kody wstawia `addLink`, z adresem docelowym i odbiorcą do wyboru.
 */
export function redirectFixture() {
  const key = testKey();
  const db = openDatabase(':memory:');
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const apiKeys = new ApiKeysRepo(db, key);
  const apiKeyId = apiKeys.insert({
    accountId, name: 'Serwis klimatyzacji', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  const linkDomains = new LinkDomainsRepo(db);
  const domainId = linkDomains.create({ domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, NOW);
  const otherId = linkDomains.create(
    { domain: 'firma-link.pl', displayName: 'Firma Serwis', homeUrl: 'https://firma.pl/', bareLinks: true }, NOW,
  );
  apiKeys.setLinkSettings(apiKeyId, {
    mode: 'sender', domainIds: [domainId, otherId], defaultDomainId: domainId, targets: ['firma.pl'], validityDays: 90, utm: true,
  });
  const campaigns = new CampaignsRepo(db);
  const shortLinks = new ShortLinksRepo(db);
  const messages = new MessagesRepo(db);
  const campaignId = campaigns.open(apiKeyId, CAMPAIGN, NOW);
  const opened: Array<{ code: string; campaign: string; domain: string; at: string }> = [];
  const deps: ClickDeps = {
    linkDomains, shortLinks, campaigns, messages,
    transaction: (fn) => db.transaction(fn)(),
    opened: (link, campaign, domain, at) => { opened.push({ code: link.code, campaign: campaign.name, domain: domain.domain, at: at.toISOString() }); },
  };

  const targets = new Set<string>();
  let n = 0;
  const addLink = (o: Partial<ShortLinkInput> = {}): string => {
    n += 1;
    const code = o.code ?? `kod${String(n).padStart(4, '0')}`;
    const row: ShortLinkInput = {
      code, domainId, apiKeyId, campaignId, target: 'https://firma.pl/przeglad', utm: 1,
      recipientKey: 'msg_1', messageId: 'msg_1', packageId: null, seq: null, dest: '48601000001', clientId: null,
      expiresAt: '2027-02-03T10:00:00.000Z', purgeAfter: '2027-03-05T10:00:00.000Z', createdAt: NOW.toISOString(),
      ...o,
    };
    shortLinks.insert(row);
    // Ten sam adres u tego samego odbiorcy liczy się raz, tak jak w createCodes.
    if (!targets.has(`${row.recipientKey} ${row.target}`)) {
      targets.add(`${row.recipientKey} ${row.target}`);
      campaigns.addTarget(row.campaignId, row.target, row.purgeAfter);
    }
    return code;
  };

  const campaign = () => campaigns.get(campaignId)!;
  const target = (url: string) => campaigns.targets(campaignId).find((t) => t.target === url);

  return { db, apiKeys, apiKeyId, linkDomains, domainId, otherId, campaigns, shortLinks, messages, campaignId, deps, opened, addLink, campaign, target };
}
