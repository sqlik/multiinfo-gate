import { describe, expect, it } from 'vitest';
import { defaultInboundConfig, defaultOutboundConfig, parseConfig, type InboundConfig } from '../../src/integrations/config.ts';
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
    expect(presetsFor('webhook_in').map((p) => p.id)).toEqual(['prosty-json', 'uptime-kuma', 'grafana', 'zabbix', 'freescout-zgloszenie', 'freshdesk-zgloszenie', 'custom']);
    expect(presetsFor('webhook_out').map((p) => p.id)).toEqual(['prosty-json', 'freescout', 'freshdesk', 'ntfy', 'custom']);
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

  it('Grafana: powrót daje OK, cztery alerty w grupie dają trzy nazwy i licznik', () => {
    const preset = presetById('grafana')!;
    const config = { ...defaultInboundConfig(), ...preset.inbound } as InboundConfig;
    const alert = (alertname: string, status = 'firing') => ({ status, labels: { alertname, grafana_folder: 'Alerty' }, annotations: {}, values: null });
    // Kształt „resolved” z Grafany 13.2.0: values null, title [RESOLVED], state ok.
    const resolved = previewInbound(engine, config, {
      receiver: 'sms', status: 'resolved', alerts: [alert('CPU high', 'resolved')],
      groupKey: '{}:{alertname="CPU high", grafana_folder="Alerty"}', title: '[RESOLVED] CPU high Alerty (web-1 critical)', state: 'ok',
    }, '48', NOW);
    expect(resolved.error).toBeNull();
    expect(resolved.text).toBe('OK: CPU high');
    const many = previewInbound(engine, config, { receiver: 'sms', status: 'firing', alerts: [alert('CPU high'), alert('Disk full'), alert('Swap'), alert('Load')] }, '48', NOW);
    expect(many.text).toBe('ALARM: CPU high, Disk full, Swap (+1)');
  });

  it('Zabbix: ładunek RESOLVED ma inny identyfikator niż PROBLEM i daje temat rozwiązania', () => {
    const preset = presetById('zabbix')!;
    const config = { ...defaultInboundConfig(), ...preset.inbound } as InboundConfig;
    const out = previewInbound(engine, config, {
      to: '48601000001', subject: 'Resolved in 1m 1s: High CPU utilization on web-1',
      message: 'Problem has been resolved at 18:57:38 on 2026.09.02\r\nProblem name: High CPU utilization on web-1\r\nProblem duration: 1m 1s\r\nHost: web-1\r\nSeverity: High\r\nOriginal problem ID: 26\r\n',
      eventId: '26:RESOLVED', status: 'RESOLVED',
    }, '48', NOW);
    expect(out.error).toBeNull();
    expect(out.recipients).toEqual(['48601000001']);
    expect(out.text).toBe('Resolved in 1m 1s: High CPU utilization on web-1');
    expect((preset.sample as { eventId: string }).eventId).not.toBe('26:RESOLVED');
  });

  it('Uptime Kuma: ładunek z przycisku „Test” (bez heartbeat) daje sam komunikat, UP daje OK', () => {
    const preset = presetById('uptime-kuma')!;
    const config = { ...defaultInboundConfig(), ...preset.inbound } as InboundConfig;
    const test = previewInbound(engine, config, { heartbeat: null, monitor: null, msg: 'webhook Testing' }, '48', NOW);
    expect(test.text).toBe('webhook Testing');
    const up = previewInbound(engine, config, {
      heartbeat: { monitorID: 54, status: 1, time: '2026-09-02 17:06:33.919', msg: '200 - OK', ping: 473, important: true, retries: 0 },
      monitor: { id: 54, name: 'Strona firmowa', url: 'https://firma.example' }, msg: '[Strona firmowa] [✅ Up] 200 - OK',
    }, '48', NOW);
    expect(up.text).toBe('OK: Strona firmowa - 200 - OK');
    // Z warunkiem z instrukcji ani UP, ani „Test” nie wysyła SMS-a.
    const withRule = { ...config, condition: { mode: 'builder' as const, rules: [{ path: 'heartbeat.status', op: 'eq' as const, value: '0' }] } };
    expect(previewInbound(engine, withRule, { heartbeat: null, monitor: null, msg: 'webhook Testing' }, '48', NOW).matches).toBe(false);
  });


  it('helpdeski: odpowiedź klienta ma inny nagłówek SMS-a niż nowe zgłoszenie', () => {
    const fs = presetById('freescout-zgloszenie')!;
    const fsConfig = { ...defaultInboundConfig(), ...fs.inbound } as InboundConfig;
    const reply = previewInbound(engine, fsConfig, { ...(fs.sample as object), threadsCount: 3 }, '48', NOW);
    expect(reply.text).toMatch(/^Odpowiedz klienta w #10143/);
    const fd = presetById('freshdesk-zgloszenie')!;
    const fdConfig = { ...defaultInboundConfig(), ...fd.inbound } as InboundConfig;
    const fdReply = previewInbound(engine, fdConfig, { ...(fd.sample as object), event: 'odpowiedz', subject: 'Nie działa' }, '48', NOW);
    expect(fdReply.text).toMatch(/^Odpowiedz klienta w #6541: Nie dziala - /);
  });

  it('Freshdesk: odpowiedź klienta z e-maila bez cytowanej korespondencji', () => {
    const fd = presetById('freshdesk-zgloszenie')!;
    const config = { ...defaultInboundConfig(), ...fd.inbound } as InboundConfig;
    const text = "Jan Nowak : <div>To jest odpowiedź klienta</div><div><br></div><div>----- Original message -----</div><div></div><div class='freshdesk_quote'><blockquote class='freshdesk_quote'><div>From: Support</div><div>Subject: Re: [#6541] Nie działa</div></blockquote></div>";
    const out = previewInbound(engine, config, { event: 'odpowiedz', ticket_id: '6541', text }, '48', NOW);
    expect(out.text).toBe('Odpowiedz klienta w #6541 - Jan Nowak : To jest odpowiedz klienta');
  });
});
