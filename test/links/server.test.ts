import { describe, expect, it } from 'vitest';
import { DomainChecks } from '../../src/links/domain-checks.ts';
import { buildLinksServer, clientKey, limitKey, type LinksServerDeps } from '../../src/links/server.ts';
import { CAMPAIGN, NOW, redirectFixture } from './redirect-fixture.ts';

const LATER = new Date(NOW.getTime() + 3_600_000);

const setup = (extra: Partial<LinksServerDeps> = {}) => {
  const f = redirectFixture();
  const clock = { now: LATER };
  const checks = new DomainChecks();
  const app = buildLinksServer({ ...f.deps, checks, now: () => clock.now, ...extra });
  // Stuknięcie odbiorcy: przeglądarka zawsze wysyła Accept-Language, bez niego wejście liczy się jako automat.
  const get = (url: string, host = 'l.firma.pl', headers: Record<string, string> = {}, remoteAddress = '203.0.113.5') =>
    app.inject({ method: 'GET', url, headers: { host, 'accept-language': 'pl-PL,pl;q=0.9', ...headers }, remoteAddress });
  return { ...f, app, clock, checks, get };
};

describe('serwer przekierowań - krótki link', () => {
  it('ważny kod daje 302 z UTM, Cache-Control: no-store i pustym body', async () => {
    const s = setup();
    const code = s.addLink();
    const res = await s.get(`/${code}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://firma.pl/przeglad?utm_source=sms&utm_medium=sms&utm_campaign=${CAMPAIGN}`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.body).toBe('');
    expect(s.campaign()).toMatchObject({ clicks: 1, opens: 1, bots: 0 });
  });

  it('kod z interpunkcją doklejoną przez telefon na końcu zdania przekierowuje tak jak sam kod', async () => {
    const s = setup();
    const code = s.addLink();
    for (const tail of ['.', '...', '%E2%80%A6', ',', '!', ')', '%22', '%C2%BB', '%E2%80%9D']) {
      const res = await s.get(`/${code}${tail}`);
      expect(res.statusCode, `/${code}${tail}`).toBe(302);
    }
    // Kod dłuższy o znak spoza interpunkcji nie jest kodem: bramka nie zgaduje.
    expect((await s.get(`/${code}x`)).statusCode).toBe(404);
    expect((await s.get('/!.')).statusCode).toBe(404);
  });

  it('adres z polskimi znakami trafia do nagłówka Location w postaci ASCII', async () => {
    const s = setup();
    const code = s.addLink({ target: 'https://firma.pl/przegląd' });
    const res = await s.get(`/${code}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://firma.pl/przegl%C4%85d?utm_source=sms&utm_medium=sms&utm_campaign=${CAMPAIGN}`);
  });

  it.each(['L.FIRMA.PL', 'l.firma.pl:443', 'l.firma.pl.'])('nagłówek Host %s działa jak l.firma.pl', async (host) => {
    const s = setup();
    const code = s.addLink();
    expect((await s.get(`/${code}`, host)).statusCode).toBe(302);
  });

  it('HEAD przekierowuje i liczy się jako automat', async () => {
    const s = setup();
    const code = s.addLink();
    const res = await s.app.inject({ method: 'HEAD', url: `/${code}`, headers: { host: 'l.firma.pl' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('https://firma.pl/przeglad?');
    expect(s.campaign()).toMatchObject({ clicks: 0, opens: 0, bots: 1 });
    expect(s.opened).toEqual([]);
  });

  it('pobieracz podglądu komunikatora otrzymuje przekierowanie i liczy się jako automat', async () => {
    const s = setup();
    const code = s.addLink();
    const res = await s.get(`/${code}`, 'l.firma.pl', { 'user-agent': 'WhatsApp/2.24.1 A' });
    expect(res.statusCode).toBe(302);
    expect(s.campaign()).toMatchObject({ clicks: 0, bots: 1 });
  });

  it('przypadek 5 przeglądu: po odwołaniu klucza link działa, po wyłączeniu domeny daje 410', async () => {
    const s = setup();
    const code = s.addLink();
    s.apiKeys.revoke(s.apiKeyId);
    expect((await s.get(`/${code}`)).statusCode).toBe(302);
    s.linkDomains.setEnabled(s.domainId, false, NOW);
    expect((await s.get(`/${code}`)).statusCode).toBe(410);
  });
});

describe('serwer przekierowań - link wygasł', () => {
  it('wygasły kod daje 410 i stronę z nazwą wyświetlaną, bez danych kampanii', async () => {
    const s = setup();
    const code = s.addLink({ expiresAt: NOW.toISOString(), target: 'https://firma.pl/oferta-wiosna' });
    const res = await s.get(`/${code}`);
    expect(res.statusCode).toBe(410);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('Link wygasł');
    expect(res.body).toContain('Firma Serwis');
    expect(res.body).toContain('<meta name="robots" content="noindex">');
    expect(res.body).not.toContain(CAMPAIGN);
    expect(res.body).not.toContain('oferta-wiosna');
    expect(res.body).not.toMatch(/<link|<script|src=/);
  });

  it('kod po „Wyłącz linki” daje 410, po „Włącz linki” znów 302', async () => {
    const s = setup();
    const code = s.addLink();
    s.shortLinks.disableCampaign(s.campaignId, NOW);
    expect((await s.get(`/${code}`)).statusCode).toBe(410);
    s.shortLinks.enableCampaign(s.campaignId);
    expect((await s.get(`/${code}`)).statusCode).toBe(302);
  });

  it('nieznany kod daje 404, nieznana domena 404 bez nazwy wyświetlanej', async () => {
    const s = setup();
    const code = s.addLink();
    const unknown = await s.get('/aB3xK9q');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).toContain('Firma Serwis');
    const foreign = await s.get(`/${code}`, 'obca-domena.pl');
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toContain('Link wygasł');
    expect(foreign.body).not.toContain('Firma Serwis');
  });

  it('kod z innej domeny tej samej bramki daje 404', async () => {
    const s = setup();
    const code = s.addLink();
    expect((await s.get(`/${code}`, 'firma-link.pl')).statusCode).toBe(404);
  });

  it('każda inna ścieżka i metoda daje stronę „Link wygasł” ze statusem 404', async () => {
    const s = setup();
    const code = s.addLink();
    for (const res of [
      await s.get(`/${code}/dalej`),
      await s.get('/%E0%A4%A'),
      await s.app.inject({ method: 'POST', url: `/${code}`, headers: { host: 'l.firma.pl' }, payload: {} }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('Link wygasł');
    }
    expect(s.campaign()).toMatchObject({ clicks: 0, bots: 0 });
  });

  it('błąd bazy daje 500 ze stroną bez szczegółów i wpis w dzienniku', async () => {
    const errors: string[] = [];
    const log = { info() {}, warn() {}, debug() {}, error: (msg: string) => { errors.push(msg); } };
    const s = setup({ log });
    s.db.close();
    const res = await s.get('/aB3xK9q');
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('Link chwilowo niedostępny');
    expect(res.body).not.toMatch(/database|sqlite/i);
    expect(errors).toEqual(['przekierowania.wyjatek']);
  });
});

describe('serwer przekierowań - strona główna domeny', () => {
  it('domena z adresem strony głównej przekierowuje na ten adres', async () => {
    const s = setup();
    const res = await s.get('/', 'firma-link.pl');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://firma.pl/');
  });

  it('domena bez adresu strony głównej pokazuje stronę z nazwą wyświetlaną', async () => {
    const s = setup();
    const res = await s.get('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Firma Serwis');
    expect(res.body).toContain('<meta name="robots" content="noindex">');
  });

  it('nieznana domena daje 404', async () => {
    const s = setup();
    expect((await s.get('/', 'obca-domena.pl')).statusCode).toBe(404);
  });
});

describe('serwer przekierowań - sprawdzenie domeny', () => {
  it('token przez serwer pośredniczący bez zaufania: zapamiętuje adres tego serwera', async () => {
    const s = setup();
    const token = s.checks.issue(s.domainId, LATER);
    const res = await s.get(`/.well-known/multiinfo-gate/${token}`, 'l.firma.pl', { 'x-forwarded-for': '198.51.100.7' }, '172.18.0.3');
    expect(res.statusCode).toBe(200);
    expect(s.checks.take(token).untrustedProxy).toBe('172.18.0.3');
  });

  it('token przez zaufany serwer pośredniczący albo bez nagłówka X-Forwarded-For: bez ostrzeżenia', async () => {
    const trusted = setup({ trustedProxies: ['172.16.0.0/12'] });
    const t1 = trusted.checks.issue(trusted.domainId, LATER);
    await trusted.get(`/.well-known/multiinfo-gate/${t1}`, 'l.firma.pl', { 'x-forwarded-for': '198.51.100.7' }, '172.18.0.3');
    expect(trusted.checks.take(t1)).toEqual({ answered: true, untrustedProxy: null });
    const direct = setup();
    const t2 = direct.checks.issue(direct.domainId, LATER);
    await direct.get(`/.well-known/multiinfo-gate/${t2}`);
    expect(direct.checks.take(t2)).toEqual({ answered: true, untrustedProxy: null });
  });

  it('adres IPv4 w zapisie IPv6 podaje w zwykłej postaci', async () => {
    const s = setup();
    const token = s.checks.issue(s.domainId, LATER);
    await s.get(`/.well-known/multiinfo-gate/${token}`, 'l.firma.pl', { 'x-forwarded-for': '198.51.100.7' }, '::ffff:172.18.0.3');
    expect(s.checks.take(token).untrustedProxy).toBe('172.18.0.3');
  });

  it('token odpowiada w ciągu 120 s wyłącznie pod domeną, dla której powstał', async () => {
    const s = setup();
    const token = s.checks.issue(s.domainId, LATER);
    const ok = await s.get(`/.well-known/multiinfo-gate/${token}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(ok.body).toBe(token);
    expect((await s.get(`/.well-known/multiinfo-gate/${token}`)).statusCode, 'drugie pobranie').toBe(404);
    const other = s.checks.issue(s.domainId, LATER);
    expect((await s.get(`/.well-known/multiinfo-gate/${other}`, 'firma-link.pl')).statusCode).toBe(404);
    expect((await s.get('/.well-known/multiinfo-gate/nieznany-token')).statusCode).toBe(404);
    s.clock.now = new Date(LATER.getTime() + 119_000);
    expect((await s.get(`/.well-known/multiinfo-gate/${other}`)).statusCode).toBe(200);
    const late = s.checks.issue(s.domainId, LATER);
    s.clock.now = new Date(LATER.getTime() + 121_000);
    expect((await s.get(`/.well-known/multiinfo-gate/${late}`)).statusCode).toBe(404);
  });

  it('endpoint dla Caddy odpowiada 200 wyłącznie dla aktywnej domeny skracacza', async () => {
    const s = setup();
    const tls = (domain: string) => s.get(`/.well-known/multiinfo-gate/tls?domain=${encodeURIComponent(domain)}`, 'bramka:8082');
    expect((await tls('l.firma.pl')).statusCode).toBe(200);
    expect((await tls('L.FIRMA.PL.')).statusCode).toBe(200);
    expect((await tls('obca.pl')).statusCode).toBe(404);
    expect((await s.get('/.well-known/multiinfo-gate/tls', 'bramka:8082')).statusCode).toBe(404);
    s.linkDomains.setEnabled(s.domainId, false, NOW);
    expect((await tls('l.firma.pl')).statusCode).toBe(404);
  });
});

describe('DomainChecks', () => {
  it('token jest ważny 120 s i wyłącznie dla swojej domeny', () => {
    const checks = new DomainChecks();
    const token = checks.issue(1, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(checks.answer(token, new Date(NOW.getTime() + 119_999), 1)).toBe(true);
    expect(checks.answer(token, NOW, 2)).toBe(false);
    expect(checks.answer(token, new Date(NOW.getTime() + 120_000), 1)).toBe(false);
    expect(checks.answer('inny', NOW, 1)).toBe(false);
  });

  it('token odpowiada tylko raz, a wynik odczytany przez panel usuwa token', () => {
    const checks = new DomainChecks();
    const token = checks.issue(1, NOW);
    expect(checks.answer(token, NOW, 1, '172.18.0.3')).toBe(true);
    expect(checks.answer(token, NOW, 1)).toBe(false);
    expect(checks.take(token)).toEqual({ answered: true, untrustedProxy: '172.18.0.3' });
    expect(checks.size).toBe(0);
    expect(checks.take(token)).toEqual({ answered: false, untrustedProxy: null });
  });

  it('nowy token usuwa tokeny po terminie', () => {
    const checks = new DomainChecks();
    const old = checks.issue(1, NOW);
    checks.issue(1, new Date(NOW.getTime() + 121_000));
    expect(checks.size).toBe(1);
    expect(checks.answer(old, NOW, 1)).toBe(false);
  });
});

describe('serwer przekierowań - limit żądań', () => {
  it('61. żądanie z jednego adresu w ciągu minuty daje 429, inny adres działa', async () => {
    const s = setup();
    const code = s.addLink();
    for (let i = 0; i < 60; i += 1) expect((await s.get(`/${code}`)).statusCode, `żądanie ${i + 1}`).toBe(302);
    const limited = await s.get(`/${code}`);
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toContain('Zbyt wiele żądań');
    expect((await s.get(`/${code}`, 'l.firma.pl', {}, '203.0.113.6')).statusCode).toBe(302);
    expect(s.campaign().clicks).toBe(61);
  });

  it('za zaufanym serwerem pośredniczącym limit dotyczy adresu klienta', async () => {
    const s = setup({ trustedProxies: ['10.0.0.1'] });
    const code = s.addLink();
    const via = (client: string) => s.get(`/${code}`, 'l.firma.pl', { 'x-forwarded-for': client }, '10.0.0.1');
    for (let i = 0; i < 60; i += 1) await via('203.0.113.5');
    expect((await via('203.0.113.5')).statusCode).toBe(429);
    expect((await via('198.51.100.7')).statusCode).toBe(302);
  });

  it('adresy IPv6 z jednej sieci /64 mają wspólny limit', async () => {
    const s = setup();
    const code = s.addLink();
    for (let i = 0; i < 60; i += 1) await s.get(`/${code}`, 'l.firma.pl', {}, `2001:db8:1:2::${(i + 1).toString(16)}`);
    expect((await s.get(`/${code}`, 'l.firma.pl', {}, '2001:db8:1:2:ffff::1')).statusCode).toBe(429);
    expect((await s.get(`/${code}`, 'l.firma.pl', {}, '2001:db8:1:3::1')).statusCode).toBe(302);
  });
});

describe('limitKey', () => {
  it('adres IPv4 zostaje bez zmian, także zapisany jako IPv6', () => {
    expect(limitKey('203.0.113.5')).toBe('203.0.113.5');
    expect(limitKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });

  it('adres IPv6 sprowadza do sieci /64', () => {
    expect(limitKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(limitKey('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(limitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(limitKey('::1')).toBe('0:0:0:0::/64');
    expect(limitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });
});

describe('serwer przekierowań - pytanie Caddy o certyfikat', () => {
  const ask = (s: ReturnType<typeof setup>, domain: string, headers: Record<string, string> = {}) =>
    s.get(`/.well-known/multiinfo-gate/tls?domain=${domain}`, 'multiinfo-gate:8082', headers, '172.18.0.2');

  it('limit wejść nie obejmuje pytania Caddy: po 60 pytaniach o obce nazwy aktywna domena otrzymuje 200', async () => {
    const s = setup({ trustedProxies: ['172.16.0.0/12'] });
    // Uzgodnienie TLS z dowolną nazwą SNI kosztuje atakującego jeden pakiet, a Caddy pyta bramkę o każdą nazwę.
    for (let i = 0; i < 60; i += 1) await ask(s, `obca-${i}.example`);
    expect((await ask(s, 'l.firma.pl')).statusCode).toBe(200);
  });

  it('pytanie, które przyszło przez serwer pośredniczący (z X-Forwarded-For), nie zdradza domen skracacza bramki', async () => {
    const s = setup({ trustedProxies: ['172.16.0.0/12'] });
    expect((await ask(s, 'firma-link.pl', { 'x-forwarded-for': '198.51.100.7' })).statusCode).toBe(404);
  });
});

describe('serwer przekierowań - nagłówek X-Forwarded-Host', () => {
  it('X-Forwarded-Host od klienta za zaufanym nginx nie zmienia domeny skracacza', async () => {
    const s = setup({ trustedProxies: ['127.0.0.1'] });
    const res = await s.get('/', 'obca-domena.pl', { 'x-forwarded-host': 'l.firma.pl', 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1');
    expect(res.statusCode).toBe(404);
  });

  it('kod domeny l.firma.pl działa pod l.firma.pl także z X-Forwarded-Host innej domeny', async () => {
    const s = setup({ trustedProxies: ['127.0.0.1'] });
    const code = s.addLink();
    const res = await s.get(`/${code}`, 'l.firma.pl', { 'x-forwarded-host': 'firma-link.pl', 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1');
    expect(res.statusCode).toBe(302);
  });
});

describe('serwer przekierowań - metody i body żądań', () => {
  const withLog = () => {
    const errors: string[] = [];
    const log = { info() {}, warn() {}, debug() {}, error: (msg: string) => { errors.push(msg); } };
    return { s: setup({ log }), errors };
  };

  it('POST z błędnym JSON daje stronę „Link wygasł” 404 bez wpisu przekierowania.wyjatek i zamyka połączenie', async () => {
    const { s, errors } = withLog();
    const res = await s.app.inject({ method: 'POST', url: '/aB3xK9q', headers: { host: 'l.firma.pl', 'content-type': 'application/json' }, payload: '{' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Link wygasł');
    expect(res.headers.connection).toBe('close');
    expect(errors).toEqual([]);
  });

  it('POST z body ponad 1 MB daje 404 bez wpisu przekierowania.wyjatek', async () => {
    const { s, errors } = withLog();
    const res = await s.app.inject({ method: 'POST', url: '/aB3xK9q', headers: { host: 'l.firma.pl', 'content-type': 'text/plain' }, payload: 'x'.repeat(1_100_000) });
    expect(res.statusCode).toBe(404);
    expect(errors).toEqual([]);
  });

  it('GET z błędnym body JSON nadal przekierowuje albo daje 404, bez wpisu przekierowania.wyjatek', async () => {
    const { s, errors } = withLog();
    const code = s.addLink();
    const res = await s.app.inject({ method: 'GET', url: `/${code}`, headers: { host: 'l.firma.pl', 'content-type': 'application/json' }, payload: '{' });
    expect([302, 404]).toContain(res.statusCode);
    expect(errors).toEqual([]);
  });

  it('serwer ma limit czasu odbioru żądania', () => {
    // Fastify domyślnie ustawia requestTimeout 0: żądanie z wolno wysyłanym body trzyma połączenie bez końca.
    const s = setup();
    expect(s.app.server.requestTimeout).toBeGreaterThan(0);
    expect(s.app.server.requestTimeout).toBeLessThanOrEqual(15_000);
  });
});

describe('serwer przekierowań - nieudane próby z sieci IPv6 /48', () => {
  it('nieudane próby z wielu sieci /64 jednej sieci /48 mają wspólny limit 600 na minutę', async () => {
    const s = setup();
    const statuses: number[] = [];
    // Sieć /48 zawiera 65 536 sieci /64, czyli tyle osobnych kubełków po 60 prób na minutę.
    for (let i = 1; i <= 601; i += 1) statuses.push((await s.get('/aB3xK9q', 'l.firma.pl', {}, `2001:db8:1:${i.toString(16)}::1`)).statusCode);
    expect(statuses.slice(0, 600).every((code) => code === 404)).toBe(true);
    expect(statuses[600]).toBe(429);
    expect((await s.get('/aB3xK9q', 'l.firma.pl', {}, '2001:db8:2:1::1')).statusCode).toBe(404);
  });

  it('udane wejścia z wielu sieci /64 jednej sieci /48 nie wyczerpują limitu nieudanych prób', async () => {
    const s = setup();
    const code = s.addLink();
    for (let i = 1; i <= 700; i += 1) expect((await s.get(`/${code}`, 'l.firma.pl', {}, `2001:db8:1:${i.toString(16)}::1`)).statusCode).toBe(302);
  });
});

describe('serwer przekierowań - adres klienta z portem', () => {
  it('adres z portem od zaufanego serwera pośredniczącego nie daje osobnego kubełka na każdy port', async () => {
    const s = setup({ trustedProxies: ['10.0.0.1'] });
    const statuses: number[] = [];
    for (let port = 40_000; port < 40_061; port += 1) {
      statuses.push((await s.get('/aB3xK9q', 'l.firma.pl', { 'x-forwarded-for': `203.0.113.5:${port}` }, '10.0.0.1')).statusCode);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('clientKey', () => {
  it('odcina port od adresu IPv4 i IPv6 w nawiasach, a wartość niebędącą adresem zastępuje adresem gniazda', () => {
    expect(clientKey('203.0.113.5:40001', '10.0.0.1')).toBe('203.0.113.5');
    expect(clientKey('[2001:db8:1:2::1]:443', '10.0.0.1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('unknown', '10.0.0.1')).toBe('10.0.0.1');
    expect(clientKey('203.0.113.5', '10.0.0.1')).toBe('203.0.113.5');
  });
});
