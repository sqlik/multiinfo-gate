import { describe, expect, it } from 'vitest';
import { handleClick, locationHeader } from '../../src/links/clicks.ts';
import { messageInput } from '../store/helpers.ts';
import { CAMPAIGN, NOW, redirectFixture } from './redirect-fixture.ts';

const UTM = `utm_source=sms&utm_medium=sms&utm_campaign=${CAMPAIGN}`;
const LATER = new Date(NOW.getTime() + 3_600_000);

const human = (f: ReturnType<typeof redirectFixture>, code: string | null, host: string | null = 'l.firma.pl', now = LATER) =>
  handleClick(f.deps, host, code, false, now);

describe('handleClick - przekierowanie', () => {
  it('ważny kod przekierowuje na adres docelowy z UTM', () => {
    const f = redirectFixture();
    const code = f.addLink();
    expect(human(f, code)).toEqual({ kind: 'redirect', location: `https://firma.pl/przeglad?${UTM}` });
  });

  it('kod z utm = 0 przekierowuje na adres docelowy bez zmian', () => {
    const f = redirectFixture();
    const code = f.addLink({ utm: 0, target: 'https://firma.pl/oferta?sig=a%2Fb' });
    expect(human(f, code)).toEqual({ kind: 'redirect', location: 'https://firma.pl/oferta?sig=a%2Fb' });
  });

  it('adres z polskimi znakami trafia do nagłówka Location w postaci ASCII', () => {
    const f = redirectFixture();
    const code = f.addLink({ target: 'https://firma.pl/przegląd' });
    expect(human(f, code)).toEqual({ kind: 'redirect', location: `https://firma.pl/przegl%C4%85d?${UTM}` });
  });

  it.each(['L.FIRMA.PL', 'l.firma.pl:443', 'l.firma.pl.', 'L.Firma.Pl.:8082'])('nagłówek Host %s działa jak l.firma.pl', (host) => {
    const f = redirectFixture();
    const code = f.addLink();
    expect(human(f, code, host).kind).toBe('redirect');
  });

  it('przypadek 5 przeglądu: odwołanie klucza, tryb off i odpięcie domeny nie zatrzymują wysłanych linków', () => {
    const f = redirectFixture();
    const code = f.addLink();
    f.apiKeys.setLinkSettings(f.apiKeyId, {
      mode: 'off', domainIds: [f.otherId], defaultDomainId: f.otherId, targets: ['firma.pl'], validityDays: 90, utm: true,
    });
    f.apiKeys.revoke(f.apiKeyId);
    expect(human(f, code).kind).toBe('redirect');
  });
});

describe('handleClick - link wygasł', () => {
  it('nieznana domena daje stronę bez nazwy wyświetlanej i status 404', () => {
    const f = redirectFixture();
    const code = f.addLink();
    expect(human(f, code, 'obca-domena.pl')).toEqual({ kind: 'expired', domain: null, status: 404 });
    expect(human(f, code, null)).toEqual({ kind: 'expired', domain: null, status: 404 });
    expect(human(f, code, '[::1]:8082')).toEqual({ kind: 'expired', domain: null, status: 404 });
  });

  it('kod innej domeny tej samej bramki daje 404 z nazwą domeny z nagłówka Host', () => {
    const f = redirectFixture();
    const code = f.addLink();
    const r = human(f, code, 'firma-link.pl');
    expect(r).toMatchObject({ kind: 'expired', status: 404, domain: { domain: 'firma-link.pl' } });
    expect(f.campaign().clicks + f.campaign().bots).toBe(0);
  });

  it('nieznany kod i ścieżka, która nie jest kodem, dają 404', () => {
    const f = redirectFixture();
    expect(human(f, 'aB3xK9q')).toMatchObject({ kind: 'expired', status: 404, domain: { domain: 'l.firma.pl' } });
    expect(human(f, 'favicon.ico')).toMatchObject({ kind: 'expired', status: 404 });
  });

  it('kod po terminie ważności daje 410', () => {
    const f = redirectFixture();
    const code = f.addLink({ expiresAt: '2026-11-05T10:30:00.000Z' });
    expect(human(f, code, 'l.firma.pl', new Date('2026-11-05T10:29:59Z')).kind).toBe('redirect');
    expect(human(f, code, 'l.firma.pl', new Date('2026-11-05T10:30:00Z'))).toMatchObject({ kind: 'expired', status: 410 });
  });

  it('„Wyłącz linki” daje 410, „Włącz linki” przywraca przekierowanie', () => {
    const f = redirectFixture();
    const code = f.addLink();
    f.shortLinks.disableCampaign(f.campaignId, NOW);
    expect(human(f, code)).toMatchObject({ kind: 'expired', status: 410, domain: { displayName: 'Firma Serwis' } });
    f.shortLinks.enableCampaign(f.campaignId);
    expect(human(f, code).kind).toBe('redirect');
  });

  it('wyłączona domena zatrzymuje swoje linki (410) i stronę główną (404)', () => {
    const f = redirectFixture();
    const code = f.addLink();
    f.linkDomains.setEnabled(f.domainId, false, NOW);
    expect(human(f, code)).toMatchObject({ kind: 'expired', status: 410, domain: { displayName: 'Firma Serwis' } });
    expect(human(f, null)).toMatchObject({ kind: 'expired', status: 404 });
  });

  it('anulowana wiadomość daje 410 także bez wyłączenia kodów', () => {
    const f = redirectFixture();
    f.messages.insert(messageInput({ id: 'msg_1', apiKeyId: f.apiKeyId }));
    const code = f.addLink({ messageId: 'msg_1' });
    expect(human(f, code).kind).toBe('redirect');
    f.messages.setStatus('msg_1', { status: 'cancelled', finalAt: NOW, error: null });
    expect(human(f, code)).toMatchObject({ kind: 'expired', status: 410 });
  });

  it('wejście w kod wygasły niczego nie liczy', () => {
    const f = redirectFixture();
    const code = f.addLink({ expiresAt: NOW.toISOString() });
    human(f, code);
    expect(f.shortLinks.get(code)).toMatchObject({ clicks: 0, botClicks: 0 });
    expect(f.campaign()).toMatchObject({ clicks: 0, opens: 0, bots: 0 });
  });
});

describe('handleClick - strona główna domeny', () => {
  it('sam adres domeny daje stronę główną tej domeny', () => {
    const f = redirectFixture();
    expect(human(f, null)).toMatchObject({ kind: 'home', domain: { domain: 'l.firma.pl', homeUrl: null } });
    expect(human(f, null, 'firma-link.pl')).toMatchObject({ kind: 'home', domain: { homeUrl: 'https://firma.pl/' } });
  });
});

describe('handleClick - liczenie wejść', () => {
  it('pierwszy klik liczy kliknięcie, otwarcie i wywołuje zdarzenie otwarcia', () => {
    const f = redirectFixture();
    const code = f.addLink();
    human(f, code);
    expect(f.shortLinks.get(code)).toMatchObject({ clicks: 1, botClicks: 0, firstOpenedAt: LATER.toISOString() });
    expect(f.campaign()).toMatchObject({ clicks: 1, opens: 1, bots: 0 });
    expect(f.target('https://firma.pl/przeglad')).toMatchObject({ recipients: 1, opens: 1, clicks: 1 });
    expect(f.campaigns.hours(f.campaignId)).toEqual([{ hour: '2026-11-05T11', clicks: 1, bots: 0 }]);
    expect(f.opened).toEqual([{ code, campaign: CAMPAIGN, domain: 'l.firma.pl', at: LATER.toISOString() }]);
  });

  it('drugi klik tego samego odbiorcy zwiększa kliknięcia, nie otwarcia, i nie wywołuje zdarzenia', () => {
    const f = redirectFixture();
    const code = f.addLink();
    human(f, code);
    human(f, code);
    expect(f.campaign()).toMatchObject({ clicks: 2, opens: 1 });
    expect(f.target('https://firma.pl/przeglad')).toMatchObject({ opens: 1, clicks: 2 });
    expect(f.opened).toHaveLength(1);
  });

  it('klik odbiorcy w drugi kod tej samej kampanii nie zwiększa otwarć kampanii', () => {
    const f = redirectFixture();
    const first = f.addLink();
    const second = f.addLink({ target: 'https://firma.pl/cennik' });
    human(f, first);
    human(f, second);
    expect(f.campaign()).toMatchObject({ clicks: 2, opens: 1 });
    expect(f.target('https://firma.pl/cennik')).toMatchObject({ opens: 1, clicks: 1 });
    expect(f.opened.map((o) => o.code)).toEqual([first, second]);
  });

  it('ten sam link dwa razy w jednym SMS-ie liczy jedno otwarcie adresu docelowego', () => {
    const f = redirectFixture();
    const first = f.addLink();
    const second = f.addLink();
    human(f, first);
    human(f, second);
    expect(f.target('https://firma.pl/przeglad')).toMatchObject({ recipients: 1, opens: 1, clicks: 2 });
    expect(f.campaign()).toMatchObject({ opens: 1, clicks: 2 });
    // Zdarzenie „link otwarty” dotyczy odbiorcy i adresu docelowego, dlatego drugie wystąpienie go nie wywołuje.
    expect(f.opened.map((o) => o.code)).toEqual([first]);
  });

  it('otwarcia różnych odbiorców liczą się osobno', () => {
    const f = redirectFixture();
    const a = f.addLink();
    const b = f.addLink({ recipientKey: 'msg_2', messageId: 'msg_2', dest: '48601000002' });
    human(f, a);
    human(f, b);
    expect(f.campaign()).toMatchObject({ opens: 2, clicks: 2 });
    expect(f.target('https://firma.pl/przeglad')).toMatchObject({ recipients: 2, opens: 2 });
  });

  it('automat otrzymuje przekierowanie, zwiększa wyłącznie automaty i nie wywołuje zdarzenia', () => {
    const f = redirectFixture();
    const code = f.addLink();
    expect(handleClick(f.deps, 'l.firma.pl', code, true, LATER).kind).toBe('redirect');
    expect(f.shortLinks.get(code)).toMatchObject({ clicks: 0, botClicks: 1, firstOpenedAt: null });
    expect(f.campaign()).toMatchObject({ clicks: 0, opens: 0, bots: 1 });
    expect(f.target('https://firma.pl/przeglad')).toMatchObject({ opens: 0, clicks: 0 });
    expect(f.campaigns.hours(f.campaignId)).toEqual([{ hour: '2026-11-05T11', clicks: 0, bots: 1 }]);
    expect(f.opened).toEqual([]);
  });

  it('błąd zdarzenia otwarcia nie zatrzymuje przekierowania i trafia do dziennika', () => {
    const f = redirectFixture();
    const code = f.addLink();
    const errors: string[] = [];
    const log = { info() {}, warn() {}, debug() {}, error: (msg: string) => { errors.push(msg); } };
    const deps = { ...f.deps, log, opened: () => { throw new Error('kolejka niedostępna'); } };
    expect(handleClick(deps, 'l.firma.pl', code, false, LATER).kind).toBe('redirect');
    expect(f.campaign()).toMatchObject({ clicks: 1, opens: 1 });
    expect(errors).toEqual(['przekierowania.blad_zdarzenia']);
  });
});

describe('locationHeader', () => {
  it('adres ASCII zostawia bez zmian, także zakodowane parametry podpisu', () => {
    expect(locationHeader("https://firma.pl/a?sig=x%2Fy&n='1'")).toBe("https://firma.pl/a?sig=x%2Fy&n='1'");
  });

  it('polskie znaki w ścieżce, zapytaniu i nazwie domeny zamienia na postać ASCII', () => {
    expect(locationHeader('https://firma.pl/przegląd?miasto=Łódź')).toBe('https://firma.pl/przegl%C4%85d?miasto=%C5%81%C3%B3d%C5%BA');
    expect(locationHeader('https://łódź.pl/x')).toBe('https://xn--d-uga0v4h.pl/x');
  });

  it('adres, którego parser nie przyjmuje, koduje znak po znaku', () => {
    expect(locationHeader('https://firma.pl:99999/ą')).toBe('https://firma.pl:99999/%C4%85');
  });
});
