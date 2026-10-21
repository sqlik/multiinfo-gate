import { describe, expect, it } from 'vitest';
import { defaultMailInConfig } from '../../src/integrations/config.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';
import { mailConfigToValues, mailFormToConfig, mailFormValues, mailWarnings, needsAdvanced, sampleMail, type MailFormValues } from '../../src/admin/mail-form.ts';

const engine = new TemplateEngine();
const base = { name: 'Skrzynka', apiKeyId: '1', serviceId: '', orig: '', enabled: true, preset: 'poczta-wlasny', storePayloads: false };
const v = (): MailFormValues => ({ ...mailConfigToValues(defaultMailInConfig(), base), host: 'imap.przyklad.test', user: 'u', password: 'p', senders: '@przyklad.test' });
const NOW = new Date('2026-10-21T10:00:00Z');

describe('mailConfigToValues i mailFormToConfig', () => {
  it('wartości domyślne z konfiguracji i z powrotem dają tę samą konfigurację', () => {
    const back = mailFormToConfig(v(), false, engine);
    expect(back.ok && back.config.imap.host).toBe('imap.przyklad.test');
    expect(back.ok && back.password).toBe('p');
    expect(back.ok && back.config).toEqual({ ...defaultMailInConfig(), imap: { ...defaultMailInConfig().imap, host: 'imap.przyklad.test', user: 'u' }, senders: [{ pattern: '@przyklad.test', recipients: [] }] });
  });

  it('konfiguracja pełna przechodzi w obie strony bez strat', () => {
    const config = {
      ...defaultMailInConfig(),
      imap: { host: 'h', port: 143, security: 'starttls' as const, verifyCert: false, user: 'u', passRef: 'imap_password' as const },
      folder: 'Alarmy', intervalSec: 300 as const,
      senders: [{ pattern: 'jan@przyklad.pl', recipients: ['601000001', '601000002'] }, { pattern: '@przyklad.pl', recipients: [] }],
      requireAuthResults: true, recipientsFromMail: { enabled: true, where: 'body' as const }, to: { fallback: ['48601000009'] },
      clean: { cutFrom: ['Wygenerowano automatycznie'] },
      fields: [{ name: 'kod', mode: 'between' as const, after: 'Error code:', until: '(' }, { name: 'stan', mode: 'regex' as const, pattern: 'Status: (\\w+)', flags: 'i' }],
      text: { mode: 'liquid' as const, template: '{{ fields.stan }}' }, maxParts: 3, overflow: 'reject' as const,
      after: { action: 'move' as const, folder: 'Przetworzone' }, reply: { enabled: true },
      condition: { mode: 'builder' as const, rules: [{ path: 'subject', op: 'contains' as const, value: 'UPS' }] },
    };
    const values = mailConfigToValues(config, base);
    expect(values.senders).toBe('jan@przyklad.pl: 601000001, 601000002\n@przyklad.pl');
    expect(values.fields).toEqual([
      { name: 'kod', mode: 'between', after: 'Error code:', until: '(', pattern: '', flags: '' },
      { name: 'stan', mode: 'regex', after: '', until: '', pattern: 'Status: (\\w+)', flags: 'i' },
    ]);
    expect(values.password).toBe('');
    const back = mailFormToConfig(values, true, engine);
    expect(back.ok && back.config).toEqual(config);
    expect(back.ok && back.password).toBeNull();
    expect(needsAdvanced(config)).toBe(true);
    expect(needsAdvanced(defaultMailInConfig())).toBe(false);
  });

  it('lista nadawców: jedna pozycja na linię, numery po dwukropku rozdzielone przecinkami', () => {
    const r = mailFormToConfig({ ...v(), senders: 'jan@przyklad.pl: 601000001, 601000002\n@przyklad.pl\nups@przyklad.test:' }, false, engine);
    expect(r.ok && r.config.senders).toEqual([
      { pattern: 'jan@przyklad.pl', recipients: ['601000001', '601000002'] }, { pattern: '@przyklad.pl', recipients: [] }, { pattern: 'ups@przyklad.test', recipients: [] },
    ]);
  });

  it('błędy po polsku: brak serwera, brak hasła przy nowej, zły wzorzec nadawcy, przeniesienie bez folderu, wycinek bez nazwy', () => {
    expect(mailFormToConfig({ ...v(), host: '' }, false, engine)).toEqual({ ok: false, error: 'Podaj serwer IMAP.' });
    expect(mailFormToConfig({ ...v(), password: '' }, false, engine)).toEqual({ ok: false, error: 'Podaj hasło skrzynki.' });
    expect(mailFormToConfig({ ...v(), password: '' }, true, engine).ok).toBe(true);
    expect(mailFormToConfig({ ...v(), user: '' }, true, engine)).toEqual({ ok: false, error: 'Podaj login skrzynki.' });
    expect(mailFormToConfig({ ...v(), senders: 'przyklad.pl' }, true, engine)).toEqual({ ok: false, error: 'Nadawca „przyklad.pl”: podaj pełny adres albo domenę z małpą, np. @przyklad.pl.' });
    expect(mailFormToConfig({ ...v(), afterAction: 'move', afterFolder: '' }, true, engine)).toEqual({ ok: false, error: 'Podaj folder, do którego przenosić przetworzone wiadomości.' });
    expect(mailFormToConfig({ ...v(), fields: [{ name: '', mode: 'between', after: 'x', until: '', pattern: '', flags: '' }] }, true, engine)).toEqual({ ok: false, error: 'Wycinek bez nazwy: podaj nazwę małymi literami, np. kod.' });
    expect(mailFormToConfig({ ...v(), fields: [{ name: 'Kod', mode: 'between', after: 'x', until: '', pattern: '', flags: '' }] }, true, engine).ok).toBe(false);
    expect(mailFormToConfig({ ...v(), fields: [{ name: 'kod', mode: 'regex', after: '', until: '', pattern: '(', flags: '' }] }, true, engine).ok).toBe(false);
    expect(mailFormToConfig({ ...v(), port: '70000' }, true, engine).ok).toBe(false);
    expect(mailFormToConfig({ ...v(), intervalSec: '45' }, true, engine).ok).toBe(false);
    expect(mailFormToConfig({ ...v(), textMode: 'liquid', textTemplate: '' }, true, engine)).toEqual({ ok: false, error: 'Szablon treści jest pusty.' });
    expect(mailFormToConfig({ ...v(), name: '' }, true, engine)).toEqual({ ok: false, error: 'Podaj nazwę integracji.' });
    // Pusty wiersz wycinka (zapasowy) jest pomijany.
    expect(mailFormToConfig({ ...v(), fields: [{ name: '', mode: 'between', after: '', until: '', pattern: '', flags: '' }] }, true, engine).ok).toBe(true);
  });

  it('zabezpieczenie „brak” i wyłączone sprawdzanie certyfikatu przechodzą, ale są oznaczone ostrzeżeniem', () => {
    const r = mailFormToConfig({ ...v(), security: 'none', port: '143' }, true, engine);
    expect(r.ok && r.config.imap).toMatchObject({ security: 'none', port: 143 });
    expect(mailWarnings(r.ok ? r.config : defaultMailInConfig())).toEqual(['Połączenie bez szyfrowania: hasło i treść maili idą po sieci jawnym tekstem. Tylko w sieci wewnętrznej']);
    const c = mailFormToConfig({ ...v(), verifyCert: false, recipientsFromMail: true }, true, engine);
    expect(mailWarnings(c.ok ? c.config : defaultMailInConfig())).toEqual([
      'Sprawdzanie certyfikatu wyłączone: połączenie podatne na podsłuch. Tylko dla serwera z własnym certyfikatem bez zaufanego urzędu',
      'Numery z maila włączone: każdy nadawca z listy może wysłać SMS na dowolny numer na koszt konta',
    ]);
    expect(mailWarnings(defaultMailInConfig())).toEqual([]);
  });
});

describe('mailFormValues i sampleMail', () => {
  it('składa wycinki z pól fields[i][...] i pola wyboru', () => {
    const values = mailFormValues({
      name: 'x', host: 'h', 'fields[0][name]': 'kod', 'fields[0][mode]': 'between', 'fields[0][after]': 'Error:', 'fields[0][until]': '',
      'fields[1][name]': 'stan', 'fields[1][mode]': 'regex', 'fields[1][pattern]': 'S: (\\w+)', 'fields[1][flags]': 'i',
      verifyCert: 'on', backlog: 'on', recipientsFromMail: '1', replyEnabled: '1', requireAuthResults: '',
      senders: ' @a.pl \n', cutFrom: 'x', rulePath: ['subject'], ruleOp: ['contains'], ruleValue: ['UPS'],
    });
    expect(values.fields).toEqual([
      { name: 'kod', mode: 'between', after: 'Error:', until: '', pattern: '', flags: '' },
      { name: 'stan', mode: 'regex', after: '', until: '', pattern: 'S: (\\w+)', flags: 'i' },
    ]);
    expect([values.verifyCert, values.backlog, values.recipientsFromMail, values.replyEnabled, values.requireAuthResults]).toEqual([true, true, true, true, false]);
    expect(values.rules).toEqual([{ path: 'subject', op: 'contains', value: 'UPS' }]);
    expect(values.senders).toBe(' @a.pl \n');
  });

  it('próbka: surowy mail przez parseMail, inaczej trzy pola, bez niczego null', async () => {
    const raw = await sampleMail({ ...v(), sampleRaw: 'From: Jan <jan@przyklad.test>\r\nSubject: Alarm\r\n\r\nTreść\r\n' }, NOW);
    expect(raw).toMatchObject({ from: 'jan@przyklad.test', subject: 'Alarm', textFull: 'Treść' });
    const fields = await sampleMail({ ...v(), sampleFrom: 'ups@przyklad.test', sampleSubject: 'Alarm', sampleText: 'Error code: E042' }, NOW);
    expect(fields).toEqual({ from: 'ups@przyklad.test', fromName: '', subject: 'Alarm', textFull: 'Error code: E042', date: NOW.toISOString(), to: [], messageId: null, authResults: [], auto: false });
    expect(await sampleMail(v(), NOW)).toBeNull();
  });
});
