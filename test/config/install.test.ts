import { describe, expect, it } from 'vitest';
import { detectInstall } from '../../src/config/install.ts';

const only = (...paths: string[]) => (p: string) => paths.includes(p);

describe('detectInstall', () => {
  it('rozpoznaje kontener Dockera po znaczniku środowiska', () => {
    expect(detectInstall(only('/.dockerenv'))).toBe('docker');
    expect(detectInstall(only('/run/.containerenv'))).toBe('docker');
  });

  it('rozpoznaje kontener LXC po pliku konfiguracji instalatora', () => {
    expect(detectInstall(only('/etc/multiinfo-gate/env'))).toBe('lxc');
  });

  it('bez znaczników nie zgaduje', () => {
    expect(detectInstall(only())).toBeNull();
  });
});
