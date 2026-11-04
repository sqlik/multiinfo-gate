import { describe, expect, it } from 'vitest';
import { nodeUpdateNeeded, NODE_PATCHED } from '../../src/runtime/node-version.ts';

describe('nodeUpdateNeeded', () => {
  it('linie 22, 24 i 26 poniżej progu wymagają progu tej linii', () => {
    expect(nodeUpdateNeeded('v22.23.3')).toBe('22.23.4');
    expect(nodeUpdateNeeded('v22.9.0')).toBe('22.23.4');
    expect(nodeUpdateNeeded('v24.22.0')).toBe('24.22.1');
    expect(nodeUpdateNeeded('v26.12.0')).toBe('26.12.1');
  });
  it('wersje z poprawkami z 21 października 2026 i nowsze nie wymagają aktualizacji', () => {
    expect(nodeUpdateNeeded('v22.23.4')).toBeNull();
    expect(nodeUpdateNeeded('v22.24.0')).toBeNull();
    expect(nodeUpdateNeeded('v24.22.1')).toBeNull();
    expect(nodeUpdateNeeded('v26.13.0')).toBeNull();
    expect(nodeUpdateNeeded('v27.0.0')).toBeNull();
  });
  it('linie nieparzyste i starsze niż 22 wymagają przejścia na 22.23.4', () => {
    expect(nodeUpdateNeeded('v25.9.0')).toBe('22.23.4');
    expect(nodeUpdateNeeded('v23.11.1')).toBe('22.23.4');
    expect(nodeUpdateNeeded('v20.19.0')).toBe('22.23.4');
  });
  it('przyjmuje wersję bez litery v, a wersji nieczytelnej nie uznaje za bezpieczną', () => {
    expect(nodeUpdateNeeded('22.23.3')).toBe('22.23.4');
    expect(nodeUpdateNeeded('nieznana')).toBe('22.23.4');
  });
  it('progi są wersjami z wydania bezpieczeństwa Node z 21 października 2026', () => {
    expect(NODE_PATCHED).toEqual({ 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' });
  });
});
