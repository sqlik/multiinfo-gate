import { describe, expect, it } from 'vitest';
import { emergencyPage } from '../../src/admin/views/emergency.ts';
import { REASON_ANCHOR } from '../../src/docs-links.ts';
import type { StartupReason } from '../../src/startup/reason.ts';

const REASONS: StartupReason[] = ['key_mismatch', 'key_invalid', 'backup_failed', 'newer_database', 'disk_full', 'permissions', 'corrupt', 'migration_failed', 'unknown'];

describe('emergencyPage', () => {
  it.each(REASONS)('dla przyczyny %s podaje nagłówek, identyfikator i właściwy punkt artykułu', (reason) => {
    const html = emergencyPage({ reason, id: 'a1b2c3d4' }, 'docker');
    expect(html).toContain('Bramka nie rozpoczęła pracy');
    expect(html).toContain('a1b2c3d4');
    expect(html).toContain(`https://sqlik.github.io/multiinfo-gate/problemy/#${REASON_ANCHOR[reason]}`);
    expect(html).toContain('docker compose up -d --force-recreate');
    expect(html).not.toContain('journalctl');
  });

  it('każda przyczyna ma własny opis', () => {
    const headlines = REASONS.map((reason) => /<div class="warn">([^<]+)<\/div>/.exec(emergencyPage({ reason, id: 'x' }, null))?.[1]);
    expect(new Set(headlines).size).toBe(REASONS.length);
  });

  it('przy złym kluczu wskazuje plik z kluczem dla wariantu instalacji', () => {
    expect(emergencyPage({ reason: 'key_mismatch', id: 'x' }, 'lxc')).toContain('/etc/multiinfo-gate/env');
    expect(emergencyPage({ reason: 'key_mismatch', id: 'x' }, 'docker')).toContain('~/multiinfo-gate/docker/.env');
  });

  it('identyfikator nie wstrzykuje znaczników', () => {
    const html = emergencyPage({ reason: 'unknown', id: '<script>' }, null);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('przy kluczu w złej postaci nie podaje przyczyn, które tego błędu nie wywołują', () => {
    const html = emergencyPage({ reason: 'key_invalid', id: 'x' }, 'docker');
    expect(html).toContain('pusta albo obcięta');
    expect(html).not.toContain('cudzysłów');
    expect(html).not.toContain('spacja');
  });

  it('przy złym kluczu mówi rzeczowo o kopiach, bez potocznych zwrotów', () => {
    const html = emergencyPage({ reason: 'key_mismatch', id: 'x' }, 'docker');
    expect(html).toContain('są równie nieczytelne');
    expect(html).not.toContain('nie pomogą');
  });
});
