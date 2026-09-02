import { describe, expect, it } from 'vitest';
import { defaultInboundConfig, defaultOutboundConfig, parseConfig } from '../../src/integrations/config.ts';

const outbound = () => ({ ...defaultOutboundConfig(), url: 'https://example.invalid/hook' });

describe('parseConfig', () => {
  it('domyślne konfiguracje przechodzą', () => {
    expect(() => parseConfig('webhook_in', defaultInboundConfig())).not.toThrow();
    expect(() => parseConfig('webhook_out', outbound())).not.toThrow();
  });
  it('wychodząca bez adresu nie przechodzi', () => {
    expect(() => parseConfig('webhook_out', defaultOutboundConfig())).toThrow();
  });
  it('odrzuca złą ścieżkę, zły limit części i pustą listę zdarzeń', () => {
    expect(() => parseConfig('webhook_in', { ...defaultInboundConfig(), to: { path: 'a[]', fallback: [] } })).toThrow();
    expect(() => parseConfig('webhook_in', { ...defaultInboundConfig(), maxParts: 12 })).toThrow();
    expect(() => parseConfig('webhook_out', { ...outbound(), events: [] })).toThrow();
  });
  it('odrzuca metodę spoza listy i nagłówek bez nazwy', () => {
    expect(() => parseConfig('webhook_out', { ...outbound(), method: 'DELETE' })).toThrow();
    expect(() => parseConfig('webhook_out', { ...outbound(), headers: [{ name: '', value: 'x' }] })).toThrow();
  });
});
