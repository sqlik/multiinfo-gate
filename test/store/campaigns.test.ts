import { describe, expect, it } from 'vitest';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { CampaignsRepo } from '../../src/store/campaigns.ts';
import { openDatabase } from '../../src/store/db.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo, type RecipientInput } from '../../src/store/packages.ts';
import { accountInput, messageInput, testKey } from './helpers.ts';

const AT = new Date('2026-11-05T10:00:00Z');
const LATER = new Date('2026-11-05T12:30:00Z');
const NAME = 'przeglad-klimatyzacji-wiosna';

const setup = () => {
  const key = testKey();
  const db = openDatabase(':memory:');
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const keys = new ApiKeysRepo(db, key);
  const keyInput = (name: string) => ({
    accountId, name, keyHash: `h-${name}`, keyPrefix: name, defaultServiceId: '24138', defaultOrig: null,
    maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  const apiKeyId = keys.insert(keyInput('kampanie'));
  const otherKeyId = keys.insert(keyInput('serwis'));
  return {
    db, accountId, apiKeyId, otherKeyId,
    campaigns: new CampaignsRepo(db), messages: new MessagesRepo(db), packages: new PackagesRepo(db),
  };
};

describe('CampaignsRepo', () => {
  it('otwiera kampanię i zwraca ją po nazwie przy kolejnej wysyłce, przesuwając ostatnią wysyłkę', () => {
    const { campaigns, apiKeyId } = setup();
    const id = campaigns.open(apiKeyId, NAME, AT);
    expect(campaigns.open(apiKeyId, NAME, LATER)).toBe(id);
    expect(campaigns.get(id)).toEqual({
      id, apiKeyId, name: NAME, firstSentAt: AT.toISOString(), lastSentAt: LATER.toISOString(),
      sent: 0, opens: 0, clicks: 0, bots: 0, linksDisabledAt: null, detailsPurgedAt: null, createdAt: AT.toISOString(),
    });
    expect(campaigns.byName(apiKeyId, NAME)!.id).toBe(id);
  });

  it('kolejna wysyłka do kampanii z wyłączonymi linkami zachowuje znacznik', () => {
    const { campaigns, apiKeyId } = setup();
    const id = campaigns.open(apiKeyId, NAME, AT);
    campaigns.setLinksDisabled(id, AT);
    expect(campaigns.get(id)!.linksDisabledAt).toBe(AT.toISOString());
    campaigns.open(apiKeyId, NAME, LATER);
    expect(campaigns.get(id)!.linksDisabledAt).toBe(AT.toISOString());
  });

  it('liczy rozsyłki i pojedyncze wiadomości kampanii', () => {
    const { campaigns, messages, packages, apiKeyId, accountId } = setup();
    const id = campaigns.open(apiKeyId, NAME, AT);
    messages.insert(messageInput({ id: 'msg_1', apiKeyId, accountId, campaignId: id }));
    messages.insert(messageInput({ id: 'msg_2', apiKeyId, accountId, campaignId: null }));
    packages.insert({
      id: 'pkg_1', apiKeyId, accountId, serviceId: '24138', defaultText: null, orig: null, costCenter: null, startAt: null,
      deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: AT.toISOString(), campaignId: id,
    }, [{ dest: '48601000001', text: 'a', clientId: null, links: 1 }]);
    expect(campaigns.sources(id)).toEqual({ packages: 1, messages: 1 });
  });

  it('ta sama nazwa przy innym kluczu to osobna kampania', () => {
    const { campaigns, apiKeyId, otherKeyId } = setup();
    expect(campaigns.open(apiKeyId, NAME, AT)).not.toBe(campaigns.open(otherKeyId, NAME, AT));
    expect(campaigns.byName(otherKeyId, 'nieznana')).toBeUndefined();
  });

  it('listuje kampanie od ostatniej wysyłki, z filtrem klucza i stronicowaniem', () => {
    const { campaigns, apiKeyId, otherKeyId } = setup();
    campaigns.open(apiKeyId, 'starsza', AT);
    campaigns.open(apiKeyId, 'nowsza', LATER);
    campaigns.open(otherKeyId, 'serwisowa', AT);
    expect(campaigns.list({ offset: 0, limit: 10 }).rows.map((c) => c.name)).toEqual(['nowsza', 'serwisowa', 'starsza']);
    expect(campaigns.list({ apiKeyId, offset: 0, limit: 1 })).toMatchObject({ rows: [{ name: 'nowsza' }], hasMore: true });
    expect(campaigns.list({ apiKeyId, offset: 1, limit: 1 })).toMatchObject({ rows: [{ name: 'starsza' }], hasMore: false });
  });

  it('sumuje wysłane, otwarcia oraz kliknięcia i automaty w godzinach', () => {
    const { campaigns, apiKeyId } = setup();
    const id = campaigns.open(apiKeyId, NAME, AT);
    campaigns.addSent(id, 500);
    campaigns.addSent(id, 2);
    campaigns.countOpen(id);
    campaigns.countClick(id, '2026-11-05T10', false);
    campaigns.countClick(id, '2026-11-05T10', false);
    campaigns.countClick(id, '2026-11-05T10', true);
    campaigns.countClick(id, '2026-11-05T12', false);
    expect(campaigns.get(id)).toMatchObject({ sent: 502, opens: 1, clicks: 3, bots: 1 });
    expect(campaigns.hours(id)).toEqual([
      { hour: '2026-11-05T10', clicks: 2, bots: 1 },
      { hour: '2026-11-05T12', clicks: 1, bots: 0 },
    ]);
  });

  it('prowadzi liczniki adresów docelowych i przesuwa termin retencji na najpóźniejszy', () => {
    const { campaigns, apiKeyId } = setup();
    const id = campaigns.open(apiKeyId, NAME, AT);
    campaigns.addTarget(id, 'https://firma.pl/przeglad', '2026-03-05T10:00:00.000Z');
    campaigns.addTarget(id, 'https://firma.pl/przeglad', '2026-02-01T10:00:00.000Z');
    campaigns.addTarget(id, 'https://firma.pl/cennik', '2026-03-05T10:00:00.000Z');
    campaigns.countTargetOpen(id, 'https://firma.pl/przeglad');
    campaigns.countTargetClick(id, 'https://firma.pl/przeglad');
    campaigns.countTargetClick(id, 'https://firma.pl/przeglad');
    expect(campaigns.targets(id)).toEqual([
      { target: 'https://firma.pl/przeglad', collapsed: 0, recipients: 2, opens: 1, clicks: 2 },
      { target: 'https://firma.pl/cennik', collapsed: 0, recipients: 1, opens: 0, clicks: 0 },
    ]);
  });

  it('liczy doręczone wśród wiadomości kampanii i odbiorców rozsyłki z kodami', () => {
    const { db, campaigns, messages, packages, apiKeyId, accountId } = setup();
    const id = campaigns.open(apiKeyId, NAME, AT);
    messages.insert(messageInput({ id: 'msg_1', apiKeyId, accountId, campaignId: id }));
    messages.insert(messageInput({ id: 'msg_2', apiKeyId, accountId, campaignId: id }));
    messages.insert(messageInput({ id: 'msg_3', apiKeyId, accountId, campaignId: null }));
    db.prepare("UPDATE messages SET status = 'delivered' WHERE id IN ('msg_1', 'msg_3')").run();
    const recipients: RecipientInput[] = [
      { dest: '48601000001', text: 'a', clientId: null, links: 1 },
      { dest: '48601000002', text: 'b', clientId: null, links: 2 },
      { dest: '48601000003', text: 'c', clientId: null, links: 0 },
    ];
    packages.insert({
      id: 'pkg_1', apiKeyId, accountId, serviceId: '24138', defaultText: null, orig: null, costCenter: null, startAt: null,
      deliveryReport: 0, encoding: 'gsm', multipart: 0, createdAt: AT.toISOString(), campaignId: id,
    }, recipients);
    db.prepare("UPDATE package_recipients SET status = 'delivered'").run();
    // Pojedyncze SMS-y bramka zawsze odpytuje o stan, więc kampania z nimi ma wynik doręczeń.
    expect(campaigns.delivered(id)).toEqual({ delivered: 3, reported: true });
  });

  it('bez raportu doręczenia w żadnej wysyłce kafelek nie ma podstaw do liczenia', () => {
    const { campaigns, packages, apiKeyId, accountId } = setup();
    const id = campaigns.open(apiKeyId, NAME, AT);
    packages.insert({
      id: 'pkg_1', apiKeyId, accountId, serviceId: '24138', defaultText: null, orig: null, costCenter: null, startAt: null,
      deliveryReport: 0, encoding: 'gsm', multipart: 0, createdAt: AT.toISOString(), campaignId: id,
    }, [{ dest: '48601000001', text: 'a', clientId: null, links: 1 }]);
    expect(campaigns.delivered(id)).toEqual({ delivered: 0, reported: false });
    packages.insert({
      id: 'pkg_2', apiKeyId, accountId, serviceId: '24138', defaultText: null, orig: null, costCenter: null, startAt: null,
      deliveryReport: 1, encoding: 'gsm', multipart: 0, createdAt: AT.toISOString(), campaignId: id,
    }, [{ dest: '48601000002', text: 'b', clientId: null, links: 1 }]);
    expect(campaigns.delivered(id)).toEqual({ delivered: 0, reported: true });
  });

  it('scala indywidualne adresy po terminie retencji w jeden wiersz wzorca', () => {
    const { campaigns, apiKeyId } = setup();
    const id = campaigns.open(apiKeyId, NAME, AT);
    campaigns.addTarget(id, 'https://firma.pl/o/123', '2026-11-01T00:00:00.000Z');
    campaigns.addTarget(id, 'https://firma.pl/o/456', '2026-11-01T00:00:00.000Z');
    campaigns.countTargetOpen(id, 'https://firma.pl/o/456');
    campaigns.countTargetClick(id, 'https://firma.pl/o/456');
    // Adres wspólny i adres przed terminem retencji zostają bez zmian.
    campaigns.addTarget(id, 'https://firma.pl/cennik', '2026-11-01T00:00:00.000Z');
    campaigns.addTarget(id, 'https://firma.pl/cennik', '2026-11-01T00:00:00.000Z');
    campaigns.addTarget(id, 'https://firma.pl/o/789', '2026-12-01T00:00:00.000Z');
    const pattern = (url: string) => url.replace(/\/\d+$/, '/…');
    expect(campaigns.collapseTargets(AT, pattern)).toBe(2);
    expect(campaigns.targets(id)).toEqual(expect.arrayContaining([
      { target: 'https://firma.pl/o/…', collapsed: 1, recipients: 2, opens: 1, clicks: 1 },
      { target: 'https://firma.pl/cennik', collapsed: 0, recipients: 2, opens: 0, clicks: 0 },
      { target: 'https://firma.pl/o/789', collapsed: 0, recipients: 1, opens: 0, clicks: 0 },
    ]));
    expect(campaigns.targets(id)).toHaveLength(3);
  });

  it('kolejne scalenie dopisuje do istniejącego wiersza wzorca', () => {
    const { campaigns, apiKeyId } = setup();
    const id = campaigns.open(apiKeyId, NAME, AT);
    const pattern = (url: string) => url.replace(/\/\d+$/, '/…');
    campaigns.addTarget(id, 'https://firma.pl/o/123', '2026-11-01T00:00:00.000Z');
    campaigns.collapseTargets(AT, pattern);
    campaigns.addTarget(id, 'https://firma.pl/o/456', '2026-11-02T00:00:00.000Z');
    expect(campaigns.collapseTargets(AT, pattern)).toBe(1);
    expect(campaigns.targets(id)).toEqual([{ target: 'https://firma.pl/o/…', collapsed: 1, recipients: 2, opens: 0, clicks: 0 }]);
  });

  it('zapisuje wyłączenie linków i usunięcie szczegółów', () => {
    const { campaigns, apiKeyId } = setup();
    const id = campaigns.open(apiKeyId, NAME, AT);
    campaigns.setLinksDisabled(id, LATER);
    expect(campaigns.get(id)!.linksDisabledAt).toBe(LATER.toISOString());
    campaigns.setLinksDisabled(id, null);
    expect(campaigns.get(id)!.linksDisabledAt).toBeNull();
    campaigns.setDetailsPurged(id, LATER);
    expect(campaigns.get(id)!.detailsPurgedAt).toBe(LATER.toISOString());
  });
});
