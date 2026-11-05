import { describe, expect, it } from 'vitest';
import { CampaignService, groupTargets, messageLinks, packageLinks } from '../../src/links/campaigns.ts';
import { AuditRepo } from '../../src/store/audit.ts';
import { messageInput } from '../store/helpers.ts';
import { DELIVERED, FOLDER, SENT, SPRING, SPRING_PACKAGE, clickAt, dest, folderCode, offerCode, seedSpringCampaign } from './campaign-fixture.ts';
import { NOW, redirectFixture } from './redirect-fixture.ts';

const ADMIN = { id: 1, login: 'janek' };

function setup() {
  const f = redirectFixture();
  const audit = new AuditRepo(f.db);
  const service = new CampaignService({ campaigns: f.campaigns, shortLinks: f.shortLinks, apiKeys: f.apiKeys, audit });
  const entries = () => f.db.prepare("SELECT actor, action, target, meta FROM audit_log WHERE action LIKE 'kampania.%' ORDER BY id").all() as
    Array<{ actor: string; action: string; target: string; meta: string }>;
  return { ...f, audit, service, entries };
}

function spring() {
  const s = setup();
  const seeded = seedSpringCampaign(s.db, { apiKeyId: s.apiKeyId, accountId: s.accountId, domain: 'l.firma.pl', start: NOW });
  return { ...s, ...seeded };
}

describe('CampaignService: szczegóły kampanii', () => {
  it('liczby kafelków: wysłane, doręczone z raportu, otwarcia, kliknięcia i automaty', () => {
    const s = spring();
    const d = s.service.detail(s.campaignId, 50)!;
    expect(d.row).toMatchObject({ name: SPRING, sent: SENT, opens: 312, clicks: 455, bots: 41 });
    expect(d).toMatchObject({ keyName: 'Serwis klimatyzacji', packages: 1, messages: 0, delivered: DELIVERED, reported: true });
  });

  it('dwa wiersze linków: wspólny folder i oferty indywidualne zgrupowane w jeden wiersz', () => {
    const s = spring();
    const d = s.service.detail(s.campaignId, 50)!;
    expect(d.targets).toEqual([
      { target: FOLDER, kind: 'shared', opens: 251, clicks: 300 },
      { target: 'https://firma.pl/oferta/{…}', kind: 'individual', opens: 129, clicks: 155 },
    ]);
  });

  it('wykres godzinowy sumuje kliknięcia i wejścia automatów', () => {
    const s = spring();
    const d = s.service.detail(s.campaignId, 50)!;
    expect(d.hours.reduce((n, h) => n + h.clicks, 0)).toBe(455);
    expect(d.hours.reduce((n, h) => n + h.bots, 0)).toBe(41);
    expect(d.hours[0]!.hour).toBe('2026-11-05T10');
  });

  it('analityka: domena, ważność linków i dopisywanie UTM z kodów kampanii', () => {
    const s = spring();
    const d = s.service.detail(s.campaignId, 50)!;
    expect(d).toMatchObject({ domain: 'l.firma.pl', expiresAt: s.expiresAt, utm: true });
  });

  it('odbiorcy z otwarciem: pierwsza strona od najnowszego kliknięcia, kolejna przez przesunięcie', () => {
    const s = spring();
    const first = s.service.detail(s.campaignId, 50)!.openers;
    expect(first).toHaveLength(50);
    const next = s.service.detail(s.campaignId, 50, 300)!.openers;
    expect(next).toHaveLength(12);
    expect(first[0]!.lastClickedAt >= first[49]!.lastClickedAt).toBe(true);
    expect(s.service.detail(s.campaignId, 400)!.openers.find((o) => o.dest === dest(200))).toMatchObject({
      clientId: 'KL-10200', clicks: 3, targets: ['https://firma.pl/oferta/KL-10200', FOLDER],
    });
  });

  it('nieznana kampania daje undefined', () => {
    const s = setup();
    expect(s.service.detail(999, 50)).toBeUndefined();
  });

  it('kampania bez raportu doręczenia: reported false', () => {
    const s = setup();
    s.db.prepare('UPDATE campaigns SET sent = 1 WHERE id = ?').run(s.campaignId);
    expect(s.service.detail(s.campaignId, 50)).toMatchObject({ delivered: 0, reported: false, packages: 0, messages: 0 });
  });

  it('po retencji: liczby i linki zostają, odbiorców, domeny i ważności już nie ma', () => {
    const s = spring();
    s.shortLinks.purge(new Date(NOW.getTime() + 200 * 86_400_000));
    s.campaigns.setDetailsPurged(s.campaignId, NOW);
    const d = s.service.detail(s.campaignId, 50)!;
    expect(d.row).toMatchObject({ sent: SENT, opens: 312, clicks: 455, detailsPurgedAt: NOW.toISOString() });
    expect(d.openers).toEqual([]);
    expect(d).toMatchObject({ domain: null, expiresAt: null, utm: null });
    expect(d.targets).toHaveLength(2);
  });
});

describe('groupTargets', () => {
  const row = (target: string, recipients: number, opens = 0, clicks = 0, collapsed: 0 | 1 = 0) =>
    ({ target, collapsed, recipients, opens, clicks });

  it('adres wielu odbiorców jest wspólny, adresy jednego odbiorcy grupuje wzorzec', () => {
    expect(groupTargets([
      row(FOLDER, 3, 2, 3),
      row('https://firma.pl/o/1', 1, 1, 2),
      row('https://firma.pl/o/2', 1, 1, 1),
    ])).toEqual([
      { target: FOLDER, kind: 'shared', opens: 2, clicks: 3 },
      { target: 'https://firma.pl/o/{…}', kind: 'individual', opens: 2, clicks: 3 },
    ]);
  });

  it('jedyny adres indywidualny swojego wzorca pozostaje pełnym adresem', () => {
    expect(groupTargets([row('https://firma.pl/o/1', 1, 1, 1)])).toEqual([
      { target: 'https://firma.pl/o/1', kind: 'individual', opens: 1, clicks: 1 },
    ]);
  });

  it('wiersz scalony po retencji łączy się z adresami tego samego wzorca', () => {
    expect(groupTargets([
      row('https://firma.pl/o/{…}', 40, 10, 12, 1),
      row('https://firma.pl/o/77', 1, 1, 1),
    ])).toEqual([{ target: 'https://firma.pl/o/{…}', kind: 'individual', opens: 11, clicks: 13 }]);
  });

  it('kolejność od największej liczby odbiorców', () => {
    const out = groupTargets([
      row('https://firma.pl/regulamin', 2),
      row('https://firma.pl/o/1', 1), row('https://firma.pl/o/2', 1), row('https://firma.pl/o/3', 1),
    ]);
    expect(out.map((t) => t.target)).toEqual(['https://firma.pl/o/{…}', 'https://firma.pl/regulamin']);
  });
});

describe('CampaignService: CSV odbiorców', () => {
  it('nagłówek i wiersz na odbiorcę z otwarciem, z polami jak w tabeli', () => {
    const s = spring();
    const lines = s.service.openersCsv(s.campaignId).trimEnd().split('\r\n');
    expect(lines[0]).toBe('numer;identyfikator_klienta;pierwsze_otwarcie;ostatnie_klikniecie;klikniecia;linki');
    expect(lines).toHaveLength(313);
    const line = lines.find((l) => l.startsWith(`${dest(200)};`))!;
    expect(line).toMatch(new RegExp(`^${dest(200)};KL-10200;2026-11-\\d\\d \\d\\d:\\d\\d:\\d\\d;2026-11-\\d\\d \\d\\d:\\d\\d:\\d\\d;3;`));
    expect(line.endsWith(`;https://firma.pl/oferta/KL-10200 ${FOLDER}`)).toBe(true);
  });

  it('kampania po retencji daje sam nagłówek', () => {
    const s = setup();
    expect(s.service.openersCsv(s.campaignId)).toBe('numer;identyfikator_klienta;pierwsze_otwarcie;ostatnie_klikniecie;klikniecia;linki\r\n');
  });
});

describe('CampaignService: wyłączenie i włączenie linków', () => {
  it('„Wyłącz linki” wyłącza wszystkie kody kampanii i zapisuje wpis w dzienniku', () => {
    const s = spring();
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    expect(s.service.disableLinks(s.campaignId, ADMIN, later)).toBe(SENT * 2);
    expect(s.campaign().linksDisabledAt).toBe(later.toISOString());
    expect(s.click(folderCode(5), later)).toMatchObject({ kind: 'expired', status: 410 });
    expect(s.entries()).toEqual([{
      actor: 'janek', action: 'kampania.linki_wylaczone', target: `kampania:${s.campaignId}`,
      meta: JSON.stringify({ name: SPRING, codes: SENT * 2 }),
    }]);
  });

  it('„Włącz linki” przywraca przekierowania i zapisuje wpis w dzienniku', () => {
    const s = spring();
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    s.service.disableLinks(s.campaignId, ADMIN, later);
    expect(s.service.enableLinks(s.campaignId, ADMIN, later)).toBe(SENT * 2);
    expect(s.campaign().linksDisabledAt).toBeNull();
    expect(s.click(offerCode(7), clickAt(later, 1))).toMatchObject({ kind: 'redirect' });
    expect(s.entries().map((e) => e.action)).toEqual(['kampania.linki_wylaczone', 'kampania.linki_wlaczone']);
  });

  it('„Włącz linki” nie przywraca kodów anulowanej wiadomości', () => {
    const s = setup();
    s.messages.insert(messageInput({ id: 'msg_1', apiKeyId: s.apiKeyId, accountId: s.accountId, campaignId: s.campaignId }));
    s.messages.insert(messageInput({ id: 'msg_2', apiKeyId: s.apiKeyId, accountId: s.accountId, campaignId: s.campaignId }));
    s.addLink({ code: 'aaaaaa1', messageId: 'msg_1', recipientKey: 'msg_1' });
    s.addLink({ code: 'aaaaaa2', messageId: 'msg_2', recipientKey: 'msg_2' });
    s.db.prepare("UPDATE messages SET status = 'cancelled' WHERE id = 'msg_1'").run();
    s.shortLinks.disableMessage('msg_1', NOW);
    s.service.disableLinks(s.campaignId, ADMIN, NOW);
    expect(s.service.enableLinks(s.campaignId, ADMIN, NOW)).toBe(1);
    expect(s.shortLinks.get('aaaaaa1')!.disabledAt).not.toBeNull();
    expect(s.shortLinks.get('aaaaaa2')!.disabledAt).toBeNull();
  });
});

describe('blok links w odczycie wiadomości i rozsyłki', () => {
  it('wiadomość z krótkim linkiem: kampania, krótkie linki, kliknięcia i pierwsze otwarcie', () => {
    const s = setup();
    s.messages.insert(messageInput({ id: 'msg_1', apiKeyId: s.apiKeyId, accountId: s.accountId, campaignId: s.campaignId }));
    s.addLink({ code: 'aB3xK9q', messageId: 'msg_1', recipientKey: 'msg_1' });
    const at = new Date(NOW.getTime() + 3_600_000);
    s.shortLinks.click('aB3xK9q', at, false);
    s.shortLinks.click('aB3xK9q', new Date(at.getTime() + 60_000), false);
    expect(messageLinks(s, s.messages.get('msg_1')!)).toEqual({
      campaign: SPRING, domain: 'l.firma.pl', expiresAt: '2027-02-03T10:00:00.000Z', shortened: 1, opens: 1, clicks: 2,
      firstOpenedAt: at.toISOString(), detailsPurged: false,
      shortLinks: [{ url: 'https://l.firma.pl/aB3xK9q', target: 'https://firma.pl/przeglad', clicks: 2, firstOpenedAt: at.toISOString() }],
    });
  });

  it('wiadomość bez kampanii nie ma bloku', () => {
    const s = setup();
    s.messages.insert(messageInput({ id: 'msg_1', apiKeyId: s.apiKeyId, accountId: s.accountId }));
    expect(messageLinks(s, s.messages.get('msg_1')!)).toBeUndefined();
  });

  it('wiadomość po retencji: kampania i informacja o usunięciu szczegółów', () => {
    const s = setup();
    s.messages.insert(messageInput({ id: 'msg_1', apiKeyId: s.apiKeyId, accountId: s.accountId, campaignId: s.campaignId }));
    expect(messageLinks(s, s.messages.get('msg_1')!)).toEqual({
      campaign: SPRING, domain: null, expiresAt: null, shortened: null, opens: null, clicks: null, firstOpenedAt: null,
      detailsPurged: true, shortLinks: [],
    });
  });

  it('rozsyłka: liczby wszystkich odbiorców bez listy krótkich linków', () => {
    const s = spring();
    const block = packageLinks(s, { id: SPRING_PACKAGE, campaignId: s.campaignId })!;
    expect(block).toMatchObject({
      campaign: SPRING, domain: 'l.firma.pl', expiresAt: s.expiresAt, shortened: SENT * 2, opens: 312, clicks: 455, detailsPurged: false,
    });
    // Odbiorca 48 kliknął folder w pierwszej minucie od wysyłki.
    expect(block.firstOpenedAt).toBe(clickAt(NOW, 48).toISOString());
    expect('shortLinks' in block).toBe(false);
  });
});
