import { describe, expect, it } from 'vitest';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { openDatabase } from '../../src/store/db.ts';
import { accountInput, testKey } from './helpers.ts';

const setup = () => {
  const key = testKey();
  return { repo: new AccountsRepo(openDatabase(':memory:'), key), key };
};

describe('AccountsRepo', () => {
  it('zapisuje konto i odczytuje jego opis', () => {
    const { repo } = setup();
    const id = repo.insert(accountInput({ origs: ['Firma Info'] }));

    const row = repo.get(id);
    expect(row?.name).toBe('Firma');
    expect(row?.login).toBe('firma_api');
    expect(row?.certCn).toBe('firma_test');
    expect(row?.active).toBe(1);
    expect(repo.serviceIds(id)).toEqual(['24138']);
    expect(repo.origs(id)).toEqual(['Firma Info']);
  });

  it('odszyfrowuje sekrety wyłącznie przez getSecrets', () => {
    const { repo } = setup();
    const id = repo.insert(accountInput());

    const secrets = repo.getSecrets(id);
    expect(secrets.password).toBe('hasło-operatora');
    expect(secrets.certPem).toContain('BEGIN CERTIFICATE');
    expect(secrets.keyPem).toContain('BEGIN PRIVATE KEY');
    expect(secrets.caPem).toBeNull();
  });

  it('nie zwraca żadnego sekretu przez list ani get', () => {
    const { repo } = setup();
    const id = repo.insert(accountInput());

    const serialized = JSON.stringify([repo.list(), repo.get(id)]);
    expect(serialized).not.toContain('hasło-operatora');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).not.toContain('BEGIN CERTIFICATE');
    expect(Object.keys(repo.get(id)!)).not.toContain('passwordEnc');
  });

  it('nie odczyta sekretów innym kluczem głównym', () => {
    const { repo } = setup();
    const id = repo.insert(accountInput());
    expect(() => repo.getSecrets(id, testKey())).toThrow();
  });

  it('wstrzymuje konto z powodem i zdejmuje wstrzymanie', () => {
    const { repo } = setup();
    const id = repo.insert(accountInput());

    repo.pause(id, 'certyfikat wygasa za 3 dni');
    expect(repo.get(id)?.active).toBe(0);
    expect(repo.get(id)?.pausedReason).toBe('certyfikat wygasa za 3 dni');

    repo.resume(id);
    expect(repo.get(id)?.active).toBe(1);
    expect(repo.get(id)?.pausedReason).toBeNull();
  });

  it('podmienia słownik nadpisów w całości', () => {
    const { repo } = setup();
    const id = repo.insert(accountInput({ origs: ['Stary'] }));

    repo.setOrigs(id, [{ orig: 'Firma Info', label: 'powiadomienia' }, { orig: 'Firma', label: null }]);
    expect(repo.origs(id)).toEqual(['Firma', 'Firma Info']);
  });

  it('update zmienia pola i listę ID usług, puste hasło zostawia stare', () => {
    const { repo, key } = setup();
    const id = repo.insert(accountInput({ serviceIds: ['24138', '99001'] }));
    repo.update(id, { name: 'Firma 2', baseUrl: 'https://api1.multiinfo.plus.pl/Api61/',
      defaultCountryCode: '49', storeContent: 1, serviceIds: ['99001', '77007'] });
    const row = repo.get(id)!;
    expect(row.name).toBe('Firma 2');
    expect(row.baseUrl).toBe('https://api1.multiinfo.plus.pl/Api61/');
    expect(row.defaultCountryCode).toBe('49');
    expect(row.storeContent).toBe(1);
    expect(repo.serviceIds(id)).toEqual(['77007', '99001']);
    expect(repo.getSecrets(id, key).password).toBe('hasło-operatora');
    repo.update(id, { name: 'Firma 2', baseUrl: row.baseUrl, password: 'nowe', defaultCountryCode: '49',
      storeContent: 1, serviceIds: ['99001'] });
    expect(repo.getSecrets(id, key).password).toBe('nowe');
    expect(repo.serviceIds(id)).toEqual(['99001']);
  });
});
