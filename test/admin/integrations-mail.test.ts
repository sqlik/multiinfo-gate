import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-10-21T10:00:00Z');
let h: AdminHarness;
let apiKeyId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  const accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Monitoring NOC', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
});

const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string, fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
  return h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: params.toString() });
};
const formBody = (over: Record<string, string | string[]> = {}): Record<string, string | string[]> => ({
  name: 'Alarmy z UPS-a', apiKeyId: String(apiKeyId), serviceId: '', orig: '', enabled: '1',
  host: 'imap.przyklad.test', port: '993', security: 'tls', verifyCert: 'on', user: 'u', password: 'TajneHaslo9', folder: 'INBOX', intervalSec: '60',
  senders: '@przyklad.test', toFallback: '48601000009', textMode: 'simple', textVariant: 'subject_text', maxParts: '1', overflow: 'truncate',
  afterAction: 'keep', afterFolder: '', throttleLimit: '10', throttleWindow: '10', eventLogLimit: '200', conditionMode: 'builder', tryb: 'prosty',
  cutFrom: '', recipientsWhere: 'subject', ...over,
});

describe('formularz skrzynki', () => {
  it('kafelek „Z poczty” prowadzi do wyboru ustawienia poczty, a ten do formularza skrzynki w trybie prostym', async () => {
    expect((await get('/integracje/nowa')).body).toContain('rodzaj=mail_in');
    const choose = await get('/integracje/nowa?rodzaj=mail_in');
    expect(choose.body).toContain('Własny serwer');
    expect(choose.body).toContain('Gdzie jest skrzynka?');
    const form = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-wlasny')).body;
    expect(form).toContain('Serwer IMAP');
    expect(form).toContain('Kto może wysyłać');
    expect(form).toContain('Sprawdź połączenie');
    expect(form).not.toContain('Szablon Liquid');
    expect(form).not.toContain('Sprawdzaj certyfikat');
    const advanced = (await get('/integracje/nowa?rodzaj=mail_in&ustawienie=poczta-wlasny&tryb=zaawansowany')).body;
    expect(advanced).toContain('Szablon Liquid');
    expect(advanced).toContain('Sprawdzaj certyfikat');
  });

  it('zapis tworzy integrację mail_in z zaszyfrowanym hasłem, stanem skrzynki i progiem od teraz; pole zaległych ustawia backlog', async () => {
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ backlog: 'on' }) });
    expect(res.statusCode).toBe(302);
    const row = h.integrations.list()[0]!;
    expect(row.kind).toBe('mail_in');
    expect(row.config).toMatchObject({ imap: { host: 'imap.przyklad.test', port: 993, security: 'tls', verifyCert: true, user: 'u' }, senders: [{ pattern: '@przyklad.test', recipients: [] }] });
    expect(h.integrations.secrets(row.id)).toEqual({ imap_password: 'TajneHaslo9' });
    expect(h.mailIn.state(row.id)).toMatchObject({ backlog: 1, uidFloor: 0 });
    expect(h.audit.list(10, 0)[0]!.meta.sekrety).toEqual(['imap_password']);
    expect(JSON.stringify(h.audit.list(10, 0))).not.toContain('TajneHaslo9');
  });

  it('błąd formularza wraca stroną z komunikatem i bez zapisu; hasło nie wraca do formularza', async () => {
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ host: '' }) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Podaj serwer IMAP.');
    expect(res.body).not.toContain('TajneHaslo9');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('edycja bez nowego hasła zachowuje stare; z nowym podmienia; zmiana folderu zeruje próg', async () => {
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody() });
    const row = h.integrations.list()[0]!;
    h.mailIn.setFloor(row.id, 5, 7);
    const edit = await get(`/integracje/${row.id}/edytuj`);
    expect(edit.body).toContain('hasło zapisane');
    expect(edit.body).not.toContain('TajneHaslo9');
    expect((await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', name: 'Inna nazwa' }))).statusCode).toBe(302);
    expect(h.integrations.secrets(row.id)).toEqual({ imap_password: 'TajneHaslo9' });
    expect(h.integrations.get(row.id)?.name).toBe('Inna nazwa');
    expect(h.mailIn.state(row.id)).toMatchObject({ uidFloor: 5, uidvalidity: 7 });
    expect((await post(`/integracje/${row.id}/edytuj`, formBody({ password: 'NoweHaslo1', folder: 'Alarmy' }))).statusCode).toBe(302);
    expect(h.integrations.secrets(row.id)).toEqual({ imap_password: 'NoweHaslo1' });
    expect(h.mailIn.state(row.id)).toMatchObject({ uidFloor: 0, uidvalidity: 0, nextPollAt: NOW.toISOString() });
    expect((await get(`/integracje/${row.id}`)).statusCode).toBe(200);
  });

  it('Sprawdź połączenie przed zapisem: wynik z liczbą nieprzeczytanych i listą folderów na tej samej stronie', async () => {
    h.mailbox.add({ uid: 1, seen: false, source: 'Subject: a\r\n\r\nx' });
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Połączenie działa');
    expect(res.body).toContain('nieprzeczytanych: 1');
    expect(res.body).toContain('data-fill="#folder"');
    expect(res.body).toContain('INBOX');
    expect(h.integrations.list()).toHaveLength(0);
  });

  it('Sprawdź połączenie przy złym haśle pokazuje błąd logowania bez hasła w treści; dla zapisanej skrzynki używa zapisanego hasła', async () => {
    const bad = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'polaczenie', ...formBody({ password: 'Inne' }) });
    expect(bad.body).toContain('Logowanie odrzucone');
    expect(bad.body).not.toContain('Inne');
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody() });
    const row = h.integrations.list()[0]!;
    const ok = await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', action: 'polaczenie' }));
    expect(ok.body).toContain('Połączenie działa');
    h.mailbox.failConnect = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect((await post(`/integracje/${row.id}/edytuj`, formBody({ password: '', action: 'polaczenie' }))).body).toContain('Serwer nie odpowiada');
  });

  it('Sprawdź szablon z trzech pól pokazuje nadawcę, poziom odbiorców, wycinki, treść i części, nic nie zapisuje', async () => {
    const res = await post('/integracje', {
      kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz',
      ...formBody({ sampleFrom: 'ups@przyklad.test', sampleSubject: 'Alarm', sampleText: 'Error code: E042', 'fields[0][name]': 'kod', 'fields[0][mode]': 'between', 'fields[0][after]': 'Error code:' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Nadawca na liście');
    expect(res.body).toContain('ze stałej listy');
    expect(res.body).toContain('E042');
    expect(res.body).toContain('48601000009');
    expect(h.integrations.list()).toHaveLength(0);
    const obcy = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz', ...formBody({ sampleFrom: 'x@inna.pl', sampleSubject: 'A', sampleText: 'b' }) });
    expect(obcy.body).toContain('Nadawca spoza listy');
    const bez = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz', ...formBody() });
    expect(bez.statusCode).toBe(400);
    expect(bez.body).toContain('Podaj próbkę');
  });

  it('Sprawdź szablon z wklejonym surowym mailem używa parseMail', async () => {
    const raw = readFileSync(new URL('../fixtures/mail/html-tabela-ups.eml', import.meta.url), 'utf8');
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz', ...formBody({ sampleRaw: raw }) });
    expect(res.body).toContain('UPS-01');
    expect(res.body).toContain('Nadawca na liście');
  });

  it('ostrzeżenie o braku szyfrowania pojawia się przy zapisie z security=none i w edycji', async () => {
    const res = await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', action: 'sprawdz', ...formBody({ security: 'none', port: '143', sampleFrom: 'a@przyklad.test', sampleSubject: 'x', sampleText: 'y' }) });
    expect(res.body).toContain('Połączenie bez szyfrowania');
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ security: 'none', port: '143' }) });
    const row = h.integrations.list()[0]!;
    expect((await get(`/integracje/${row.id}/edytuj`)).body).toContain('Połączenie bez szyfrowania');
  });

  it('edycja skrzynki z szablonem Liquid otwiera się w trybie zaawansowanym z wyjaśnieniem', async () => {
    await post('/integracje', { kind: 'mail_in', preset: 'poczta-wlasny', ...formBody({ tryb: 'zaawansowany', textMode: 'liquid', textTemplate: '{{ subject }}' }) });
    const row = h.integrations.list()[0]!;
    expect(row.config).toMatchObject({ text: { mode: 'liquid', template: '{{ subject }}' } });
    const edit = (await get(`/integracje/${row.id}/edytuj`)).body;
    expect(edit).toContain('Szablon Liquid');
    expect(edit).toContain('trybie zaawansowanym');
  });
});
