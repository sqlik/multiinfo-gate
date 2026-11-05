import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors.ts';
import { isCode } from '../../src/links/codes.ts';
import {
  createCodes, fitPrepared, linksBlock, materialize, onceSettings, openCampaign, prepareLinks, shortUrl,
  type LinkRequest, type PreparedText,
} from '../../src/links/shortener.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo, type KeyLinkSettings } from '../../src/store/api-keys.ts';
import { CampaignsRepo } from '../../src/store/campaigns.ts';
import { openDatabase } from '../../src/store/db.ts';
import { LinkDomainsRepo } from '../../src/store/link-domains.ts';
import { ShortLinksRepo } from '../../src/store/short-links.ts';
import { accountInput, testKey } from '../store/helpers.ts';

const NOW = new Date('2026-11-05T10:00:00Z');
const DAY = 86_400_000;

const setup = (settings: Partial<KeyLinkSettings> = {}) => {
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
  const otherId = linkDomains.create({ domain: 'firma-link.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: true }, NOW);
  linkDomains.create({ domain: 'obca-domena.pl', displayName: 'Inna firma', homeUrl: null, bareLinks: false }, NOW);
  apiKeys.setLinkSettings(apiKeyId, {
    mode: 'sender', domainIds: [domainId, otherId], defaultDomainId: domainId, targets: ['firma.pl'], validityDays: 90, utm: true,
    ...settings,
  });
  const campaigns = new CampaignsRepo(db);
  const shortLinks = new ShortLinksRepo(db);
  const deps = { apiKeys, linkDomains };
  const prepare = (text: string, req: LinkRequest = {}, opts: { system?: boolean } = {}) => prepareLinks(deps, apiKeyId, text, req, opts);
  return { db, apiKeys, apiKeyId, linkDomains, domainId, otherId, campaigns, shortLinks, deps, prepare };
};

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  return undefined;
};

describe('shortUrl', () => {
  it('buduje krótki link ze schematem albo bez niego', () => {
    expect(shortUrl('l.firma.pl', 'aB3xK9q', false)).toBe('https://l.firma.pl/aB3xK9q');
    expect(shortUrl('l.firma.pl', 'aB3xK9q', true)).toBe('l.firma.pl/aB3xK9q');
  });
});

describe('prepareLinks', () => {
  it('zastępuje link z dozwolonej domeny krótkim linkiem z kodem zastępczym', () => {
    const { prepare, domainId } = setup();
    const p = prepare('Przegląd klimatyzacji: https://firma.pl/folder.pdf');
    expect(p.text).toBe('Przegląd klimatyzacji: https://l.firma.pl/0000000');
    expect(p.slots).toEqual([{ start: 23, length: 26, target: 'https://firma.pl/folder.pdf' }]);
    expect(p.info).toEqual({
      domainId, domain: 'l.firma.pl', bare: false, utm: true, validityDays: 90, campaign: null, notice: null, skipped: [],
    });
    expect(p.notice).toBeNull();
  });

  it('pozostawia link spoza listy domen docelowych i wymienia go jako pominięty', () => {
    const { prepare } = setup();
    const p = prepare('Cennik https://inna.pl/c oraz termin https://oferta.firma.pl/t');
    expect(p.text).toBe('Cennik https://inna.pl/c oraz termin https://l.firma.pl/0000000');
    expect(p.slots).toEqual([{ start: 37, length: 26, target: 'https://oferta.firma.pl/t' }]);
    expect(p.info!.skipped).toEqual([{ url: 'https://inna.pl/c', reason: 'domain_not_allowed' }]);
  });

  it('nadaje osobny slot każdemu wystąpieniu tego samego linku', () => {
    const { prepare } = setup();
    const p = prepare('https://firma.pl/a i ponownie https://firma.pl/a');
    expect(p.slots.map((s) => s.target)).toEqual(['https://firma.pl/a', 'https://firma.pl/a']);
    expect(p.text).toBe('https://l.firma.pl/0000000 i ponownie https://l.firma.pl/0000000');
  });

  it('skraca przy trybie Zawsze mimo pola „nie skracaj” i zgłasza to', () => {
    const { prepare } = setup({ mode: 'always' });
    const p = prepare('Oferta https://firma.pl/o', { shorten: false });
    expect(p.slots).toHaveLength(1);
    expect(p.notice).toBe('forced_by_key');
    expect(p.info!.notice).toBe('forced_by_key');
  });

  it('nie skraca przy trybie Wyłączone mimo pola „skracaj” i zgłasza to', () => {
    const { prepare } = setup({ mode: 'off' });
    const p = prepare('Oferta https://firma.pl/o', { shorten: true });
    expect(p).toEqual({ text: 'Oferta https://firma.pl/o', slots: [], info: null, notice: 'disabled_by_key' });
  });

  it('nie skraca, gdy wysyłający wybrał „nie skracaj” przy trybie Decyduje wysyłający', () => {
    const { prepare } = setup();
    expect(prepare('Oferta https://firma.pl/o', { shorten: false })).toEqual({
      text: 'Oferta https://firma.pl/o', slots: [], info: null, notice: null,
    });
  });

  it('używa wskazanej domeny klucza bez względu na wielkość liter', () => {
    const { prepare, otherId } = setup();
    const p = prepare('Oferta https://firma.pl/o', { domain: 'Firma-Link.PL' });
    expect(p.text).toBe('Oferta firma-link.pl/0000000');
    expect(p.slots).toEqual([{ start: 7, length: 21, target: 'https://firma.pl/o' }]);
    expect(p.info).toMatchObject({ domainId: otherId, domain: 'firma-link.pl', bare: true });
  });

  it('odrzuca domenę spoza domen klucza', () => {
    const { prepare } = setup();
    expect(errorCode(() => prepare('Oferta https://firma.pl/o', { domain: 'obca-domena.pl' }))).toBe('link_domain_not_allowed');
    expect(errorCode(() => prepare('Oferta https://firma.pl/o', { domain: 'nieznana.pl' }))).toBe('link_domain_not_allowed');
  });

  it('nie sprawdza domeny, gdy nic nie jest skracane', () => {
    const { prepare } = setup({ mode: 'off' });
    expect(prepare('Oferta https://firma.pl/o', { domain: 'obca-domena.pl' }).slots).toEqual([]);
  });

  it('nie skraca przy wyłączonej domenie i zgłasza to', () => {
    const { prepare, linkDomains, domainId } = setup();
    linkDomains.setEnabled(domainId, false, NOW);
    expect(prepare('Oferta https://firma.pl/o')).toEqual({
      text: 'Oferta https://firma.pl/o', slots: [], info: null, notice: 'domain_unavailable',
    });
  });

  it('przyjmuje nazwę kampanii i ważność z żądania', () => {
    const { prepare } = setup();
    const p = prepare('Oferta https://firma.pl/o', { campaign: '  Przegląd / wiosna 2027 ', validityDays: 14 });
    expect(p.info).toMatchObject({ campaign: 'Przegląd / wiosna 2027', validityDays: 14 });
  });

  it('odrzuca pustą nazwę kampanii i nazwę dłuższą niż 100 znaków', () => {
    const { prepare } = setup();
    expect(errorCode(() => prepare('Oferta https://firma.pl/o', { campaign: 'x'.repeat(101) }))).toBe('invalid_campaign');
    expect(errorCode(() => prepare('Oferta https://firma.pl/o', { campaign: '   ' }))).toBe('invalid_campaign');
    expect(errorCode(() => prepare('Oferta https://firma.pl/o', { campaign: 'x'.repeat(100) }))).toBeUndefined();
  });

  it('serwer krótkich linków nie działa: linki bez zmian i zgłoszenie domain_unavailable, także przy kluczu „Zawsze”', () => {
    for (const mode of ['sender', 'always'] as const) {
      const { apiKeyId, deps } = setup({ mode });
      const down = { ...deps, linksServer: { available: () => false } };
      expect(prepareLinks(down, apiKeyId, 'Oferta https://firma.pl/o', {}, {}), mode).toEqual({
        text: 'Oferta https://firma.pl/o', slots: [], info: null, notice: 'domain_unavailable',
      });
      expect(prepareLinks(down, apiKeyId, 'Oferta https://firma.pl/o', { shorten: true, campaign: 'wiosna' }, {}).notice, mode)
        .toBe('domain_unavailable');
    }
  });

  it('serwer krótkich linków nie działa: domena spoza klucza i błędna nazwa kampanii nadal kończą się błędem', () => {
    const { apiKeyId, deps } = setup();
    const down = { ...deps, linksServer: { available: () => false } };
    expect(errorCode(() => prepareLinks(down, apiKeyId, 'Oferta https://firma.pl/o', { domain: 'obca-domena.pl' }, {})))
      .toBe('link_domain_not_allowed');
    expect(errorCode(() => prepareLinks(down, apiKeyId, 'Oferta https://firma.pl/o', { campaign: ' ' }, {}))).toBe('invalid_campaign');
  });

  it('działający serwer krótkich linków nie zmienia wyniku', () => {
    const { apiKeyId, deps } = setup();
    const up = { ...deps, linksServer: { available: () => true } };
    expect(prepareLinks(up, apiKeyId, 'Oferta https://firma.pl/o', {}, {}).text).toBe('Oferta https://l.firma.pl/0000000');
  });

  it('onceSettings zachowuje stan serwera krótkich linków', () => {
    const { apiKeyId, deps } = setup();
    const once = onceSettings({ ...deps, linksServer: { available: () => false } });
    expect(prepareLinks(once, apiKeyId, 'Oferta https://firma.pl/o', {}, {}).notice).toBe('domain_unavailable');
  });

  it('nie zmienia SMS-a powiadomień bramki i nie odczytuje ustawień klucza', () => {
    const deps = {
      apiKeys: { linkSettings: () => { throw new Error('ustawienia nie powinny być odczytane'); } },
      linkDomains: { get: () => undefined, byDomain: () => undefined },
    };
    expect(prepareLinks(deps, 1, 'Awaria https://firma.pl/x', { shorten: true }, { system: true })).toEqual({
      text: 'Awaria https://firma.pl/x', slots: [], info: null, notice: null,
    });
  });
});

describe('fitPrepared', () => {
  it('zwraca szablon bez zmian, gdy mieści się w limicie', () => {
    const { prepare } = setup();
    const p = prepare('Oferta https://firma.pl/o');
    expect(fitPrepared(p, 1)).toEqual({ prepared: p, parts: 1, over: false });
  });

  it('usuwa cały krótki link, gdy przycięcie wypada w jego środku', () => {
    const { prepare } = setup();
    const p = prepare(`${'X'.repeat(150)} https://firma.pl/a`);
    const fitted = fitPrepared(p, 1);
    expect(fitted.over).toBe(true);
    expect(fitted.parts).toBe(1);
    expect(fitted.prepared.slots).toEqual([]);
    expect(fitted.prepared.text).toBe(`${'X'.repeat(150)} ...`);
    expect(fitted.prepared.text).not.toMatch(/https|l\.firma|0000/);
    expect(fitted.prepared.info).toEqual(p.info);
  });

  it('zachowuje krótki link przed miejscem przycięcia', () => {
    const { prepare } = setup();
    const p = prepare(`Oferta https://firma.pl/a ${'X'.repeat(200)}`);
    const fitted = fitPrepared(p, 1);
    expect(fitted.over).toBe(true);
    expect(fitted.prepared.slots).toEqual(p.slots);
    expect(fitted.prepared.text.startsWith('Oferta https://l.firma.pl/0000000 XXX')).toBe(true);
    expect(fitted.prepared.text).toHaveLength(160);
  });

  it('liczy części treści z polskimi znakami po skróceniu', () => {
    const { prepare } = setup();
    const p = prepare('Przegląd klimatyzacji: https://firma.pl/oferty/przeglad-klimatyzacji-wiosna-2027?klient=123456');
    expect(fitPrepared(p, 1)).toMatchObject({ parts: 1, over: false });
  });
});

describe('materialize', () => {
  it('podstawia kody w kolejności slotów', () => {
    const { prepare } = setup();
    const p = prepare('Oferta https://firma.pl/a i cennik https://firma.pl/b.');
    expect(materialize(p, ['aB3xK9q', 'Zz9Yy8x'])).toBe('Oferta https://l.firma.pl/aB3xK9q i cennik https://l.firma.pl/Zz9Yy8x.');
  });

  it('odrzuca liczbę kodów różną od liczby slotów', () => {
    const { prepare } = setup();
    expect(() => materialize(prepare('Oferta https://firma.pl/a'), [])).toThrow();
  });
});

describe('createCodes', () => {
  const recipient = { recipientKey: 'msg_1', messageId: 'msg_1', packageId: null, seq: null, dest: '48601000001', clientId: null };

  it('zapisuje osobny kod dla każdego slotu z ważnością od terminu wysyłki', () => {
    const { prepare, campaigns, shortLinks, apiKeyId, domainId } = setup();
    const p = prepare('https://firma.pl/a i ponownie https://firma.pl/a', { validityDays: 10 });
    const campaignId = openCampaign({ campaigns }, apiKeyId, 'przeglad-klimatyzacji-wiosna', NOW).id;
    const startAt = new Date(NOW.getTime() + DAY);
    const codes = createCodes({ campaigns, shortLinks }, p, campaignId, apiKeyId, recipient, startAt, NOW);
    expect(codes).toHaveLength(2);
    expect(codes[0]).not.toBe(codes[1]);
    expect(codes.every(isCode)).toBe(true);
    const row = shortLinks.get(codes[0]!)!;
    expect(row).toMatchObject({
      domainId, apiKeyId, campaignId, target: 'https://firma.pl/a', utm: 1, recipientKey: 'msg_1', messageId: 'msg_1',
      dest: '48601000001', expiresAt: new Date(startAt.getTime() + 10 * DAY).toISOString(),
      purgeAfter: new Date(startAt.getTime() + 40 * DAY).toISOString(), createdAt: NOW.toISOString(),
    });
    // Ten sam adres dwa razy u jednego odbiorcy to jeden odbiorca adresu docelowego.
    expect(campaigns.targets(campaignId)).toEqual([
      { target: 'https://firma.pl/a', collapsed: 0, recipients: 1, opens: 0, clicks: 0 },
    ]);
  });

  it('zgłasza kampanię z wyłączonymi linkami przy kolejnej wysyłce', () => {
    const { campaigns, apiKeyId } = setup();
    const first = openCampaign({ campaigns }, apiKeyId, 'wiosna', NOW);
    expect(first.linksDisabled).toBe(false);
    campaigns.setLinksDisabled(first.id, NOW);
    expect(openCampaign({ campaigns }, apiKeyId, 'wiosna', NOW)).toEqual({ id: first.id, linksDisabled: true });
  });

  it('losuje ponownie, gdy kod już istnieje', () => {
    const { prepare, campaigns, shortLinks, apiKeyId } = setup();
    const p = prepare('Oferta https://firma.pl/a');
    const campaignId = openCampaign({ campaigns }, apiKeyId, 'wiosna', NOW).id;
    const first = createCodes({ campaigns, shortLinks, newCode: () => 'aaaaaaa' }, p, campaignId, apiKeyId, recipient, NOW, NOW);
    expect(first).toEqual(['aaaaaaa']);
    const draws = ['aaaaaaa', 'aaaaaaa', 'bbbbbbb'];
    const second = createCodes({ campaigns, shortLinks, newCode: () => draws.shift()! }, p, campaignId, apiKeyId,
      { ...recipient, recipientKey: 'msg_2', messageId: 'msg_2' }, NOW, NOW);
    expect(second).toEqual(['bbbbbbb']);
  });
});

describe('linksBlock', () => {
  it('opisuje skrócone linki, kampanię i datę wygaśnięcia', () => {
    const { prepare } = setup();
    const p = prepare('Oferta https://firma.pl/a, cennik https://inna.pl/c');
    expect(linksBlock(p, 'wiosna', '2027-02-03T10:00:00.000Z')).toEqual({
      shortened: 1, domain: 'l.firma.pl', campaign: 'wiosna', expiresAt: '2027-02-03T10:00:00.000Z', notice: null,
      skipped: [{ url: 'https://inna.pl/c', reason: 'domain_not_allowed' }],
    });
  });

  it('zgłasza kampanię z wyłączonymi linkami przed ustawieniem klucza', () => {
    const { prepare } = setup({ mode: 'always' });
    const p = prepare('Oferta https://firma.pl/a', { shorten: false });
    expect(linksBlock(p, 'wiosna', '2027-02-03T10:00:00.000Z', true)).toMatchObject({
      shortened: 1, campaign: 'wiosna', notice: 'campaign_links_disabled',
    });
  });

  it('zgłasza samo ustawienie klucza, gdy nic nie zostało skrócone', () => {
    const { prepare } = setup({ mode: 'off' });
    expect(linksBlock(prepare('Oferta https://firma.pl/a', { shorten: true }), null, null)).toEqual({
      shortened: 0, domain: null, campaign: null, expiresAt: null, notice: 'disabled_by_key', skipped: [],
    });
  });

  it('pomija blok, gdy nie ma czego zgłosić', () => {
    const { prepare } = setup();
    expect(linksBlock(prepare('Dziękujemy za wizytę'), null, null)).toBeUndefined();
    const plain: PreparedText = { text: 'x', slots: [], info: null, notice: null };
    expect(linksBlock(plain, null, null)).toBeUndefined();
  });
});
