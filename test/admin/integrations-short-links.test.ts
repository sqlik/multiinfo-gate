import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-11-05T10:00:00Z');
const TEMPLATE = 'https://l.firma.pl/0000000';
let h: AdminHarness;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  const accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Serwis klimatyzacji', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  const domainId = h.linkDomains.create({ domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, NOW);
  h.apiKeys.setLinkSettings(apiKeyId, { mode: 'sender', domainIds: [domainId], defaultDomainId: domainId, targets: ['firma.pl'], validityDays: 90, utm: true });
});

const post = (fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
  return h.app.inject({ method: 'POST', url: '/integracje', headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: params.toString() });
};
const nothingStored = () => {
  expect(h.campaigns.list({ offset: 0, limit: 10 }).rows).toEqual([]);
  expect(h.integrations.list()).toHaveLength(0);
};

describe('„Sprawdź szablon” przy kluczu ze skracaniem linków', () => {
  it('integracja przychodząca pokazuje krótki link z kodem zastępczym', async () => {
    const res = await post({
      kind: 'webhook_in', preset: 'custom', name: 'Zgłoszenia serwisowe', apiKeyId: String(apiKeyId), serviceId: '', orig: '', enabled: '1',
      authHeaderName: 'Authorization', authHeaderValue: 'Bearer tajny-token', authBasicUser: '', authBasicPass: '', sources: '',
      conditionMode: 'builder', rulePath: [''], ruleOp: ['eq'], ruleValue: [''], conditionExpr: '',
      toPath: '', toFallback: '601000001', ticketRefPath: '', eventIdPath: '',
      textMode: 'liquid', textTemplate: '{{ p.msg }}', textPath: '', maxParts: '1', overflow: 'truncate',
      throttleLimit: '10', throttleWindow: '10', eventLogLimit: '200',
      sample: JSON.stringify({ msg: 'Przegląd klimatyzacji: https://firma.pl/folder.pdf' }), action: 'sprawdz',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`Przegląd klimatyzacji: ${TEMPLATE}`);
    nothingStored();
  });

  it('Mail2SMS pokazuje krótki link z kodem zastępczym', async () => {
    const res = await post({
      kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz', name: 'Zlecenia z poczty', apiKeyId: String(apiKeyId), serviceId: '', orig: '', enabled: '1',
      host: 'imap.firma.pl', port: '993', security: 'tls', verifyCert: 'on', user: 'u', password: 'TajneHaslo9', folder: 'INBOX', intervalSec: '60',
      senders: '@firma.pl', toFallback: '48601000009', textMode: 'simple', textVariant: 'subject_text', maxParts: '1', overflow: 'truncate',
      afterAction: 'keep', afterFolder: '', throttleLimit: '10', throttleWindow: '10', eventLogLimit: '200', conditionMode: 'builder', tryb: 'prosty',
      cutFrom: '', recipientsWhere: 'subject',
      sampleFrom: 'dyspozytor@firma.pl', sampleSubject: 'Zlecenie 12/11', sampleText: 'Protokół: https://firma.pl/protokol/12',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`Protokół: ${TEMPLATE}`);
    nothingStored();
  });

  it('SMS do grupy pokazuje krótki link z kodem zastępczym', async () => {
    const res = await post({
      kind: 'sms_group', preset: 'sms-grupa', action: 'sprawdz', name: 'Ekipa serwisowa', apiKeyId: String(apiKeyId), serviceId: '', orig: '', enabled: '1',
      mode: 'lists', senders: '601 000 001 Ania', recipients: '601000002\n601000003', members: '',
      prefix: 'serwis', textMode: 'body', textTemplate: '', maxParts: '1', overflow: 'truncate', throttleLimit: '10', throttleWindow: '10', eventLogLimit: '200',
      conditionMode: 'builder', tryb: 'prosty', sampleFrom: '', sampleText: 'Serwis: instrukcja https://firma.pl/instrukcja.pdf',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`instrukcja ${TEMPLATE}`);
    nothingStored();
  });
});
