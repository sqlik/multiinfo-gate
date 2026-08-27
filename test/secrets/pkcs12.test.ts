import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Pkcs12Error, readPkcs12 } from '../../src/secrets/pkcs12.ts';

// Materiał testowy powstaje przy wczytywaniu modułu, a nie w beforeAll: warunek
// it.runIf jest sprawdzany już przy zbieraniu testów, więc flaga ustawiona
// później zostawiłaby cały zestaw cicho pominięty.
const dir = mkdtempSync(join(tmpdir(), 'mig-pkcs12-'));
let available = false;
try {
  execFileSync('sh', ['test/fixtures/make-pfx.sh', dir], { stdio: 'pipe' });
  available = true;
} catch {
  available = false;
}

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

let ecAvailable = false;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-days', '30', '-keyout', join(dir, 'ec-key.pem'), '-out', join(dir, 'ec-cert.pem'), '-subj', '/CN=firma_ec'], { stdio: 'pipe' });
  execFileSync('openssl', ['pkcs12', '-legacy', '-export', '-inkey', join(dir, 'ec-key.pem'), '-in', join(dir, 'ec-cert.pem'),
    '-out', join(dir, 'ec.pfx'), '-passout', 'pass:tajne123'], { stdio: 'pipe' });
  ecAvailable = true;
} catch {
  ecAvailable = false;
}

describe('readPkcs12', () => {
  it.runIf(ecAvailable)('odrzuca klucz inny niż RSA zrozumiałym błędem, nie wyjątkiem typu', () => {
    expect(() => readPkcs12(readFileSync(join(dir, 'ec.pfx')), 'tajne123')).toThrow(Pkcs12Error);
    expect(() => readPkcs12(readFileSync(join(dir, 'ec.pfx')), 'tajne123')).toThrow(/RSA/);
  });

  it.runIf(available)('rozpakowuje plik szyfrowany RC2-40', () => {
    const bundle = readPkcs12(readFileSync(join(dir, 'test.pfx')), 'tajne123');
    expect(bundle.certPem).toContain('-----BEGIN CERTIFICATE-----');
    expect(bundle.keyPem).toContain('PRIVATE KEY-----');
    expect(bundle.cn).toBe('firma_test');
    expect(bundle.organization).toBe('Firma Sp. z o.o.');
    expect(bundle.locality).toBe('Warszawa');
    expect(bundle.country).toBe('PL');
    expect(bundle.keyBits).toBe(2048);
  });

  it.runIf(available)('wylicza odcisk SHA-1 zgodny z openssl', () => {
    const bundle = readPkcs12(readFileSync(join(dir, 'test.pfx')), 'tajne123');
    const raw = execFileSync('openssl', ['x509', '-in', join(dir, 'test-cert.pem'), '-noout', '-fingerprint', '-sha1'])
      .toString();
    const expected = raw.trim().split('=')[1]!.toUpperCase();
    expect(bundle.fingerprintSha1).toBe(expected);
  });

  it.runIf(available)('odczytuje daty ważności', () => {
    const bundle = readPkcs12(readFileSync(join(dir, 'test.pfx')), 'tajne123');
    expect(bundle.notBefore.getTime()).toBeLessThan(Date.now() + 60_000);
    expect(bundle.notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it.runIf(available)('odrzuca złe hasło', () => {
    const buf = readFileSync(join(dir, 'test.pfx'));
    expect(() => readPkcs12(buf, 'nie-to-haslo')).toThrow(Pkcs12Error);
  });

  it('odrzuca plik, który nie jest archiwum PKCS#12', () => {
    expect(() => readPkcs12(Buffer.from('to nie jest pfx'), 'x')).toThrow(Pkcs12Error);
  });
});
