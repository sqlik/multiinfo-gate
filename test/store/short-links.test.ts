import { describe, expect, it } from 'vitest';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { CampaignsRepo } from '../../src/store/campaigns.ts';
import { openDatabase } from '../../src/store/db.ts';
import { LinkDomainsRepo } from '../../src/store/link-domains.ts';
import { ShortLinksRepo, type ShortLinkInput } from '../../src/store/short-links.ts';
import { accountInput, testKey } from './helpers.ts';

const AT = new Date('2026-11-05T10:00:00Z');
const t = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

const setup = () => {
  const key = testKey();
  const db = openDatabase(':memory:');
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const apiKeyId = new ApiKeysRepo(db, key).insert({
    accountId, name: 'kampanie', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  const domainId = new LinkDomainsRepo(db).create({ domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, AT);
  const campaigns = new CampaignsRepo(db);
  const campaignId = campaigns.open(apiKeyId, 'przeglad-klimatyzacji-wiosna', AT);
  const otherCampaignId = campaigns.open(apiKeyId, 'cennik-zima', AT);
  const links = new ShortLinksRepo(db);
  const input = (code: string, overrides: Partial<ShortLinkInput> = {}): ShortLinkInput => ({
    code, domainId, apiKeyId, campaignId, target: 'https://firma.pl/przeglad', utm: 1,
    recipientKey: 'msg_1', messageId: 'msg_1', packageId: null, seq: null, dest: '48601000001', clientId: null,
    expiresAt: '2027-02-03T10:00:00.000Z', purgeAfter: '2027-03-05T10:00:00.000Z', createdAt: AT.toISOString(),
    ...overrides,
  });
  return { db, links, campaigns, campaignId, otherCampaignId, input };
};

describe('ShortLinksRepo', () => {
  it('zapisuje kod z licznikami zerowymi i odczytuje go', () => {
    const { links, input } = setup();
    expect(links.exists('aB3xK9q')).toBe(false);
    links.insert(input('aB3xK9q'));
    expect(links.exists('aB3xK9q')).toBe(true);
    expect(links.get('aB3xK9q')).toEqual({
      ...input('aB3xK9q'), clicks: 0, botClicks: 0, firstOpenedAt: null, lastClickedAt: null, disabledAt: null,
    });
    expect(links.get('Xb3xK9q')).toBeUndefined();
  });

  it('kod rozróżnia wielkość liter', () => {
    const { links, input } = setup();
    links.insert(input('aB3xK9q'));
    expect(links.exists('AB3XK9Q')).toBe(false);
    links.insert(input('AB3XK9Q'));
    expect(links.get('AB3XK9Q')!.code).toBe('AB3XK9Q');
  });

  it('pierwsze wejście człowieka jest otwarciem, kolejne już nie', () => {
    const { links, input } = setup();
    links.insert(input('aB3xK9q'));
    expect(links.click('aB3xK9q', t(1), false)).toEqual({ firstOpen: true });
    expect(links.click('aB3xK9q', t(5), false)).toEqual({ firstOpen: false });
    expect(links.get('aB3xK9q')).toMatchObject({ clicks: 2, botClicks: 0, firstOpenedAt: t(1).toISOString(), lastClickedAt: t(5).toISOString() });
  });

  it('wejście automatu liczy się osobno i nie jest otwarciem', () => {
    const { links, input } = setup();
    links.insert(input('aB3xK9q'));
    expect(links.click('aB3xK9q', t(1), true)).toEqual({ firstOpen: false });
    expect(links.get('aB3xK9q')).toMatchObject({ clicks: 0, botClicks: 1, firstOpenedAt: null, lastClickedAt: null });
    expect(links.click('aB3xK9q', t(2), false)).toEqual({ firstOpen: true });
  });

  it('rozpoznaje odbiorcę, który otworzył już inny kod kampanii', () => {
    const { links, input, otherCampaignId } = setup();
    links.insert(input('kod0001'));
    links.insert(input('kod0002', { target: 'https://firma.pl/cennik' }));
    links.insert(input('kod0003', { recipientKey: 'msg_2', messageId: 'msg_2' }));
    links.insert(input('kod0004', { campaignId: otherCampaignId }));
    expect(links.recipientOpenedOther(otherCampaignId, 'msg_1', 'kod0004')).toBe(false);
    links.click('kod0002', t(1), false);
    expect(links.recipientOpenedOther(links.get('kod0001')!.campaignId, 'msg_1', 'kod0001')).toBe(true);
    expect(links.recipientOpenedOther(links.get('kod0001')!.campaignId, 'msg_1', 'kod0001', 'https://firma.pl/przeglad')).toBe(false);
    expect(links.recipientOpenedOther(links.get('kod0001')!.campaignId, 'msg_1', 'kod0002')).toBe(false);
    expect(links.recipientOpenedOther(links.get('kod0003')!.campaignId, 'msg_2', 'kod0003')).toBe(false);
    expect(links.recipientOpenedOther(otherCampaignId, 'msg_1', 'kod0004')).toBe(false);
  });

  it('wyłącza i włącza wyłącznie kody wskazanej kampanii', () => {
    const { links, input, campaignId, otherCampaignId } = setup();
    links.insert(input('kod0001'));
    links.insert(input('kod0002'));
    links.insert(input('kod0003', { campaignId: otherCampaignId }));
    expect(links.disableCampaign(campaignId, t(1))).toBe(2);
    expect(links.get('kod0001')!.disabledAt).toBe(t(1).toISOString());
    expect(links.get('kod0003')!.disabledAt).toBeNull();
    expect(links.enableCampaign(campaignId)).toBe(2);
    expect(links.get('kod0001')!.disabledAt).toBeNull();
  });

  it('kod kampanii z wyłączonymi linkami powstaje wyłączony, a włączenie linków go przywraca', () => {
    const { links, campaigns, input, campaignId, otherCampaignId } = setup();
    campaigns.setLinksDisabled(campaignId, t(1));
    links.insert(input('kod0001', { createdAt: t(5).toISOString() }));
    links.insert(input('kod0002', { campaignId: otherCampaignId }));
    expect(links.get('kod0001')!.disabledAt).toBe(t(1).toISOString());
    expect(links.get('kod0002')!.disabledAt).toBeNull();
    expect(links.enableCampaign(campaignId)).toBe(1);
    expect(links.get('kod0001')!.disabledAt).toBeNull();
  });

  it('wyłącza kody jednej wiadomości', () => {
    const { links, input } = setup();
    links.insert(input('kod0001'));
    links.insert(input('kod0002', { recipientKey: 'msg_2', messageId: 'msg_2' }));
    expect(links.disableMessage('msg_1', t(1))).toBe(1);
    expect(links.get('kod0002')!.disabledAt).toBeNull();
  });

  it('podaje kody wiadomości i odbiorcy rozsyłki', () => {
    const { links, input } = setup();
    links.insert(input('kod0001'));
    links.insert(input('kod0002', { recipientKey: 'pkg_1#1', messageId: null, packageId: 'pkg_1', seq: 1 }));
    links.insert(input('kod0003', { recipientKey: 'pkg_1#2', messageId: null, packageId: 'pkg_1', seq: 2 }));
    expect(links.forMessage('msg_1').map((l) => l.code)).toEqual(['kod0001']);
    expect(links.forPackageRecipient('pkg_1', 2).map((l) => l.code)).toEqual(['kod0003']);
  });

  it('listuje odbiorców z otwarciem od najnowszego kliknięcia', () => {
    const { links, input, campaignId } = setup();
    links.insert(input('kod0001', { clientId: 'zlecenie-114' }));
    links.insert(input('kod0002', { target: 'https://firma.pl/cennik', clientId: 'zlecenie-114' }));
    links.insert(input('kod0003', { recipientKey: 'pkg_1#1', messageId: null, packageId: 'pkg_1', seq: 1, dest: '48601000002' }));
    links.insert(input('kod0004', { recipientKey: 'pkg_1#2', messageId: null, packageId: 'pkg_1', seq: 2, dest: '48601000003' }));
    links.click('kod0001', t(1), false);
    links.click('kod0002', t(30), false);
    links.click('kod0002', t(31), false);
    links.click('kod0003', t(10), false);
    links.click('kod0004', t(20), true);
    expect(links.openers(campaignId, 0, 50)).toEqual([
      { dest: '48601000001', clientId: 'zlecenie-114', firstOpenedAt: t(1).toISOString(), lastClickedAt: t(31).toISOString(), clicks: 3,
        targets: ['https://firma.pl/cennik', 'https://firma.pl/przeglad'] },
      { dest: '48601000002', clientId: null, firstOpenedAt: t(10).toISOString(), lastClickedAt: t(10).toISOString(), clicks: 1,
        targets: ['https://firma.pl/przeglad'] },
    ]);
    expect(links.openers(campaignId, 1, 50)).toHaveLength(1);
  });

  it('usuwa wyłącznie kody z minionym terminem retencji i podaje ich kampanie', () => {
    const { links, input, campaignId, otherCampaignId } = setup();
    links.insert(input('kod0001', { purgeAfter: t(-1).toISOString() }));
    links.insert(input('kod0002', { purgeAfter: t(60).toISOString() }));
    links.insert(input('kod0003', { campaignId: otherCampaignId, purgeAfter: t(60).toISOString() }));
    expect(links.purge(AT)).toEqual([campaignId]);
    expect(links.exists('kod0001')).toBe(false);
    expect(links.exists('kod0002')).toBe(true);
    expect(links.remaining(campaignId)).toBe(1);
    expect(links.remaining(otherCampaignId)).toBe(1);
    expect(links.purge(AT)).toEqual([]);
  });

  it('podaje najpóźniejszy termin retencji kodów domeny, a domena bez kodów daje null', () => {
    const { db, links, input } = setup();
    const other = new LinkDomainsRepo(db).create({ domain: 'firma-link.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, AT);
    expect(links.domainPurgeAfter(other)).toBeNull();
    links.insert(input('kod0001', { domainId: other, purgeAfter: '2027-03-05T10:00:00.000Z' }));
    links.insert(input('kod0002', { domainId: other, purgeAfter: '2027-04-20T10:00:00.000Z' }));
    links.insert(input('kod0003', { purgeAfter: '2027-09-01T10:00:00.000Z' }));
    expect(links.domainPurgeAfter(other)).toBe('2027-04-20T10:00:00.000Z');
  });

  it('podsumowuje kody rozsyłki: liczba, domena, kampania i najwcześniejsze wygaśnięcie', () => {
    const { links, input, campaignId } = setup();
    expect(links.packageSummary('pkg_1')).toBeUndefined();
    links.insert(input('kod0001', { messageId: null, packageId: 'pkg_1', seq: 1, recipientKey: 'pkg_1#1' }));
    links.insert(input('kod0002', { messageId: null, packageId: 'pkg_1', seq: 2, recipientKey: 'pkg_1#2' }));
    links.insert(input('kod0003', { messageId: null, packageId: 'pkg_2', seq: 1, recipientKey: 'pkg_2#1' }));
    const row = links.get('kod0001')!;
    expect(links.packageSummary('pkg_1')).toEqual({
      count: 2, domainId: row.domainId, campaignId, expiresAt: row.expiresAt,
    });
  });

  it('kampania w skrócie: domena ostatniego kodu, najpóźniejsze wygaśnięcie i dopisywanie UTM', () => {
    const { db, links, input, campaignId, otherCampaignId } = setup();
    expect(links.campaignSummary(campaignId)).toBeUndefined();
    const other = new LinkDomainsRepo(db).create({ domain: 'firma-link.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, AT);
    links.insert(input('kod0001', { expiresAt: '2027-03-01T10:00:00.000Z', utm: 0 }));
    links.insert(input('kod0002', { domainId: other, expiresAt: '2027-02-01T10:00:00.000Z', utm: 1, createdAt: t(5).toISOString() }));
    links.insert(input('kod0003', { campaignId: otherCampaignId, utm: 0 }));
    expect(links.campaignSummary(campaignId)).toEqual({ domain: 'firma-link.pl', expiresAt: '2027-03-01T10:00:00.000Z', utm: true });
    expect(links.campaignSummary(otherCampaignId)).toMatchObject({ domain: 'l.firma.pl', utm: false });
  });

  it('liczby rozsyłki: kody, odbiorcy z otwarciem, kliknięcia ludzi i pierwsze otwarcie', () => {
    const { links, input } = setup();
    expect(links.packageStats('pkg_1')).toBeUndefined();
    const pkg = (code: string, seq: number) => input(code, { messageId: null, packageId: 'pkg_1', seq, recipientKey: `pkg_1#${seq}` });
    links.insert(pkg('kod0001', 1));
    links.insert(pkg('kod0002', 1));
    links.insert(pkg('kod0003', 2));
    links.insert(pkg('kod0004', 3));
    links.click('kod0002', t(9), false);
    links.click('kod0001', t(3), false);
    links.click('kod0001', t(4), false);
    links.click('kod0003', t(7), false);
    links.click('kod0004', t(1), true);
    expect(links.packageStats('pkg_1')).toEqual({
      count: 4, opens: 2, clicks: 4, firstOpenedAt: t(3).toISOString(), domain: 'l.firma.pl', expiresAt: '2027-02-03T10:00:00.000Z',
    });
  });
});
