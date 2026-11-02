import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { SettingsRepo } from '../../src/store/settings.ts';

describe('SettingsRepo: wersja bramki', () => {
  it('nie zna wersji, dopóki jej nie zapisano', () => {
    const settings = new SettingsRepo(openDatabase(':memory:'));
    expect(settings.gateVersion()).toBeNull();
    settings.setGateVersion('1.8.7', new Date('2026-11-02T10:00:00Z'));
    expect(settings.gateVersion()).toBe('1.8.7');
  });
});
