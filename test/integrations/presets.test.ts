import { describe, expect, it } from 'vitest';
import { defaultInboundConfig, defaultOutboundConfig, parseConfig } from '../../src/integrations/config.ts';
import { PRESETS, presetById, presetsFor } from '../../src/integrations/presets/index.ts';
import { previewInbound } from '../../src/integrations/pipeline.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { buildOutboundContext, renderOutbound } from '../../src/worker/integrations.ts';

const engine = new TemplateEngine();
const NOW = new Date('2026-09-02T10:00:00Z');
const received = { id: 'in_1', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text: 'Pomocy, nie działa', receivedAt: NOW.toISOString(), relatedMessageId: null };
const outboundOf = (preset: (typeof PRESETS)[number]) => {
  const config = { ...defaultOutboundConfig(), url: 'https://example.invalid/x', ...preset.outbound };
  if (!/^https?:\/\/[^…]+$/.test(config.url)) config.url = 'https://example.invalid/x';
  return config;
};

describe('gotowe ustawienia', () => {
  it('identyfikatory są unikalne, custom ostatni, rejestr działa', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe('custom');
    expect(presetById('uptime-kuma')?.name).toBe('Uptime Kuma');
    expect(presetById('brak')).toBeUndefined();
    expect(presetsFor('webhook_in').map((p) => p.id)).toEqual(['prosty-json', 'uptime-kuma', 'grafana', 'zabbix', 'home-assistant', 'freescout', 'freshdesk', 'custom']);
    expect(presetsFor('webhook_out').map((p) => p.id)).toEqual(['prosty-json', 'home-assistant', 'freescout', 'freshdesk', 'slack', 'teams', 'ntfy', 'custom']);
  });
  it('każde ustawienie ma konfigurację dla każdego swojego rodzaju, instrukcję i sekrety ze wskazówką', () => {
    for (const p of PRESETS) {
      if (p.kinds.includes('webhook_in')) expect(p.inbound, p.id).toBeDefined();
      if (p.kinds.includes('webhook_out')) expect(p.outbound, p.id).toBeDefined();
      expect(p.guide.length, p.id).toBeGreaterThan(40);
      for (const s of p.secrets ?? []) expect(s.hint.length, `${p.id}:${s.ref}`).toBeGreaterThan(5);
    }
  });
  for (const preset of PRESETS) {
    it(`${preset.id}: konfiguracje domyślne przechodzą walidację`, () => {
      if (preset.inbound) expect(() => parseConfig('webhook_in', { ...defaultInboundConfig(), ...preset.inbound })).not.toThrow();
      if (preset.outbound) expect(() => parseConfig('webhook_out', outboundOf(preset))).not.toThrow();
    });
    it(`${preset.id}: szablony przechodzą walidację silnika`, () => {
      const inboundText = preset.inbound?.text;
      if (inboundText?.mode === 'liquid') expect(engine.validate(inboundText.template)).toBeNull();
      const body = preset.outbound?.body;
      if (body && body.mode !== 'form') expect(engine.validate(body.template)).toBeNull();
      for (const h of preset.outbound?.headers ?? []) if (h.value !== undefined) expect(engine.validate(h.value)).toBeNull();
    });
    if (preset.inbound && preset.sample !== undefined && preset.expect) {
      it(`${preset.id}: przykładowy ładunek daje oczekiwany wynik`, () => {
        const config = { ...defaultInboundConfig(), ...preset.inbound };
        const out = previewInbound(engine, config, preset.sample, '48', NOW);
        expect(out.error).toBeNull();
        if (preset.expect!.skipped) expect(out.matches).toBe(false);
        if (preset.expect!.recipients) expect(out.recipients).toEqual(preset.expect!.recipients);
        if (preset.expect!.text !== undefined) expect(out.text).toBe(preset.expect!.text);
      });
    }
    if (preset.outbound && (preset.expect?.outboundJson || preset.expect?.outboundText !== undefined)) {
      it(`${preset.id}: zdarzenie message.received daje oczekiwane body`, () => {
        const out = renderOutbound(engine, outboundOf(preset), {}, buildOutboundContext('message.received', received, { name: 'Test' }, NOW));
        if (preset.expect!.outboundJson) expect(JSON.parse(out.body)).toEqual(preset.expect!.outboundJson);
        if (preset.expect!.outboundText !== undefined) {
          expect(out.body).toBe(preset.expect!.outboundText);
          expect(out.contentType).toBe('text/plain; charset=utf-8');
        }
      });
    }
  }
  it('ntfy: nagłówki z szablonu dostają numer nadawcy', () => {
    const out = renderOutbound(engine, outboundOf(presetById('ntfy')!), {}, buildOutboundContext('message.received', received, { name: 'Test' }, NOW));
    expect(out.headers['Title']).toBe('SMS od 48601000001');
  });
});
