import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv, MissingMasterKeyError } from '../../src/config/env.ts';
import { SecretDecryptionError, decryptSecret, encryptSecret } from '../../src/secrets/crypto.ts';

const key = randomBytes(32);

describe('encryptSecret / decryptSecret', () => {
  it('szyfruje i odszyfrowuje tekst', () => {
    const blob = encryptSecret('hasło-multiinfo', key);
    expect(blob).not.toContain('hasło-multiinfo');
    expect(decryptSecret(blob, key)).toBe('hasło-multiinfo');
  });

  it('daje różny szyfrogram przy każdym wywołaniu', () => {
    expect(encryptSecret('to samo', key)).not.toBe(encryptSecret('to samo', key));
  });

  it('odrzuca wartość naruszoną', () => {
    const blob = encryptSecret('hasło', key);
    const parts = blob.split('.');
    parts[3] = Buffer.from('podmiana').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow(SecretDecryptionError);
  });

  it('odrzuca wartość zaszyfrowaną innym kluczem', () => {
    const blob = encryptSecret('hasło', key);
    expect(() => decryptSecret(blob, randomBytes(32))).toThrow(SecretDecryptionError);
  });

  it('obsługuje wielolinijkowy klucz prywatny PEM', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\n';
    expect(decryptSecret(encryptSecret(pem, key), key)).toBe(pem);
  });
});

describe('loadEnv', () => {
  const base = { MIG_MASTER_KEY: randomBytes(32).toString('base64') };

  it('odmawia startu bez klucza głównego', () => {
    expect(() => loadEnv({})).toThrow(MissingMasterKeyError);
  });

  it('odmawia startu, gdy klucz główny nie ma 32 bajtów', () => {
    expect(() => loadEnv({ MIG_MASTER_KEY: Buffer.alloc(16).toString('base64') }))
      .toThrow(MissingMasterKeyError);
  });

  it('stosuje wartości domyślne portów i katalogu danych', () => {
    const cfg = loadEnv(base);
    expect(cfg.apiPort).toBe(8080);
    expect(cfg.adminPort).toBe(8081);
    expect(cfg.dataDir).toBe('/data');
    expect(cfg.backupRetentionDays).toBe(14);
  });

  it('domyślnie wystawia API na wszystkie interfejsy, a panel tylko na pętlę zwrotną', () => {
    const cfg = loadEnv(base);
    expect(cfg.apiHost).toBe('0.0.0.0');
    expect(cfg.adminHost).toBe('127.0.0.1');
    expect(cfg.logLevel).toBe('info');
  });

  it('pozwala nadpisać adresy nasłuchu', () => {
    const cfg = loadEnv({ ...base, MIG_API_HOST: '10.0.0.5', MIG_ADMIN_HOST: '0.0.0.0' });
    expect(cfg.apiHost).toBe('10.0.0.5');
    expect(cfg.adminHost).toBe('0.0.0.0');
  });

  it('nazwę interfejsu w adresie nasłuchu zamienia na jego adres IPv4', () => {
    const interfaces = {
      eth0: [
        { address: 'fe80::1', family: 'IPv6' as const, internal: false },
        { address: '172.30.0.5', family: 'IPv4' as const, internal: false },
      ],
      eth1: [{ address: '172.31.0.5', family: 'IPv4' as const, internal: false }],
    };
    const cfg = loadEnv({ ...base, MIG_ADMIN_HOST: 'eth0', MIG_API_HOST: 'eth1' }, interfaces);
    expect(cfg.adminHost).toBe('172.30.0.5');
    expect(cfg.apiHost).toBe('172.31.0.5');
  });

  it('odrzuca nazwę interfejsu, którego nie ma', () => {
    expect(() => loadEnv({ ...base, MIG_ADMIN_HOST: 'eth7' }, { eth0: [{ address: '172.30.0.5', family: 'IPv4' as const, internal: false }] }))
      .toThrow(/MIG_ADMIN_HOST.*eth7/);
  });

  it('adres IP i nazwę hosta zostawia bez zmian', () => {
    const cfg = loadEnv({ ...base, MIG_ADMIN_HOST: 'localhost' }, {});
    expect(cfg.adminHost).toBe('localhost');
  });

  it('odrzuca nieznany poziom logowania', () => {
    expect(() => loadEnv({ ...base, MIG_LOG_LEVEL: 'verbose' })).toThrow(/MIG_LOG_LEVEL/);
  });

  it('przyjmuje nadpisane porty', () => {
    const cfg = loadEnv({ ...base, MIG_API_PORT: '9000', MIG_ADMIN_PORT: '9001' });
    expect(cfg.apiPort).toBe(9000);
    expect(cfg.adminPort).toBe(9001);
  });
});
