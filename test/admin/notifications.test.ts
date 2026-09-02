import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';

let h: AdminHarness;

beforeEach(async () => {
  h = await startAdminHarness();
});

const page = () => h.app.inject({ method: 'GET', url: '/powiadomienia', headers: { cookie: h.cookie } });
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
  it('bez SMTP pokazuje pusty formularz i wyłączoną tabelę reguł', async () => {
    const res = await page();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Najpierw skonfiguruj SMTP');
    expect(res.body).toContain('name="host"');
    expect(res.body).toMatch(/name="enabled_integration_error"[^>]*disabled/);
    expect(res.body).toContain('Błąd integracji');
    expect(res.body).toContain('Podsumowanie dzienne');
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
    expect(shown.body).not.toContain('Najpierw skonfiguruj SMTP');
    expect(shown.body).not.toMatch(/name="enabled_integration_error"[^>]*disabled/);
  });

  it('tryb bez szyfrowania wymaga potwierdzenia', async () => {
    const res = await post('/powiadomienia/smtp', smtpFields({ security: 'none', port: '25' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('hasło pójdzie jawnie');
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
      enabled_daily_summary: '1', maxPerHour_daily_summary: '1', groupHours_daily_summary: '0', hour_daily_summary: '7',
    });
    expect(res.statusCode).toBe(302);
    const rules = new Map(h.notifications.rules().map((r) => [r.event, r]));
    expect(rules.get('integration_error')).toMatchObject({ enabled: 1, maxPerHour: 3, groupHours: 2 });
    expect(rules.get('integration_throttled')!.enabled).toBe(0);
    expect(rules.get('certificate_expiring')!.params).toEqual({ days: [60, 30, 7] });
    expect(rules.get('inbound_failure')!.params).toEqual({ afterMinutes: 30 });
    expect(rules.get('daily_summary')).toMatchObject({ enabled: 1, params: { hour: 7 } });
    const shown = await page();
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
