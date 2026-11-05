import { describe, expect, it } from 'vitest';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { LinkDomainsRepo, type LinkDomainInput } from '../../src/store/link-domains.ts';
import { accountInput, testKey } from './helpers.ts';

const AT = new Date('2026-11-05T10:00:00Z');
const LATER = new Date('2026-11-05T11:00:00Z');

const setup = () => {
  const key = testKey();
  const db = openDatabase(':memory:');
  const accountId = new AccountsRepo(db, key).insert(accountInput());
  const keys = new ApiKeysRepo(db, key);
  const apiKeyId = keys.insert({
    accountId, name: 'kampanie', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  return { db, keys, apiKeyId, domains: new LinkDomainsRepo(db) };
};

const input = (overrides: Partial<LinkDomainInput> = {}): LinkDomainInput => ({
  domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: 'https://firma.pl', bareLinks: false, ...overrides,
});

describe('LinkDomainsRepo', () => {
  it('zapisuje domenę z wartościami domyślnymi i odczytuje ją po identyfikatorze', () => {
    const { domains } = setup();
    const id = domains.create(input(), AT);
    expect(domains.get(id)).toEqual({
      id, domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: 'https://firma.pl', bareLinks: 0, enabled: 1,
      checkedAt: null, checkOk: null, checkDetail: null, createdAt: AT.toISOString(), updatedAt: AT.toISOString(),
    });
  });

  it('zapisuje domenę małymi literami i znajduje ją bez względu na wielkość liter', () => {
    const { domains } = setup();
    const id = domains.create(input({ domain: 'L.Firma.PL' }), AT);
    expect(domains.get(id)!.domain).toBe('l.firma.pl');
    expect(domains.byDomain('L.FIRMA.PL')!.id).toBe(id);
    expect(domains.byDomain('firma-link.pl')).toBeUndefined();
  });

  it('odrzuca drugą domenę o tej samej nazwie', () => {
    const { domains } = setup();
    domains.create(input(), AT);
    expect(() => domains.create(input({ domain: 'L.FIRMA.PL' }), AT)).toThrow(/UNIQUE/);
  });

  it('listuje domeny alfabetycznie', () => {
    const { domains } = setup();
    domains.create(input({ domain: 'l.firma.pl' }), AT);
    domains.create(input({ domain: 'firma-link.pl' }), AT);
    expect(domains.list().map((d) => d.domain)).toEqual(['firma-link.pl', 'l.firma.pl']);
  });

  it('zmienia ustawienia domeny i czas zmiany', () => {
    const { domains } = setup();
    const id = domains.create(input(), AT);
    domains.update(id, input({ displayName: 'Serwis klimatyzacji', homeUrl: null, bareLinks: true }), LATER);
    expect(domains.get(id)).toMatchObject({
      displayName: 'Serwis klimatyzacji', homeUrl: null, bareLinks: 1, createdAt: AT.toISOString(), updatedAt: LATER.toISOString(),
    });
  });

  it('wyłącza i włącza domenę', () => {
    const { domains } = setup();
    const id = domains.create(input(), AT);
    domains.setEnabled(id, false, LATER);
    expect(domains.get(id)).toMatchObject({ enabled: 0, updatedAt: LATER.toISOString() });
    domains.setEnabled(id, true, LATER);
    expect(domains.get(id)!.enabled).toBe(1);
  });

  it('zapisuje wynik sprawdzenia domeny', () => {
    const { domains } = setup();
    const id = domains.create(input(), AT);
    domains.setCheck(id, false, 'Brak rekordu DNS', LATER);
    expect(domains.get(id)).toMatchObject({ checkedAt: LATER.toISOString(), checkOk: 0, checkDetail: 'Brak rekordu DNS' });
    domains.setCheck(id, true, null, LATER);
    expect(domains.get(id)).toMatchObject({ checkOk: 1, checkDetail: null });
  });

  it('podaje klucze, którym przypisano domenę', () => {
    const { domains, keys, apiKeyId } = setup();
    const id = domains.create(input(), AT);
    const other = domains.create(input({ domain: 'firma-link.pl' }), AT);
    expect(domains.keysUsing(id)).toEqual([]);
    keys.setLinkSettings(apiKeyId, { mode: 'always', domainIds: [id], defaultDomainId: id, targets: ['firma.pl'], validityDays: 90, utm: true });
    expect(domains.keysUsing(id)).toEqual([apiKeyId]);
    expect(domains.keysUsing(other)).toEqual([]);
  });

  it('usuwa domenę bez przypisań', () => {
    const { domains } = setup();
    const id = domains.create(input(), AT);
    domains.remove(id);
    expect(domains.get(id)).toBeUndefined();
  });
});
