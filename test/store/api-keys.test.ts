import { describe, expect, it } from 'vitest';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo, type ApiKeyInput } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { accountInput, testKey } from './helpers.ts';

const setup = () => {
  const key = testKey();
  const db = openDatabase(':memory:');
  const accounts = new AccountsRepo(db, key);
  const accountId = accounts.insert(accountInput({ origs: ['Firma Info', 'Firma'] }));
  return { db, key, accounts, accountId, keys: new ApiKeysRepo(db, key) };
};

const keyInput = (accountId: number, overrides: Partial<ApiKeyInput> = {}): ApiKeyInput => ({
  accountId,
  name: 'rejestracja',
  keyHash: 'argon2:aaa',
  keyPrefix: 'mig_live_a1b2c3',
  defaultServiceId: '24138',
  defaultOrig: 'Firma Info',
  maxParts: 3,
  ratePerMin: 60,
  webhookUrl: null,
  webhookSecret: null,
  serviceIds: ['24138'],
  ...overrides,
});

describe('ApiKeysRepo', () => {
  it('znajduje klucz po prefiksie razem z listą usług i nadpisów', () => {
    const { keys, accountId } = setup();
    keys.insert(keyInput(accountId, { origs: ['Firma'] }));

    const found = keys.findByPrefix('mig_live_a1b2c3');
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('rejestracja');
    expect(found[0]!.allowedServiceIds).toEqual(['24138']);
    expect(found[0]!.allowedOrigs).toEqual(['Firma']);
    expect(found[0]!.revokedAt).toBeNull();
  });

  it('nie znajduje klucza o innym prefiksie', () => {
    const { keys, accountId } = setup();
    keys.insert(keyInput(accountId));
    expect(keys.findByPrefix('mig_live_zzzzzz')).toHaveLength(0);
  });

  it('zwraca klucz odwołany z wypełnioną datą odwołania', () => {
    const { keys, accountId } = setup();
    const id = keys.insert(keyInput(accountId));
    keys.revoke(id);

    const found = keys.findByPrefix('mig_live_a1b2c3');
    expect(found).toHaveLength(1);
    expect(found[0]!.revokedAt).not.toBeNull();
  });

  it('touch odnotowuje użycie klucza', () => {
    const { keys, accountId } = setup();
    const id = keys.insert(keyInput(accountId));
    expect(keys.list()[0]!.lastUsedAt).toBeNull();

    keys.touch(id);
    expect(keys.list()[0]!.lastUsedAt).not.toBeNull();
  });

  it('znajduje klucz po identyfikatorze', () => {
    const { keys, accountId } = setup();
    const id = keys.insert(keyInput(accountId));
    expect(keys.get(id)?.name).toBe('rejestracja');
    expect(keys.get(id + 1)).toBeUndefined();
  });

  it('nie zwraca sekretu webhooka', () => {
    const { keys, accountId } = setup();
    keys.insert(keyInput(accountId, { webhookUrl: 'https://przyklad.test/hook', webhookSecret: 'tajny-sekret' }));
    expect(JSON.stringify(keys.list())).not.toContain('tajny-sekret');
  });

  it('odrzuca nadpis spoza słownika konta', () => {
    const { keys, accountId } = setup();
    expect(() => keys.insert(keyInput(accountId, { origs: ['Obcy'] }))).toThrow();
  });

  it('usuwa klucze razem z kontem', () => {
    const { db, keys, accountId } = setup();
    keys.insert(keyInput(accountId));
    db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    expect(keys.list()).toHaveLength(0);
  });

  it('przechowuje sekret webhooka zaszyfrowany i oddaje jawny tylko przez webhookSecret()', () => {
    const { db, keys, accountId } = setup();
    const id = keys.insert(keyInput(accountId, { webhookUrl: 'https://crm.example/hook', webhookSecret: 'sekret-abc' }));
    expect(keys.webhookSecret(id)).toBe('sekret-abc');
    const raw = db.prepare('SELECT webhook_secret_enc FROM api_keys WHERE id = ?').get(id) as { webhook_secret_enc: string };
    expect(raw.webhook_secret_enc).not.toContain('sekret-abc');
    keys.setWebhook(id, 'https://crm.example/v2', 'nowy');
    expect(keys.list().find((k) => k.id === id)!.webhookUrl).toBe('https://crm.example/v2');
    expect(keys.webhookSecret(id)).toBe('nowy');
    keys.setWebhook(id, null, null);
    expect(keys.webhookSecret(id)).toBeNull();
    expect(keys.list().find((k) => k.id === id)!.webhookUrl).toBeNull();
  });

  it('webhookSecret zwraca null dla klucza bez sekretu i dla nieznanego klucza', () => {
    const { keys, accountId } = setup();
    const id = keys.insert(keyInput(accountId));
    expect(keys.webhookSecret(id)).toBeNull();
    expect(keys.webhookSecret(id + 100)).toBeNull();
  });

  it('zapisuje i odczytuje datę ważności; bez niej klucz jest bezterminowy', () => {
    const { keys, accountId } = setup();
    const a = keys.insert(keyInput(accountId, { expiresAt: '2026-09-30T22:00:00.000Z' }));
    const b = keys.insert(keyInput(accountId, { keyPrefix: 'mig_live_zzzzzz', keyHash: 'argon2:bbb' }));
    expect(keys.get(a)!.expiresAt).toBe('2026-09-30T22:00:00.000Z');
    expect(keys.get(b)!.expiresAt).toBeNull();
  });

  it('update zmienia pola, usługi i nadpisy, a pominięty sekret webhooka zostawia stary', () => {
    const { keys, db, accountId } = setup();
    db.prepare('INSERT INTO account_services (account_id, service_id) VALUES (?, ?)').run(accountId, '99001');
    const id = keys.insert(keyInput(accountId, { webhookUrl: 'https://a.example/h', webhookSecret: 'stary' }));
    keys.update(id, {
      name: 'Nowa nazwa', defaultServiceId: '99001', defaultOrig: 'Firma',
      maxParts: 3, ratePerMin: 10, webhookUrl: 'https://a.example/h',
      expiresAt: '2026-12-31T23:00:00.000Z', serviceIds: ['99001'], origs: ['Firma'],
    });
    const row = keys.get(id)!;
    expect(row.name).toBe('Nowa nazwa');
    expect(row.allowedServiceIds).toEqual(['99001']);
    expect(row.allowedOrigs).toEqual(['Firma']);
    expect(row.defaultOrig).toBe('Firma');
    expect(row.maxParts).toBe(3);
    expect(row.expiresAt).toBe('2026-12-31T23:00:00.000Z');
    expect(keys.webhookSecret(id)).toBe('stary');
    keys.update(id, { name: 'Nowa nazwa', defaultServiceId: '99001', defaultOrig: null, maxParts: 3, ratePerMin: 10,
      webhookUrl: null, webhookSecret: null, expiresAt: null, serviceIds: ['99001'], origs: [] });
    expect(keys.webhookSecret(id)).toBeNull();
    expect(keys.get(id)!.expiresAt).toBeNull();
    expect(keys.get(id)!.allowedOrigs).toEqual([]);
  });

  it('serviceIdsInUse zbiera usługi czynnych kluczy konta z nazwami kluczy', () => {
    const { keys, db, accountId } = setup();
    db.prepare('INSERT INTO account_services (account_id, service_id) VALUES (?, ?)').run(accountId, '99001');
    keys.insert(keyInput(accountId, { name: 'Sklep', keyPrefix: 'mig_live_aaaaaa', keyHash: 'argon2:sklep', serviceIds: ['24138'], defaultServiceId: '24138' }));
    keys.insert(keyInput(accountId, { name: 'Agencja', keyPrefix: 'mig_live_bbbbbb', keyHash: 'argon2:agencja', serviceIds: ['24138', '99001'], defaultServiceId: '99001' }));
    const stary = keys.insert(keyInput(accountId, { name: 'Stary', keyPrefix: 'mig_live_cccccc', keyHash: 'argon2:stary', serviceIds: ['99001'], defaultServiceId: '99001' }));
    keys.revoke(stary);
    const used = keys.serviceIdsInUse(accountId);
    expect(used.get('24138')).toEqual(['Agencja', 'Sklep']);
    expect(used.get('99001')).toEqual(['Agencja']);
  });
});
