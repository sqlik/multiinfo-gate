import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultMailInConfig, type MailInConfig } from '../../src/integrations/config.ts';
import type { ParsedMail } from '../../src/integrations/mail/parse.ts';
import { previewMailIn, runMailIn, type MailInIntegration } from '../../src/integrations/pipeline.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { openDatabase } from '../../src/store/db.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { IntegrationEventsRepo } from '../../src/store/integration-events.ts';
import { IntegrationGuardsRepo } from '../../src/store/integration-guards.ts';
import { IntegrationsRepo } from '../../src/store/integrations.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { accountInput } from '../store/helpers.ts';

const NOW = new Date('2026-10-21T10:00:00Z');
let deps: Parameters<typeof runMailIn>[0];
let integrations: IntegrationsRepo;
let apiKeyId: number;

beforeEach(() => {
  seq = 0;
  const db = openDatabase(':memory:');
  const key = randomBytes(32);
  const accounts = new AccountsRepo(db, key);
  const accountId = accounts.insert(accountInput({ storeContent: 1, origs: ['FIRMA'] }));
  const apiKeys = new ApiKeysRepo(db, key);
  apiKeyId = apiKeys.insert({ accountId, name: 'k', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null, maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], origs: ['FIRMA'] });
  integrations = new IntegrationsRepo(db, key);
  deps = {
    accounts, apiKeys, messages: new MessagesRepo(db), events: new MessageEventsRepo(db), jobs: new JobsRepo(db),
    inbound: new InboundMessagesRepo(db), integrationEvents: new IntegrationEventsRepo(db, key), guards: new IntegrationGuardsRepo(db),
    engine: new TemplateEngine(), integrations,
  };
});

const mail = (over: Partial<ParsedMail> = {}): ParsedMail => ({
  from: 'jan@przyklad.test', fromName: 'Jan', subject: 'Awaria', textFull: 'Serwer padł\n\nPozdrawiam\nJan', date: NOW.toISOString(),
  to: ['bramka@przyklad.test'], messageId: '<m1@przyklad.test>', authResults: [], auto: false, ...over,
});
let seq = 0;
const make = (config: Partial<MailInConfig>, storePayloads: 0 | 1 = 0) => {
  seq += 1;
  const id = integrations.insert({
    name: seq === 1 ? 'Skrzynka' : `Skrzynka ${seq}`, kind: 'mail_in', apiKeyId, serviceId: null, orig: null, preset: 'poczta-wlasny', enabled: 1,
    config: { ...defaultMailInConfig(), senders: [{ pattern: '@przyklad.test', recipients: [] }], to: { fallback: ['48601000009'] }, ...config },
    secrets: { imap_password: 'x' }, storePayloads, createdAt: NOW,
  });
  return integrations.get(id) as MailInIntegration;
};
const events = (id: number) => deps.integrationEvents.list(id, 10).map((e) => [e.result, e.reason]);
const lastBody = (out: { kind: string; messageIds?: string[] }) => deps.messages.get((out as { messageIds: string[] }).messageIds[0]!)!.body;

describe('runMailIn', () => {
  it('z authservId wiadomość z nagłówkiem innego serwera jest pomijana z powodem z nazwą', async () => {
    const integ = make({ requireAuthResults: true, authservId: 'mx.google.com' });
    const out = await runMailIn(deps, integ, mail({ authResults: ['atakujacy.test; dkim=pass header.d=przyklad.test'] }), NOW);
    expect(out).toEqual({ kind: 'skipped', reason: 'auth_failed' });
    expect(events(integ.id)[0]![1]).toContain('brak potwierdzenia SPF/DKIM od serwera mx.google.com');
    const ok = await runMailIn(deps, integ, mail({ authResults: ['atakujacy.test; dkim=fail', 'mx.google.com; dkim=pass header.d=przyklad.test'], messageId: '<m2@przyklad.test>' }), NOW);
    expect(ok.kind).toBe('sent');
  });
  it('tryb prosty: temat i oczyszczona treść idą na stałą listę', async () => {
    const integ = make({});
    const out = await runMailIn(deps, integ, mail(), NOW);
    expect(out.kind).toBe('sent');
    if (out.kind !== 'sent') return;
    const msg = deps.messages.get(out.messageIds[0]!)!;
    expect(msg.dest).toBe('48601000009');
    expect(msg.body).toBe('Awaria\nSerwer padł');
    expect(msg.integrationId).toBe(integ.id);
    expect([out.recipients, out.invalid, out.parts]).toEqual([['48601000009'], [], 1]);
    expect(events(integ.id)).toEqual([['sent', 'temat „Awaria”']]);
  });

  it('stopka firmowa od nazwy nadawcy znika bez frazy administratora, w wysyłce i w podglądzie', async () => {
    const stopka = 'To jest test\n\nJan Kowalski\nSpecjalista ds. IT\n\nPrzyklad Sp. z o.o.\ntel. +48 601000999\n\n[cid:image001.png@01DA0000.11111111]\n\nPrzyklad sp. z o.o. z siedzibą w Warszawie, zarejestrowana w rejestrze';
    const integ = make({});
    const out = await runMailIn(deps, integ, mail({ fromName: 'Kowalski, Jan', textFull: stopka }), NOW);
    expect(out.kind).toBe('sent');
    if (out.kind !== 'sent') return;
    expect(deps.messages.get(out.messageIds[0]!)!.body).toBe('Awaria\nTo jest test');
    expect(out.parts).toBe(1);
    const p = previewMailIn(deps.engine, integ.config, mail({ fromName: 'Jan Kowalski', textFull: stopka }), '48', NOW);
    expect(p.text).toBe('Awaria\nTo jest test');
  });

  it('warianty trybu prostego: tylko temat, tylko treść; pusta część pomijana', async () => {
    expect(lastBody(await runMailIn(deps, make({ text: { mode: 'simple', variant: 'subject' } }), mail(), NOW))).toBe('Awaria');
    expect(lastBody(await runMailIn(deps, make({ text: { mode: 'simple', variant: 'text' } }), mail({ messageId: '<m2@x>' }), NOW))).toBe('Serwer padł');
    expect(lastBody(await runMailIn(deps, make({}), mail({ messageId: '<m3@x>', subject: '' }), NOW))).toBe('Serwer padł');
  });

  it('nadawca spoza listy: skipped sender_not_allowed, bez SMS-a', async () => {
    const integ = make({});
    const out = await runMailIn(deps, integ, mail({ from: 'ktos@inna.pl' }), NOW);
    expect(out).toEqual({ kind: 'skipped', reason: 'sender_not_allowed' });
    expect(events(integ.id)).toEqual([['skipped', 'nadawca spoza listy: ktos@inna.pl · temat „Awaria”']]);
    expect(await runMailIn(deps, make({ senders: [] }), mail(), NOW)).toEqual({ kind: 'skipped', reason: 'sender_not_allowed' });
  });

  it('SPF/DKIM wymagane: bez nagłówka skipped auth_failed, z dkim=pass przechodzi', async () => {
    const integ = make({ requireAuthResults: true });
    expect(await runMailIn(deps, integ, mail(), NOW)).toEqual({ kind: 'skipped', reason: 'auth_failed' });
    expect((await runMailIn(deps, integ, mail({ messageId: '<m2@x>', authResults: ['mx; dkim=pass header.d=przyklad.test'] }), NOW)).kind).toBe('sent');
  });

  it('poziomy odbiorców: numery z maila, potem nadawcy, potem lista', async () => {
    const integ = make({ recipientsFromMail: { enabled: true, where: 'subject' }, senders: [{ pattern: '@przyklad.test', recipients: ['48601000005'] }] });
    const a = await runMailIn(deps, integ, mail({ subject: '601000001, 601000002: Awaria' }), NOW);
    expect(a.kind === 'sent' && a.recipients).toEqual(['48601000001', '48601000002']);
    expect(lastBody(a)).toBe('Awaria\nSerwer padł');
    const b = await runMailIn(deps, integ, mail({ messageId: '<m2@x>' }), NOW);
    expect(b.kind === 'sent' && b.recipients).toEqual(['48601000005']);
    const c = await runMailIn(deps, make({}), mail(), NOW);
    expect(c.kind === 'sent' && c.recipients).toEqual(['48601000009']);
  });

  it('numery w pierwszej linii treści znikają z treści SMS-a', async () => {
    const integ = make({ recipientsFromMail: { enabled: true, where: 'body' } });
    const out = await runMailIn(deps, integ, mail({ textFull: '601000001\nSerwer padł\nPozdrawiam' }), NOW);
    expect(out.kind === 'sent' && out.recipients).toEqual(['48601000001']);
    expect(lastBody(out)).toBe('Awaria\nSerwer padł');
  });

  it('zły numer wśród podanych: SMS do dobrych, lista pominiętych w wyniku i we wpisie; same złe to invalid_phone bez schodzenia niżej', async () => {
    const integ = make({ recipientsFromMail: { enabled: true, where: 'subject' } });
    const a = await runMailIn(deps, integ, mail({ subject: '601000001, 4860100000: Awaria' }), NOW);
    expect(a.kind === 'sent' && [a.recipients, a.invalid]).toEqual([['48601000001'], ['4860100000']]);
    expect(events(integ.id)[0]![1]).toContain('pominięto nieprawidłowe numery: 4860100000');
    const b = await runMailIn(deps, integ, mail({ messageId: '<m2@x>', subject: '4860100000: Awaria' }), NOW);
    expect(b.kind === 'error' && b.code).toBe('invalid_phone');
    expect(deps.messages.list({ limit: 10, offset: 0 })).toHaveLength(1);
  });

  it('nieprawidłowy numer na liście nadawcy albo na stałej liście to invalid_phone, bo wpisał go administrator', async () => {
    const a = await runMailIn(deps, make({ senders: [{ pattern: '@przyklad.test', recipients: ['12'] }] }), mail(), NOW);
    expect(a.kind === 'error' && a.code).toBe('invalid_phone');
    const b = await runMailIn(deps, make({ to: { fallback: ['abc'] } }), mail(), NOW);
    expect(b.kind === 'error' && b.code).toBe('invalid_phone');
  });

  it('51 numerów w temacie nie daje 51 SMS-ów: przedrostek ponad 400 znaków nie jest listą numerów, SMS idzie na stałą listę', async () => {
    const integ = make({ recipientsFromMail: { enabled: true, where: 'subject' } });
    const numbers = Array.from({ length: 51 }, (_, i) => `6010${String(i).padStart(5, '0')}`).join(',');
    const out = await runMailIn(deps, integ, mail({ subject: `${numbers}: Awaria` }), NOW);
    expect(out.kind === 'sent' && out.recipients).toEqual(['48601000009']);
    expect(deps.messages.list({ limit: 100, offset: 0 })).toHaveLength(1);
  });

  it('brak numeru na każdym poziomie: error no_recipient', async () => {
    const integ = make({ to: { fallback: [] } });
    const out = await runMailIn(deps, integ, mail(), NOW);
    expect(out.kind === 'error' && out.code).toBe('no_recipient');
    expect(events(integ.id)[0]![0]).toBe('error');
  });

  it('wycinki i szablon Liquid; wycinki czytają tekst nieoczyszczony', async () => {
    const integ = make({
      fields: [{ name: 'kod', mode: 'between', after: 'Error code:' }, { name: 'stan', mode: 'between', after: 'Status:' }],
      text: { mode: 'liquid', template: 'UPS {{ fields.stan }}, kod {{ fields.kod }}, od {{ from }}' },
    });
    const out = await runMailIn(deps, integ, mail({ textFull: 'Status: ON BATTERY\nPozdrawiam\nError code: E042' }), NOW);
    expect(out.kind).toBe('sent');
    expect(lastBody(out)).toBe('UPS ON BATTERY, kod E042, od jan@przyklad.test');
  });

  it('kontekst szablonu ma klucze z sekcji 8.4: from_name, text_full, date, to, message_id, now, integration.name, p', async () => {
    const integ = make({ text: { mode: 'liquid', template: '{{ from_name }}|{{ text_full | size }}|{{ date }}|{{ to[0] }}|{{ message_id }}|{{ now }}|{{ integration.name }}|{{ p.subject }}' } });
    const out = await runMailIn(deps, integ, mail(), NOW);
    expect(lastBody(out)).toBe(`Jan|27|${NOW.toISOString()}|bramka@przyklad.test|<m1@przyklad.test>|${NOW.toISOString()}|Skrzynka|Awaria`);
  });

  it('błąd wycinka (wyrażenie ponad limit czasu) to error template', async () => {
    const integ = make({ fields: [{ name: 'x', mode: 'regex', pattern: '(a+)+$' }] });
    const out = await runMailIn(deps, integ, mail({ textFull: `${'a'.repeat(40)}!` }), NOW);
    expect(out.kind === 'error' && out.code).toBe('template');
  });

  it('szablon liczy się dopiero po warunku: mail odrzucony warunkiem nie daje błędu szablonu', async () => {
    const integ = make({ condition: { mode: 'builder', rules: [{ path: 'subject', op: 'contains', value: 'Awaria' }] }, text: { mode: 'liquid', template: '{{ subject | nieznany_filtr }}' } });
    expect(await runMailIn(deps, integ, mail({ subject: 'Dzień dobry' }), NOW)).toEqual({ kind: 'skipped', reason: 'condition' });
    const out = await runMailIn(deps, integ, mail({ subject: 'Awaria', messageId: '<m2@x>' }), NOW);
    expect(out.kind === 'error' && out.code).toBe('template');
  });

  it('wpis dziennika ma nadawcę w polu źródła i temat w powodzie (spec 4.5)', async () => {
    const integ = make({});
    await runMailIn(deps, integ, mail({ subject: 'Awaria klimatyzacji' }), NOW);
    await runMailIn(deps, integ, mail({ from: 'obcy@inna.test', subject: '', messageId: '<m2@x>' }), NOW);
    const rows = deps.integrationEvents.list(integ.id, 10);
    expect(rows.map((r) => [r.result, r.sourceIp, r.reason])).toEqual([
      ['skipped', 'obcy@inna.test', 'nadawca spoza listy: obcy@inna.test · temat (bez tematu)'],
      ['sent', 'jan@przyklad.test', 'temat „Awaria klimatyzacji”'],
    ]);
  });

  it('warunek na temacie odsiewa; burza dławi', async () => {
    const integ = make({ condition: { mode: 'builder', rules: [{ path: 'subject', op: 'contains', value: 'Awaria' }] }, throttle: { limit: 1, windowMinutes: 10 } });
    expect(await runMailIn(deps, integ, mail({ subject: 'Dzień dobry' }), NOW)).toEqual({ kind: 'skipped', reason: 'condition' });
    expect((await runMailIn(deps, integ, mail({ subject: 'Awaria 1' }), NOW)).kind).toBe('sent');
    expect(await runMailIn(deps, integ, mail({ subject: 'Awaria 2', messageId: '<m3@x>' }), NOW)).toEqual({ kind: 'throttled', notify: true });
    expect(events(integ.id).map((e) => e[0])).toEqual(['throttled', 'sent', 'skipped']);
  });

  it('pusta treść po czyszczeniu to empty_text; za długa z „odrzuć” to too_many_parts', async () => {
    const empty = await runMailIn(deps, make({ text: { mode: 'simple', variant: 'text' } }), mail({ textFull: 'Pozdrawiam\nJan' }), NOW);
    expect(empty.kind === 'error' && empty.code).toBe('empty_text');
    const long = await runMailIn(deps, make({ overflow: 'reject' }), mail({ textFull: 'x'.repeat(400) }), NOW);
    expect(long.kind === 'error' && long.code).toBe('too_many_parts');
    const cut = await runMailIn(deps, make({}), mail({ textFull: 'x'.repeat(400) }), NOW);
    expect(cut.kind === 'sent' && cut.parts).toBe(1);
  });

  it('klucz nieużyteczny to unavailable z wpisem', async () => {
    const integ = make({});
    deps.apiKeys.revoke(apiKeyId);
    const out = await runMailIn(deps, integ, mail(), NOW);
    expect(out.kind).toBe('unavailable');
  });

  it('przechowywanie ładunków zapisuje nagłówki i tekst, nigdy hasła ani załączników', async () => {
    const integ = make({}, 1);
    await runMailIn(deps, integ, mail(), NOW);
    const payload = deps.integrationEvents.list(integ.id, 1)[0]!.payload!;
    expect(JSON.parse(payload)).toEqual({ from: 'jan@przyklad.test', from_name: 'Jan', subject: 'Awaria', text_full: 'Serwer padł\n\nPozdrawiam\nJan', date: NOW.toISOString(), message_id: '<m1@przyklad.test>' });
    expect(payload).not.toContain('imap_password');
    const bez = make({}, 0);
    await runMailIn(deps, bez, mail({ messageId: '<m2@x>' }), NOW);
    expect(deps.integrationEvents.list(bez.id, 1)[0]!.payload).toBeNull();
  });
});

describe('previewMailIn', () => {
  it('podgląd nic nie wysyła i pokazuje poziom odbiorców, wycinki, treść oraz części', () => {
    const config = { ...defaultMailInConfig(), senders: [{ pattern: '@przyklad.test', recipients: ['48601000005'] }], fields: [{ name: 'kod', mode: 'between' as const, after: 'kod:' }] };
    const p = previewMailIn(deps.engine, config, mail({ textFull: 'kod: E1' }), '48', NOW);
    expect(p).toMatchObject({ senderAllowed: true, recipients: ['48601000005'], recipientsLevel: 'sender', invalid: [], fields: { kod: 'E1' }, cleaned: 'kod: E1', text: 'Awaria\nkod: E1', parts: 1, error: null });
    expect(deps.messages.list({ limit: 1, offset: 0 })).toHaveLength(0);
  });

  it('podgląd: nadawca spoza listy, poziom z maila ze złym numerem, brak odbiorcy, pusty tekst', () => {
    const base = { ...defaultMailInConfig(), senders: [{ pattern: '@przyklad.test', recipients: [] }] };
    expect(previewMailIn(deps.engine, base, mail({ from: 'x@inna.pl' }), '48', NOW).senderAllowed).toBe(false);
    const z = previewMailIn(deps.engine, { ...base, recipientsFromMail: { enabled: true, where: 'subject' } }, mail({ subject: '601000001, 4860100000: Awaria' }), '48', NOW);
    expect([z.recipientsLevel, z.recipients, z.invalid, z.text]).toEqual(['mail', ['48601000001'], ['4860100000'], 'Awaria\nSerwer padł']);
    const brak = previewMailIn(deps.engine, base, mail(), '48', NOW);
    expect([brak.recipientsLevel, brak.recipients]).toEqual(['none', []]);
    const pusty = previewMailIn(deps.engine, { ...base, text: { mode: 'simple', variant: 'text' } }, mail({ textFull: 'Pozdrawiam' }), '48', NOW);
    expect(pusty.error).toBe('Treść SMS-a jest pusta.');
    const liquid = previewMailIn(deps.engine, { ...base, text: { mode: 'liquid', template: '{{ fields.kod }}{% if %}' } }, mail(), '48', NOW);
    expect(liquid.error).not.toBeNull();
  });
});
