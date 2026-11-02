import { describe, expect, it } from 'vitest';
import { addAdminCommand, envFile, logSearch, restartCommand } from '../../src/admin/views/commands.ts';
import { problemUrl, REASON_ANCHOR } from '../../src/docs-links.ts';
import type { StartupReason } from '../../src/startup/reason.ts';

describe('polecenia dla wariantu instalacji', () => {
  it('wyszukanie wpisu w dzienniku Dockera nie wspomina o journalctl', () => {
    const html = logSearch('docker', 'a1b2c3d4');
    expect(html).toContain('docker compose logs multiinfo-gate | grep a1b2c3d4');
    expect(html).not.toContain('journalctl');
  });

  it('w kontenerze LXC wpis wyszukuje journalctl', () => {
    const html = logSearch('lxc', 'a1b2c3d4');
    expect(html).toContain('journalctl -u multiinfo-gate | grep a1b2c3d4');
    expect(html).not.toContain('docker compose');
  });

  it('bez rozpoznanego wariantu pokazuje oba', () => {
    const html = logSearch(null, 'a1b2c3d4');
    expect(html).toContain('docker compose logs');
    expect(html).toContain('journalctl');
  });

  it('identyfikator trafia do HTML jako tekst', () => {
    expect(logSearch('docker', '<b>')).toContain('&lt;b&gt;');
  });

  it('restart, plik z kluczem i zakładanie konta odpowiadają wariantowi', () => {
    expect(restartCommand('docker')).toContain('docker compose restart');
    expect(restartCommand('lxc')).toContain('systemctl restart multiinfo-gate');
    expect(envFile('docker')).toContain('~/multiinfo-gate/docker/.env');
    expect(envFile('lxc')).toContain('/etc/multiinfo-gate/env');
    expect(addAdminCommand('docker')).toContain('docker compose exec multiinfo-gate npm run admin:dodaj -- &lt;login&gt;');
    expect(addAdminCommand('lxc')).toContain('/root/multiinfo-gate.creds');
    expect(addAdminCommand('lxc')).toContain('dist/cli/admin.js');
  });
});

describe('odnośniki do artykułu', () => {
  it('prowadzą do punktu artykułu', () => {
    expect(problemUrl('klucz-glowny')).toBe('https://sqlik.github.io/multiinfo-gate/problemy/#klucz-glowny');
  });

  it('każda przyczyna awarii startu ma swój punkt', () => {
    const reasons: StartupReason[] = ['key_mismatch', 'key_invalid', 'backup_failed', 'newer_database', 'disk_full', 'permissions', 'corrupt', 'migration_failed', 'unknown'];
    for (const r of reasons) expect(REASON_ANCHOR[r]).toMatch(/^[a-z-]+$/);
  });
});
