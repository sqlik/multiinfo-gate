import { describe, expect, it } from 'vitest';
import { isPrivateAddress, webhookTarget } from '../../src/net/private-address.ts';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '127.8.8.8', '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.5', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1',
  ])('uznaje %s za adres wewnętrzny', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '172.32.0.1', '172.15.0.1', '8.8.8.8', '2606:4700::1111', '::ffff:93.184.216.34'])(
    'uznaje %s za adres publiczny', (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe('webhookTarget', () => {
  const publicOnly = async () => ['93.184.216.34'];

  it('adres literalny w sieci wewnętrznej rozpoznaje bez pytania DNS', async () => {
    let asked = false;
    const verdict = await webhookTarget('http://172.18.0.1:9000/webhook.php', async () => { asked = true; return []; });
    expect(verdict).toEqual({ kind: 'private', address: '172.18.0.1' });
    expect(asked).toBe(false);
  });

  it('localhost jest adresem wewnętrznym', async () => {
    expect((await webhookTarget('http://localhost:9000/hook', publicOnly)).kind).toBe('private');
    expect((await webhookTarget('http://api.localhost/hook', publicOnly)).kind).toBe('private');
  });

  it('nazwę rozwiązuje i sprawdza każdy adres, także w nawiasach IPv6', async () => {
    expect(await webhookTarget('https://crm.example/hook', publicOnly)).toEqual({ kind: 'public' });
    const mixed = async () => ['93.184.216.34', '10.0.0.7'];
    expect(await webhookTarget('https://crm.example/hook', mixed)).toEqual({ kind: 'private', address: '10.0.0.7' });
    expect((await webhookTarget('http://[::1]:8080/hook', publicOnly)).kind).toBe('private');
  });

  it('nazwa bez adresu daje osobny werdykt', async () => {
    expect((await webhookTarget('https://nie.ma.takiej.example/hook', async () => { throw new Error('ENOTFOUND'); })).kind).toBe('unresolved');
    expect((await webhookTarget('https://pusta.example/hook', async () => [])).kind).toBe('unresolved');
  });

  it('adres, którego nie da się sparsować, też jest nierozwiązany', async () => {
    expect((await webhookTarget('nie-adres', publicOnly)).kind).toBe('unresolved');
  });
});
