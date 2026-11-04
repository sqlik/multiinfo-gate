import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-11-04T10:00:00Z');

let h: AdminHarness;

beforeEach(async () => {
  h = await startAdminHarness();
});

const page = (tab: 'konfiguracja' | 'reguly' = 'konfiguracja') => h.app.inject({ method: 'GET', url: tab === 'reguly' ? '/powiadomienia?zakladka=reguly' : '/powiadomienia', headers: { cookie: h.cookie } });
const post = (url: string, fields: Record<string, string>) => h.app.inject({
  method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(fields).toString(),
});

const smtpFields = (over: Record<string, string> = {}): Record<string, string> => ({
  host: 'smtp.example', port: '587', security: 'starttls', user: 'bramka@firma.example', password: 'tajne-smtp',
  fromAddress: 'bramka@firma.example', fromName: 'Multiinfo Gate', recipients: 'admin@firma.example\nnoc@firma.example',
  instanceName: 'Firma', panelUrl: 'https://sms.firma.example:8081', ...over,
});

describe('GET /powiadomienia', () => {
  it('bez SMTP: zakładka Konfiguracja z pustym formularzem, zakładka Reguły wyłączona z podpowiedzią', async () => {
    const res = await page();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="host"');
    expect(res.body).toContain('href="/powiadomienia?zakladka=reguly"');
    expect(res.body).not.toContain('Błąd integracji');
    const rules = await page('reguly');
    expect(rules.body).toContain('Reguły wymagają skonfigurowanego serwera SMTP');
    expect(rules.body).toMatch(/name="enabled_integration_error"[^>]*disabled/);
    expect(rules.body).toContain('Błąd integracji');
    expect(rules.body).toContain('Podsumowanie dzienne');
  });
  it('ekran reguł pokazuje „Awaria skrzynki pocztowej” z parametrem minut', async () => {
    const rules = await page('reguly');
    expect(rules.body).toContain('Awaria skrzynki pocztowej');
    expect(rules.body).toMatch(/name="afterMinutes_mailbox_failure"[^>]*value="15"/);
  });
});

describe('POST /powiadomienia/smtp', () => {
  it('zapisuje ustawienia, szyfruje hasło i zostawia je przy pustym polu', async () => {
    const res = await post('/powiadomienia/smtp', smtpFields());
    expect(res.statusCode).toBe(302);
    const saved = h.notifications.smtp()!;
    expect(saved.host).toBe('smtp.example');
    expect(saved.port).toBe(587);
    expect(saved.security).toBe('starttls');
    expect(saved.recipients).toEqual(['admin@firma.example', 'noc@firma.example']);
    expect(saved.panelUrl).toBe('https://sms.firma.example:8081');
    expect(h.notifications.smtpPassword()).toBe('tajne-smtp');
    const raw = h.db.prepare('SELECT password_enc FROM smtp_settings WHERE id = 1').get() as { password_enc: string };
    expect(raw.password_enc).not.toContain('tajne-smtp');

    await post('/powiadomienia/smtp', smtpFields({ password: '', host: 'smtp2.example' }));
    expect(h.notifications.smtp()!.host).toBe('smtp2.example');
    expect(h.notifications.smtpPassword()).toBe('tajne-smtp');

    const shown = await page();
    expect(shown.body).toContain('value="smtp2.example"');
    expect(shown.body).not.toContain('tajne-smtp');
    const rules = await page('reguly');
    expect(rules.body).not.toContain('Reguły wymagają skonfigurowanego serwera SMTP');
    expect(rules.body).not.toMatch(/name="enabled_integration_error"[^>]*disabled/);
  });

  it('tryb bez szyfrowania wymaga potwierdzenia', async () => {
    const res = await post('/powiadomienia/smtp', smtpFields({ security: 'none', port: '25' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('hasło będzie przesyłane jawnie');
    expect(h.notifications.smtp()).toBeNull();
    const ok = await post('/powiadomienia/smtp', smtpFields({ security: 'none', port: '25', plainOk: '1' }));
    expect(ok.statusCode).toBe(302);
    expect(h.notifications.smtp()!.security).toBe('none');
  });

  it('odrzuca zły port, adres bez @ i pustych odbiorców', async () => {
    expect((await post('/powiadomienia/smtp', smtpFields({ port: '70000' }))).statusCode).toBe(400);
    expect((await post('/powiadomienia/smtp', smtpFields({ fromAddress: 'bramka' }))).statusCode).toBe(400);
    expect((await post('/powiadomienia/smtp', smtpFields({ recipients: '' }))).statusCode).toBe(400);
    expect(h.notifications.smtp()).toBeNull();
  });

  it('audyt zapisuje host i odbiorców, nigdy hasła', async () => {
    await post('/powiadomienia/smtp', smtpFields());
    const entry = h.audit.list(10, 0).find((e) => e.action === 'powiadomienia.smtp');
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry!.meta)).toContain('smtp.example');
    expect(JSON.stringify(entry)).not.toContain('tajne-smtp');
  });
});

describe('POST /powiadomienia/smtp/test', () => {
  it('woła mailer z treścią testową i pokazuje wynik', async () => {
    await post('/powiadomienia/smtp', smtpFields());
    const res = await post('/powiadomienia/smtp/test', {});
    expect(res.statusCode).toBe(302);
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]!.subject).toContain('Mail testowy z Multiinfo Gate');
    expect(h.mails[0]!.subject).toContain('Firma');
    const shown = await page();
    expect(shown.body).toContain('flash-ok');
    expect(h.audit.list(10, 0).some((e) => e.action === 'powiadomienia.test')).toBe(true);
  });

  it('pokazuje pełny komunikat serwera przy odrzuceniu', async () => {
    await post('/powiadomienia/smtp', smtpFields());
    h.mailError = new Error('535 5.7.8 Authentication credentials invalid');
    await post('/powiadomienia/smtp/test', {});
    const shown = await page();
    expect(shown.body).toContain('flash-fail');
    expect(shown.body).toContain('535 5.7.8 Authentication credentials invalid');
  });

  it('bez ustawień SMTP nie próbuje wysyłać', async () => {
    await post('/powiadomienia/smtp/test', {});
    expect(h.mails).toHaveLength(0);
    expect((await page()).body).toContain('flash-warn');
  });
});

describe('POST /powiadomienia/reguly', () => {
  it('zapisuje wszystkie reguły naraz i pokazuje je w formularzu', async () => {
    await post('/powiadomienia/smtp', smtpFields());
    const res = await post('/powiadomienia/reguly', {
      enabled_integration_error: '1', maxPerHour_integration_error: '3', groupHours_integration_error: '2',
      maxPerHour_integration_throttled: '5', groupHours_integration_throttled: '0',
      enabled_webhook_undelivered: '1', maxPerHour_webhook_undelivered: '5', groupHours_webhook_undelivered: '1',
      enabled_certificate_expiring: '1', maxPerHour_certificate_expiring: '1', groupHours_certificate_expiring: '0', days_certificate_expiring: '60, 30, 7',
      enabled_account_rejecting: '1', maxPerHour_account_rejecting: '1', groupHours_account_rejecting: '0',
      enabled_inbound_failure: '1', maxPerHour_inbound_failure: '1', groupHours_inbound_failure: '0', afterMinutes_inbound_failure: '30',
      enabled_mailbox_failure: '1', maxPerHour_mailbox_failure: '5', groupHours_mailbox_failure: '0', afterMinutes_mailbox_failure: '20',
      enabled_daily_summary: '1', maxPerHour_daily_summary: '1', groupHours_daily_summary: '0', hour_daily_summary: '7',
    });
    expect(res.statusCode).toBe(302);
    const rules = new Map(h.notifications.rules().map((r) => [r.event, r]));
    expect(rules.get('integration_error')).toMatchObject({ enabled: 1, maxPerHour: 3, groupHours: 2 });
    expect(rules.get('integration_throttled')!.enabled).toBe(0);
    expect(rules.get('certificate_expiring')!.params).toEqual({ days: [60, 30, 7] });
    expect(rules.get('inbound_failure')!.params).toEqual({ afterMinutes: 30 });
    expect(rules.get('mailbox_failure')!.params).toEqual({ afterMinutes: 20 });
    expect(rules.get('daily_summary')).toMatchObject({ enabled: 1, params: { hour: 7 } });
    const shown = await page('reguly');
    expect(shown.body).toContain('value="60, 30, 7"');
    expect(shown.body).toMatch(/name="maxPerHour_integration_error"[^>]*value="3"/);
    const entry = h.audit.list(10, 0).find((e) => e.action === 'powiadomienia.reguly');
    expect(JSON.stringify(entry!.meta)).toContain('integration_error');
  });

  it('odrzuca dni spoza zakresu i godzinę spoza doby', async () => {
    await post('/powiadomienia/smtp', smtpFields());
    const bad = await post('/powiadomienia/reguly', { days_certificate_expiring: 'abc', hour_daily_summary: '8' });
    expect(bad.statusCode).toBe(400);
    expect((await post('/powiadomienia/reguly', { days_certificate_expiring: '30', hour_daily_summary: '25' })).statusCode).toBe(400);
  });
});

describe('SMTP przez konto Microsoft 365', () => {
  const account = (state: 'connected' | 'needs_login' = 'connected', name = 'Dyżur IT'): number => {
    const id = h.m365Accounts.create({ name, tenant: 'firma.onmicrosoft.com', clientId: '11111111-2222-3333-4444-555555555555' }, NOW);
    h.m365Accounts.connected(id, {
      refreshToken: 'token-odswiezania-0', address: 'alarmy@firma.pl', addressManual: false, loginName: 'alarmy@firma.pl', loginOid: null,
      redirectUri: 'http://localhost:8081/m365/powrot', by: 'janek',
    }, NOW);
    if (state === 'needs_login') h.m365Accounts.failed(id, { state: 'needs_login', code: '70000', message: 'x' }, NOW);
    return id;
  };
  // Pola serwera celowo obce: w trybie Microsoft 365 zapis je pomija.
  const m365Fields = (accountId: number, over: Record<string, string> = {}): Record<string, string> => smtpFields({
    authMode: 'm365', m365AccountId: String(accountId), host: 'evil.example', port: '25', security: 'none', user: 'ktos@evil.example', password: '',
    fromAddress: '', ...over,
  });

  it('formularz oferuje wybór sposobu logowania i listę kont Microsoft 365 z pierwszym połączonym kontem wybranym', async () => {
    const broken = account('needs_login', 'Biuro handlowe');
    const id = account();
    const body = (await page()).body;
    expect(body).toContain('Sposób logowania');
    expect(body).toMatch(/<input type="radio" name="authMode" value="password" checked>/);
    expect(body).toMatch(/<input type="radio" name="authMode" value="m365">/);
    expect(body).toContain(`<option value="${broken}">Biuro handlowe · wymaga logowania</option>`);
    expect(body).toContain(`<option value="${id}" selected>Dyżur IT · połączone</option>`);
    expect(body).toContain('Wyślij jako');
  });

  it('bez kont formularz odsyła do dodania konta zamiast listy', async () => {
    const body = (await page()).body;
    expect(body).toContain('href="/microsoft-365/nowe"');
    expect(body).not.toContain('name="m365AccountId"');
  });

  it('zapis bez hasła ustawia serwer Microsoftu, login z konta i domyślny adres nadawcy', async () => {
    await post('/powiadomienia/smtp', smtpFields());
    const id = account();
    const res = await post('/powiadomienia/smtp', m365Fields(id));
    expect(res.statusCode).toBe(302);
    expect(h.notifications.smtp()).toMatchObject({
      authMode: 'm365', m365AccountId: id, host: 'smtp.office365.com', port: 587, security: 'starttls', user: 'alarmy@firma.pl', fromAddress: 'alarmy@firma.pl',
    });
    expect(h.notifications.smtpPassword()).toBeNull();
    const shown = (await page()).body;
    expect(shown).toMatch(/<input type="radio" name="authMode" value="m365" checked>/);
    expect(shown).toContain(`<option value="${id}" selected>Dyżur IT · połączone</option>`);
  });

  it('inny adres nadawcy zostaje zapisany', async () => {
    const id = account();
    await post('/powiadomienia/smtp', m365Fields(id, { fromAddress: 'biuro@firma.pl' }));
    expect(h.notifications.smtp()!.fromAddress).toBe('biuro@firma.pl');
  });

  it('odrzuca konto spoza listy', async () => {
    const res = await post('/powiadomienia/smtp', m365Fields(999));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Wybierz konto Microsoft 365');
    expect(h.notifications.smtp()).toBeNull();
  });

  it('dziennik zdarzeń odnotowuje zmianę sposobu logowania, a zapis bez zmiany sposobu jej nie powtarza', async () => {
    await post('/powiadomienia/smtp', smtpFields());
    const id = account();
    await post('/powiadomienia/smtp', m365Fields(id));
    await post('/powiadomienia/smtp', m365Fields(id, { fromAddress: 'biuro@firma.pl' }));
    const entries = h.audit.list(20, 0).filter((e) => e.action === 'powiadomienia.smtp.sposob');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.meta).toMatchObject({ z: 'password', na: 'm365', konto: 'Dyżur IT' });
  });

  it('mail testowy przekazuje mailerowi token konta i stały serwer Microsoftu', async () => {
    const id = account();
    await post('/powiadomienia/smtp', m365Fields(id));
    await post('/powiadomienia/smtp/test', {});
    expect(h.mails).toHaveLength(1);
    expect(h.mailSettings[0]).toMatchObject({ host: 'smtp.office365.com', port: 587, security: 'starttls', user: 'alarmy@firma.pl', password: null, accessToken: 'token-dostepu-1' });
    expect((await page()).body).toContain('flash-ok');
  });

  it('mail testowy z odpowiedzią 5.7.139 pokazuje podpowiedź obok komunikatu serwera', async () => {
    const id = account();
    await post('/powiadomienia/smtp', m365Fields(id));
    h.mailError = new Error('535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox');
    await post('/powiadomienia/smtp/test', {});
    const shown = (await page()).body;
    expect(shown).toContain('flash-fail');
    expect(shown).toContain('uwierzytelniony protokół SMTP');
    expect(shown).toContain('SmtpClientAuthentication is disabled');
  });

  it('mail testowy przy koncie wymagającym logowania nie łączy się z serwerem', async () => {
    const id = account('needs_login');
    await post('/powiadomienia/smtp', m365Fields(id));
    await post('/powiadomienia/smtp/test', {});
    expect(h.mailSettings).toHaveLength(0);
    const shown = (await page()).body;
    expect(shown).toContain('flash-fail');
    expect(shown).toContain('Konto Microsoft 365 wymaga logowania');
  });
});
