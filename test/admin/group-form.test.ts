import { describe, expect, it } from 'vitest';
import { defaultSmsGroupConfig, type SmsGroupConfig } from '../../src/integrations/config.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { groupConfigToValues, groupFormToConfig, groupFormValues, groupNeedsAdvanced, groupSampleEvent } from '../../src/admin/group-form.ts';

const engine = new TemplateEngine();
const NOW = new Date('2026-10-30T10:00:00Z');
const base = { name: 'Dzieci', apiKeyId: '1', serviceId: '', orig: '', enabled: '1', preset: 'sms-grupa', throttleLimit: '10', throttleWindow: '10', eventLogLimit: '200', conditionMode: 'builder', mode: 'lists', senders: '601 000 001 Ania', recipients: '+48 601 000 002\n0601000003\n601000002', prefix: 'Dzieci', textMode: 'body', maxParts: '1', overflow: 'truncate' };

describe('groupFormToConfig', () => {
  it('tryb osobnych list: normalizacja, powtórzenia, prefiks zapisany jak wpisano', () => {
    const out = groupFormToConfig(groupFormValues(base), '48', engine);
    expect(out).toMatchObject({ ok: true, config: { mode: 'lists', senders: [{ phone: '48601000001', name: 'Ania' }], recipients: ['48601000002', '48601000003'], members: [], prefix: 'Dzieci', text: { mode: 'body' }, confirm: { enabled: false }, maxParts: 1, overflow: 'truncate' } });
  });
  it.each([
    [{ senders: '' }, 'Podaj co najmniej jeden numer uprawniony do pisania.'],
    [{ senders: Array.from({ length: 101 }, (_, i) => `4860${String(1000000 + i)}`).join('\n') }, 'Numery uprawnione do pisania: najwyżej 100.'],
    [{ recipients: '' }, 'Podaj co najmniej jeden numer odbiorcy.'],
    [{ recipients: Array.from({ length: 501 }, (_, i) => `4860${String(1000000 + i)}`).join('\n') }, 'Numery odbiorców: najwyżej 500.'],
    [{ mode: 'closed', members: '601000001' }, 'Grupa zamknięta wymaga co najmniej dwóch członków.'],
    [{ mode: 'closed', members: Array.from({ length: 501 }, (_, i) => `4860${String(1000000 + i)}`).join('\n') }, 'Numery członków: najwyżej 500.'],
    [{ prefix: 'dla dzieci' }, 'Prefiks: jedno słowo bez spacji, do 20 znaków.'],
    [{ prefix: 'x'.repeat(21) }, 'Prefiks: jedno słowo bez spacji, do 20 znaków.'],
    [{ senders: '12 Jan' }, expect.stringContaining('„12 Jan”')],
    [{ recipients: '601000002\nabc' }, expect.stringContaining('„abc”')],
    [{ textMode: 'liquid', textTemplate: '' }, 'Szablon treści jest pusty.'],
    [{ textMode: 'liquid', textTemplate: '{{ body | nieznany }}' }, expect.stringContaining('Szablon treści')],
    [{ maxParts: '12' }, 'Limit części: podaj liczbę od 1 do 9.'],
    [{ name: '' }, 'Podaj nazwę integracji.'],
  ])('błąd %o', (over, error) => expect(groupFormToConfig(groupFormValues({ ...base, ...over }), '48', engine)).toEqual({ ok: false, error }));
  it('grupa zamknięta: członkowie, listy trybu lists puste; potwierdzenie z pola wyboru', () => {
    const out = groupFormToConfig(groupFormValues({ ...base, mode: 'closed', members: '601000001 Ania\n601000002 Basia', confirmEnabled: 'on' }), '48', engine);
    expect(out).toMatchObject({ ok: true, config: { mode: 'closed', members: [{ phone: '48601000001', name: 'Ania' }, { phone: '48601000002', name: 'Basia' }], senders: [], recipients: [], confirm: { enabled: true } } });
  });
  it('tryb zaawansowany: Liquid w treści, nadmiar odrzucany, więcej części, warunek konstruktora', () => {
    const out = groupFormToConfig(groupFormValues({ ...base, textMode: 'liquid', textTemplate: '{{ sender }}: {{ body }}', overflow: 'reject', maxParts: '3', rulePath: 'body', ruleOp: 'contains', ruleValue: 'pilne' }), '48', engine);
    expect(out).toMatchObject({ ok: true, config: { text: { mode: 'liquid', template: '{{ sender }}: {{ body }}' }, overflow: 'reject', maxParts: 3, condition: { mode: 'builder', rules: [{ path: 'body', op: 'contains', value: 'pilne' }] } } });
    const sb = groupFormToConfig(groupFormValues({ ...base, textMode: 'sender_body' }), '48', engine);
    expect(sb).toMatchObject({ ok: true, config: { text: { mode: 'sender_body' } } });
  });
});

describe('groupConfigToValues i próbka', () => {
  it('odtwarza linie z nazwami, a próbka domyślna bierze pierwszego nadawcę i prefiks', () => {
    const config = (groupFormToConfig(groupFormValues(base), '48', engine) as { config: SmsGroupConfig }).config;
    const v = groupConfigToValues(config, { name: 'Dzieci', apiKeyId: '1', serviceId: '', orig: '', enabled: true, preset: 'sms-grupa', storePayloads: false });
    expect(v).toMatchObject({ senders: '48601000001 Ania', recipients: '48601000002\n48601000003', members: '', prefix: 'Dzieci', mode: 'lists', textMode: 'body', textTemplate: '', confirmEnabled: false, maxParts: '1', overflow: 'truncate', sampleFrom: '', sampleText: '' });
    expect(groupSampleEvent(v, config, NOW)).toMatchObject({ from: '48601000001', text: 'Dzieci Awaria pompy w hali B, proszę o kontakt', kind: 'text', serviceId: '', receivedAt: NOW.toISOString() });
    expect(groupSampleEvent({ ...v, sampleFrom: '+48 601 000 009', sampleText: 'dzieci: halo' }, config, NOW)).toMatchObject({ from: '48601000009', text: 'dzieci: halo' });
    expect(groupSampleEvent({ ...v, sampleFrom: 'INFO' }, config, NOW).from).toBe('INFO');
  });
  it('próbka w grupie zamkniętej bez prefiksu: pierwszy członek i sama treść', () => {
    const config: SmsGroupConfig = { ...defaultSmsGroupConfig(), mode: 'closed', members: [{ phone: '48601000005', name: '' }, { phone: '48601000006', name: '' }] };
    const v = groupConfigToValues(config, { name: 'Z', apiKeyId: '1', serviceId: '', orig: '', enabled: true, preset: 'sms-grupa', storePayloads: false });
    expect(v.members).toBe('48601000005\n48601000006');
    expect(groupSampleEvent(v, config, NOW)).toMatchObject({ from: '48601000005', text: 'Awaria pompy w hali B, proszę o kontakt' });
  });
  it('pełna konfiguracja przechodzi w obie strony bez strat', () => {
    const config: SmsGroupConfig = {
      ...defaultSmsGroupConfig(), mode: 'closed', members: [{ phone: '48601000001', name: 'Ania' }, { phone: '48601000002', name: '' }], prefix: 'zespol',
      text: { mode: 'liquid', template: '{{ sender }}: {{ body }}' }, confirm: { enabled: true }, maxParts: 2, overflow: 'reject',
      condition: { mode: 'liquid', expr: '{{ body contains "x" }}' }, throttle: { limit: 5, windowMinutes: 30 }, eventLogLimit: 100,
    };
    const v = groupConfigToValues(config, { name: 'Z', apiKeyId: '1', serviceId: '', orig: '', enabled: true, preset: 'sms-grupa', storePayloads: false });
    const back = groupFormToConfig(v, '48', engine);
    expect(back).toEqual({ ok: true, config });
  });
});

describe('groupNeedsAdvanced', () => {
  it('Liquid albo warunek; limit części i nadmiar są w trybie prostym', () => {
    const d = defaultSmsGroupConfig();
    expect(groupNeedsAdvanced(d)).toBe(false);
    expect(groupNeedsAdvanced({ ...d, overflow: 'reject' })).toBe(false);
    expect(groupNeedsAdvanced({ ...d, maxParts: 2 })).toBe(false);
    expect(groupNeedsAdvanced({ ...d, text: { mode: 'liquid', template: '{{ body }}' } })).toBe(true);
    expect(groupNeedsAdvanced({ ...d, condition: { mode: 'builder', rules: [{ path: 'body', op: 'contains', value: 'x' }] } })).toBe(true);
    expect(groupNeedsAdvanced({ ...d, text: { mode: 'sender_body' }, confirm: { enabled: true } })).toBe(false);
  });
});
