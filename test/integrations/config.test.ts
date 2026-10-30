import { describe, expect, it } from 'vitest';
import { GROUP_LIMITS, INTEGRATION_KINDS, defaultInboundConfig, defaultMailInConfig, defaultOutboundConfig, defaultSmsGroupConfig, parseConfig } from '../../src/integrations/config.ts';
import { isMailIn, isSmsGroup } from '../../src/store/integrations.ts';

const outbound = () => ({ ...defaultOutboundConfig(), url: 'https://example.invalid/hook' });

describe('parseConfig', () => {
  it('konfiguracja skrzynki bez authservId (zapis sprzed 1.8.3) wczytuje się z pustą nazwą', () => {
    const { authservId: _x, ...stara } = defaultMailInConfig() as Record<string, unknown>;
    expect((parseConfig('mail_in', stara) as { authservId: string }).authservId).toBe('');
  });
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
  it('przyjmuje sekret w polu ładunku', () => {
    const config = parseConfig('webhook_in', { ...defaultInboundConfig(), auth: { sources: [], payload: { path: 'api_token', valueRef: 'payloadToken' } } });
    expect(config.auth.payload).toEqual({ path: 'api_token', valueRef: 'payloadToken' });
  });
  it('odrzuca sekret w polu ładunku z nieprawidłową ścieżką albo bez odniesienia', () => {
    expect(() => parseConfig('webhook_in', { ...defaultInboundConfig(), auth: { sources: [], payload: { path: 'a..b', valueRef: 'payloadToken' } } })).toThrow();
    expect(() => parseConfig('webhook_in', { ...defaultInboundConfig(), auth: { sources: [], payload: { path: 'api_token', valueRef: '' } } })).toThrow();
  });
});

describe('mail_in', () => {
  it('domyślna konfiguracja przechodzi przez schemat i ma bezpieczne wartości', () => {
    const c = parseConfig('mail_in', defaultMailInConfig());
    expect(c.imap).toEqual({ host: '', port: 993, security: 'tls', verifyCert: true, user: '', passRef: 'imap_password' });
    expect([c.folder, c.intervalSec, c.senders, c.requireAuthResults]).toEqual(['INBOX', 60, [], false]);
    expect(c.recipientsFromMail).toEqual({ enabled: false, where: 'subject' });
    expect(c.text).toEqual({ mode: 'simple', variant: 'subject_text' });
    expect([c.maxParts, c.overflow, c.after, c.reply]).toEqual([1, 'truncate', { action: 'keep' }, { enabled: false }]);
    expect([c.clean, c.fields, c.to]).toEqual([{ cutFrom: [] }, [], { fallback: [] }]);
    expect(c.throttle).toEqual({ limit: 10, windowMinutes: 10 });
  });
  it('odrzuca częstotliwość spoza listy, port poza zakresem i nadawcę bez małpy', () => {
    const base = defaultMailInConfig();
    expect(() => parseConfig('mail_in', { ...base, intervalSec: 45 })).toThrow();
    expect(() => parseConfig('mail_in', { ...base, imap: { ...base.imap, port: 70000 } })).toThrow();
    expect(() => parseConfig('mail_in', { ...base, senders: [{ pattern: 'przyklad.pl', recipients: [] }] })).toThrow();
  });
  it('przyjmuje adres oraz domenę nadawcy, wycinki obu rodzajów i przeniesienie do folderu', () => {
    const base = defaultMailInConfig();
    const c = parseConfig('mail_in', {
      ...base,
      senders: [{ pattern: 'jan@przyklad.pl', recipients: ['48601000001'] }, { pattern: '@przyklad.pl', recipients: [] }],
      fields: [{ name: 'kod', mode: 'between', after: 'Error code:' }, { name: 'stan', mode: 'regex', pattern: 'Status: (\\w+)', flags: 'i' }],
      after: { action: 'move', folder: 'Przetworzone' },
    });
    expect(c.senders).toHaveLength(2);
    expect(c.fields[1]).toEqual({ name: 'stan', mode: 'regex', pattern: 'Status: (\\w+)', flags: 'i' });
    expect(c.after).toEqual({ action: 'move', folder: 'Przetworzone' });
  });
  it('odrzuca przeniesienie bez folderu, nazwę pola z wielką literą i wzorzec dłuższy niż 200 znaków', () => {
    const base = defaultMailInConfig();
    expect(() => parseConfig('mail_in', { ...base, after: { action: 'move' } })).toThrow();
    expect(() => parseConfig('mail_in', { ...base, fields: [{ name: 'Kod', mode: 'between', after: 'x' }] })).toThrow();
    expect(() => parseConfig('mail_in', { ...base, fields: [{ name: 'kod', mode: 'regex', pattern: 'a'.repeat(201) }] })).toThrow();
  });
  it('odrzuca wzorzec, który się nie kompiluje', () => {
    const base = defaultMailInConfig();
    expect(() => parseConfig('mail_in', { ...base, fields: [{ name: 'kod', mode: 'regex', pattern: '(' }] })).toThrow();
    expect(() => parseConfig('mail_in', { ...base, fields: [{ name: 'kod', mode: 'regex', pattern: '[a-' }] })).toThrow();
  });
  it('isMailIn rozpoznaje rodzaj po wierszu', () => {
    expect(isMailIn({ kind: 'mail_in' } as never)).toBe(true);
    expect(isMailIn({ kind: 'webhook_in' } as never)).toBe(false);
  });
});

describe('sms_group', () => {
  it('domyślna konfiguracja przechodzi i ma bezpieczne wartości', () => {
    const c = parseConfig('sms_group', defaultSmsGroupConfig());
    expect(c).toMatchObject({ mode: 'lists', senders: [], recipients: [], members: [], prefix: '', text: { mode: 'body' }, confirm: { enabled: false }, maxParts: 1, overflow: 'truncate' });
    expect(c.throttle).toEqual({ limit: 10, windowMinutes: 10 });
    expect(c.eventLogLimit).toBe(200);
  });
  it('odrzuca prefiks ze spacją, numer nieznormalizowany i nazwę dłuższą niż 40 znaków', () => {
    const base = defaultSmsGroupConfig();
    expect(() => parseConfig('sms_group', { ...base, prefix: 'dla dzieci' })).toThrow();
    expect(() => parseConfig('sms_group', { ...base, prefix: 'x'.repeat(21) })).toThrow();
    expect(() => parseConfig('sms_group', { ...base, recipients: ['+48 601 000 001'] })).toThrow();
    expect(() => parseConfig('sms_group', { ...base, senders: [{ phone: '48601000001', name: 'x'.repeat(41) }] })).toThrow();
    expect(() => parseConfig('sms_group', { ...base, mode: 'open' })).toThrow();
  });
  it('nazwa przy numerze jest opcjonalna i wczytuje się jako pusty ciąg', () => {
    expect(parseConfig('sms_group', { ...defaultSmsGroupConfig(), members: [{ phone: '48601000001' }] }).members[0]).toEqual({ phone: '48601000001', name: '' });
  });
  it('isSmsGroup rozpoznaje rodzaj po wierszu, a INTEGRATION_KINDS zawiera sms_group', () => {
    expect(isSmsGroup({ kind: 'sms_group' } as never)).toBe(true);
    expect(isSmsGroup({ kind: 'mail_in' } as never)).toBe(false);
    expect(INTEGRATION_KINDS).toContain('sms_group');
    expect(GROUP_LIMITS).toEqual({ senders: 100, recipients: 500, members: 500, prefix: 20, name: 40 });
  });
});
