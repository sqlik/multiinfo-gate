import { beforeEach, describe, expect, it } from 'vitest';
import { seedAccount, startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';

let h: AdminHarness;
let keyId: number;
beforeEach(async () => {
  h = await startAdminHarness();
  keyId = h.apiKeys.insert({
    accountId: seedAccount(h), name: 'Dyżur IT', keyHash: 'argon2:x', keyPrefix: 'dyzurit1', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 5, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  h.notifications.saveSmsSettings({ enabled: true, apiKeyId: keyId, orig: null, recipients: ['48601000001'] }, new Date('2026-08-25T10:00:00Z'));
});

const save = (site?: string) => h.app.inject({
  method: 'POST', url: '/powiadomienia/sms',
  headers: {
    cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded', host: 'panel.firma.pl',
    ...(site === undefined ? {} : { 'sec-fetch-site': site }),
  },
  payload: new URLSearchParams({ enabled: '1', recipients: '48700000666', apiKeyId: String(keyId), orig: '' }).toString(),
});

describe('formularze panelu z innych stron', () => {
  it('żądanie z sąsiedniej subdomeny (same-site) i z obcej strony kończy się 403 bez zmian', async () => {
    for (const site of ['same-site', 'cross-site']) {
      const res = await save(site);
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('Panel przyjmuje formularze wyłącznie ze swoich stron');
    }
    expect(h.notifications.smsSettings()!.recipients).toEqual(['48601000001']);
  });

  it('formularz panelu (same-origin) i żądanie bez nagłówka Sec-Fetch-Site przechodzą', async () => {
    expect((await save('same-origin')).statusCode).toBe(302);
    expect(h.notifications.smsSettings()!.recipients).toEqual(['48700000666']);
    h.notifications.saveSmsSettings({ enabled: true, apiKeyId: keyId, orig: null, recipients: ['48601000001'] }, new Date('2026-08-25T10:00:00Z'));
    expect((await save()).statusCode).toBe(302);
    expect(h.notifications.smsSettings()!.recipients).toEqual(['48700000666']);
  });

  it('logowanie z obcej strony kończy się 403', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/zaloguj', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
      payload: 'login=janek&password=x',
    });
    expect(res.statusCode).toBe(403);
  });
});
