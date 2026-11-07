import { domainToASCII } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DomainChecks } from '../../src/links/domain-checks.ts';
import { LinkDomainError, LinkDomainService, type DomainServiceDeps } from '../../src/links/domains.ts';
import { AuditRepo } from '../../src/store/audit.ts';
import { NOW, redirectFixture } from './redirect-fixture.ts';

const ADMIN = { id: 1, login: 'janek' };
const NEW = { domain: 'firma-sms.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false };

type Net = { resolve: NonNullable<DomainServiceDeps['resolve']>; fetch: NonNullable<DomainServiceDeps['fetch']> };

/** Błąd `fetch` z Node: `TypeError: fetch failed` z przyczyną z kodem gniazda albo TLS. */
const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

function setup(opts: { allowPrivate?: boolean } = {}) {
  const f = redirectFixture();
  const audit = new AuditRepo(f.db);
  const checks = new DomainChecks();
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const lookups: string[] = [];
  const net: Net = {
    resolve: async (host) => { lookups.push(host); return ['203.0.113.10']; },
    // Domyślnie odpowiada jak serwer przekierowań tej bramki: tokenem, gdy jest ważny dla domeny.
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const u = new URL(url);
      const token = u.pathname.split('/').pop() ?? '';
      const domain = f.linkDomains.byDomain(u.hostname);
      return new Response(domain && checks.answer(token, NOW, domain.id) ? token : 'Link wygasł', { status: 200 });
    }) as typeof fetch,
  };
  const service = new LinkDomainService({
    linkDomains: f.linkDomains, shortLinks: f.shortLinks, audit, checks,
    resolve: (host) => net.resolve(host), fetch: ((input, init) => net.fetch(input, init)) as typeof fetch,
    ...(opts.allowPrivate ? { allowPrivate: true } : {}),
  });
  const entries = () => f.db.prepare('SELECT actor, action, target, meta FROM audit_log ORDER BY id').all() as
    Array<{ actor: string; action: string; target: string; meta: string | null }>;
  return { ...f, audit, checks, net, calls, lookups, service, entries };
}

const rejects = (fn: () => unknown, text: string | RegExp) => {
  expect(fn).toThrow(LinkDomainError);
  expect(fn).toThrow(text);
};

describe('LinkDomainService: zapis domeny', () => {
  it('zapisuje domenę w postaci małymi literami, bez kropki na końcu i bez spacji', () => {
    const s = setup();
    const id = s.service.create({ ...NEW, domain: '  Firma-SMS.PL. ' }, ADMIN, NOW);
    expect(s.linkDomains.get(id)).toMatchObject({ domain: 'firma-sms.pl', displayName: 'Firma Serwis', enabled: 1, checkedAt: null });
    expect(s.entries().at(-1)).toMatchObject({ actor: 'janek', action: 'skracacz.domena.utworzenie', target: `skracacz:${id}` });
    expect(JSON.parse(s.entries().at(-1)!.meta!)).toMatchObject({ domain: 'firma-sms.pl' });
  });

  it('domenę z polskimi znakami zapisuje w postaci xn--, którą przeglądarka wysyła w nagłówku Host', () => {
    const s = setup();
    const id = s.service.create({ ...NEW, domain: 'łącze-serwis.pl' }, ADMIN, NOW);
    expect(s.linkDomains.get(id)!.domain).toBe(domainToASCII('łącze-serwis.pl'));
  });

  it('odrzuca domenę ze schematem, ścieżką, portem albo bez kropki, z tekstem do panelu', () => {
    const s = setup();
    rejects(() => s.service.create({ ...NEW, domain: 'https://firma-sms.pl' }, ADMIN, NOW), /bez https:\/\//);
    rejects(() => s.service.create({ ...NEW, domain: 'firma-sms.pl/oferta' }, ADMIN, NOW), /bez https:\/\/ i bez ścieżki/);
    rejects(() => s.service.create({ ...NEW, domain: 'firma-sms.pl:8443' }, ADMIN, NOW), /bez portu/);
    rejects(() => s.service.create({ ...NEW, domain: 'firma' }, ADMIN, NOW), /na przykład l\.firma\.pl/);
    rejects(() => s.service.create({ ...NEW, domain: 'firma_sms.pl' }, ADMIN, NOW), /na przykład l\.firma\.pl/);
    rejects(() => s.service.create({ ...NEW, domain: '' }, ADMIN, NOW), /Podaj domenę/);
    expect(s.linkDomains.list()).toHaveLength(2);
  });

  it('odrzuca pustą nazwę wyświetlaną i adres strony głównej spoza http i https', () => {
    const s = setup();
    rejects(() => s.service.create({ ...NEW, displayName: '  ' }, ADMIN, NOW), /nazwę wyświetlaną/);
    rejects(() => s.service.create({ ...NEW, displayName: 'x'.repeat(101) }, ADMIN, NOW), /100 znaków/);
    rejects(() => s.service.create({ ...NEW, homeUrl: 'javascript:alert(1)' }, ADMIN, NOW), /https:\/\//);
    rejects(() => s.service.create({ ...NEW, homeUrl: 'firma.pl' }, ADMIN, NOW), /https:\/\//);
    const id = s.service.create({ ...NEW, homeUrl: ' https://firma.pl/ ' }, ADMIN, NOW);
    expect(s.linkDomains.get(id)!.homeUrl).toBe('https://firma.pl/');
    const empty = s.service.create({ ...NEW, domain: 'l2.firma.pl', homeUrl: '  ' }, ADMIN, NOW);
    expect(s.linkDomains.get(empty)!.homeUrl).toBeNull();
  });

  it('odrzuca domenę już dodaną, także zapisaną inną wielkością liter', () => {
    const s = setup();
    rejects(() => s.service.create({ ...NEW, domain: 'L.Firma.pl' }, ADMIN, NOW), 'Domena l.firma.pl jest już dodana');
  });

  it('zmiana: zapisuje pola, odrzuca nazwę innej domeny i odnotowuje zmianę w dzienniku', () => {
    const s = setup();
    s.service.update(s.domainId, { domain: 'l.firma.pl', displayName: 'Serwis Klimatyzacji', homeUrl: null, bareLinks: true }, ADMIN, NOW);
    expect(s.linkDomains.get(s.domainId)).toMatchObject({ displayName: 'Serwis Klimatyzacji', bareLinks: 1 });
    expect(s.entries().at(-1)).toMatchObject({ action: 'skracacz.domena.zmiana', target: `skracacz:${s.domainId}` });
    rejects(() => s.service.update(s.domainId, { ...NEW, domain: 'firma-link.pl' }, ADMIN, NOW), 'Domena firma-link.pl jest już dodana');
  });

  it('zmiana nazwy domeny z wysłanymi linkami jest odrzucona, bo linki w SMS-ach przestałyby działać', () => {
    const s = setup();
    s.addLink();
    rejects(() => s.service.update(s.domainId, { ...NEW, domain: 'l3.firma.pl' }, ADMIN, NOW), /wysłane SMS-y zawierają linki/);
    expect(s.linkDomains.get(s.domainId)!.domain).toBe('l.firma.pl');
  });

  it('zmiana nazwy domeny bez linków kasuje wynik sprawdzenia, który dotyczył poprzedniej nazwy', () => {
    const s = setup();
    s.linkDomains.setCheck(s.otherId, true, null, NOW);
    s.service.update(s.otherId, { ...NEW, domain: 'firma-krotko.pl' }, ADMIN, NOW);
    expect(s.linkDomains.get(s.otherId)).toMatchObject({ domain: 'firma-krotko.pl', checkedAt: null, checkOk: null });
  });

  it('wyłączenie i włączenie zmieniają stan i trafiają do dziennika', () => {
    const s = setup();
    s.service.setEnabled(s.domainId, false, ADMIN, NOW);
    expect(s.linkDomains.get(s.domainId)!.enabled).toBe(0);
    expect(s.entries().at(-1)).toMatchObject({ action: 'skracacz.domena.wylaczenie' });
    s.service.setEnabled(s.domainId, true, ADMIN, NOW);
    expect(s.linkDomains.get(s.domainId)!.enabled).toBe(1);
    expect(s.entries().at(-1)).toMatchObject({ action: 'skracacz.domena.wlaczenie' });
  });
});

describe('LinkDomainService: usunięcie domeny', () => {
  it('domena przypisana do klucza nie może zostać usunięta, a komunikat wymienia klucze', () => {
    const s = setup();
    rejects(() => s.service.remove(s.domainId, ADMIN, NOW), /przypisana do klucza Serwis klimatyzacji/);
    rejects(() => s.service.remove(s.domainId, ADMIN, NOW), /wyłączyć/);
    expect(s.linkDomains.get(s.domainId)).toBeDefined();
  });

  it('domena z kodami przed końcem retencji podaje datę, od której usunięcie będzie możliwe', () => {
    const s = setup();
    const id = s.service.create(NEW, ADMIN, NOW);
    s.addLink({ domainId: id, purgeAfter: '2027-03-05T10:00:00.000Z' });
    s.addLink({ domainId: id, purgeAfter: '2027-04-20T10:00:00.000Z' });
    rejects(() => s.service.remove(id, ADMIN, NOW), 'Usunięcie domeny będzie możliwe od 2027-04-20 12:00');
    rejects(() => s.service.remove(id, ADMIN, NOW), /wyłączyć/);
  });

  it('przypisanie do klucza odwołanego nie blokuje usunięcia, bo odwołanego klucza nie można już edytować', () => {
    const s = setup();
    s.apiKeys.revoke(s.apiKeyId);
    s.service.remove(s.otherId, ADMIN, NOW);
    expect(s.linkDomains.get(s.otherId)).toBeUndefined();
    expect(s.apiKeys.linkSettings(s.apiKeyId).domainIds).toEqual([s.domainId]);
    s.service.remove(s.domainId, ADMIN, NOW);
    expect(s.apiKeys.linkSettings(s.apiKeyId)).toMatchObject({ domainIds: [], defaultDomainId: null });
  });

  it('usuwa domenę wolną i odnotowuje to w dzienniku', () => {
    const s = setup();
    const id = s.service.create(NEW, ADMIN, NOW);
    s.service.remove(id, ADMIN, NOW);
    expect(s.linkDomains.get(id)).toBeUndefined();
    expect(s.entries().at(-1)).toMatchObject({ action: 'skracacz.domena.usuniecie', target: `skracacz:${id}` });
    expect(JSON.parse(s.entries().at(-1)!.meta!)).toMatchObject({ domain: 'firma-sms.pl' });
  });

  it('nieznana domena daje błąd z tekstem do panelu', () => {
    const s = setup();
    rejects(() => s.service.remove(999, ADMIN, NOW), 'Nie znaleziono domeny');
  });
});

describe('LinkDomainService: sprawdzenie domeny', () => {
  it('udane sprawdzenie pobiera token przez https z nagłówkiem Host domeny i zapisuje wynik', async () => {
    const s = setup();
    const r = await s.service.check(s.domainId, ADMIN, NOW);
    expect(r).toEqual({ ok: true });
    expect(s.lookups).toEqual(['l.firma.pl']);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toMatch(/^https:\/\/l\.firma\.pl\/\.well-known\/multiinfo-gate\/[A-Za-z0-9_-]{32}$/);
    expect(s.calls[0]!.init).toMatchObject({ redirect: 'manual' });
    expect(s.calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    expect(s.linkDomains.get(s.domainId)).toMatchObject({ checkedAt: NOW.toISOString(), checkOk: 1, checkDetail: null });
    expect(s.entries().at(-1)).toMatchObject({ action: 'skracacz.domena.sprawdzenie', target: `skracacz:${s.domainId}` });
    expect(JSON.parse(s.entries().at(-1)!.meta!)).toEqual({ domain: 'l.firma.pl', ok: true });
  });

  it('błąd rozwiązania nazwy to krok dns', async () => {
    const s = setup();
    s.net.resolve = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND l.firma.pl'), { code: 'ENOTFOUND' }); };
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'dns', detail: 'ENOTFOUND' });
    expect(s.calls).toHaveLength(0);
    expect(s.linkDomains.get(s.domainId)).toMatchObject({ checkOk: 0, checkDetail: 'dns ENOTFOUND' });
    expect(JSON.parse(s.entries().at(-1)!.meta!)).toEqual({ domain: 'l.firma.pl', ok: false, step: 'dns', detail: 'ENOTFOUND' });
  });

  it('adres w sieci wewnętrznej zatrzymuje sprawdzenie przed połączeniem, jak przy webhookach', async () => {
    const s = setup();
    s.net.resolve = async () => ['203.0.113.10', '10.0.0.5'];
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'dns', detail: 'private 10.0.0.5' });
    s.net.resolve = async () => ['127.0.0.1'];
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'dns', detail: 'private 127.0.0.1' });
    s.net.resolve = async () => ['fd00::5'];
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'dns', detail: 'private fd00::5' });
    expect(s.calls).toHaveLength(0);
  });

  it('serwer pośredniczący bez zaufania: sprawdzenie udane z adresem tego serwera w wyniku, w bazie i w dzienniku', async () => {
    const s = setup();
    s.net.fetch = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      const token = u.pathname.split('/').pop() ?? '';
      const domain = s.linkDomains.byDomain(u.hostname)!;
      return new Response(s.checks.answer(token, NOW, domain.id, '172.18.0.3') ? token : 'Link wygasł');
    }) as typeof fetch;
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: true, untrustedProxy: '172.18.0.3' });
    expect(s.linkDomains.get(s.domainId)).toMatchObject({ checkOk: 1, checkDetail: 'proxy 172.18.0.3' });
    expect(JSON.parse(s.entries().at(-1)!.meta!)).toEqual({ domain: 'l.firma.pl', ok: true, untrustedProxy: '172.18.0.3' });
  });

  it('MIG_LINKS_ALLOW_PRIVATE=1: domena z adresem w sieci wewnętrznej przechodzi pełne sprawdzenie', async () => {
    const s = setup({ allowPrivate: true });
    s.net.resolve = async () => ['192.168.1.20'];
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: true });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toMatch(/^https:\/\/l\.firma\.pl\/\.well-known\/multiinfo-gate\//);
  });

  it('nazwa bez adresów to krok dns', async () => {
    const s = setup();
    s.net.resolve = async () => [];
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'dns', detail: 'ENODATA' });
  });

  it.each([
    ['ECONNREFUSED', 'connect'],
    ['ECONNRESET', 'connect'],
    ['EHOSTUNREACH', 'connect'],
    ['ETIMEDOUT', 'connect'],
    ['UND_ERR_CONNECT_TIMEOUT', 'connect'],
    ['ENOTFOUND', 'dns'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['CERT_NOT_YET_VALID', 'tls'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls'],
  ])('błąd %s przy połączeniu to krok %s', async (code, step) => {
    const s = setup();
    s.net.fetch = (async () => { throw fetchFailed(code); }) as typeof fetch;
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step, detail: code });
  });

  it('przekroczenie czasu to krok connect', async () => {
    const s = setup();
    s.net.fetch = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch;
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'connect', detail: 'timeout' });
  });

  it('inna treść albo inny kod odpowiedzi to krok response', async () => {
    const s = setup();
    s.net.fetch = (async () => new Response('<html>nginx</html>', { status: 200 })) as typeof fetch;
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'response', detail: 'token' });
    s.net.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'response', detail: 'HTTP 404' });
    s.net.fetch = (async () => new Response(null, { status: 301, headers: { location: 'https://firma.pl/' } })) as typeof fetch;
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'response', detail: 'HTTP 301' });
    expect(s.linkDomains.get(s.domainId)).toMatchObject({ checkOk: 0, checkDetail: 'response HTTP 301' });
  });

  it('token innej domeny tej samej bramki nie potwierdza sprawdzenia', async () => {
    const s = setup();
    // Serwer pośredniczący kieruje wszystko do jednej domeny: odpowiedź przychodzi spod firma-link.pl.
    s.net.fetch = (async (input: string | URL | Request) => {
      const token = String(input).split('/').pop()!;
      return new Response(s.checks.answer(token, NOW, s.otherId) ? token : 'Link wygasł');
    }) as typeof fetch;
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'response', detail: 'token' });
  });

  it('token odesłany przez obcy serwer, bez udziału serwera przekierowań bramki, nie potwierdza domeny', async () => {
    const s = setup();
    // Serwer, który odsyła ostatni człon ścieżki, na przykład inna usługa pod tą domeną.
    s.net.fetch = (async (input: string | URL | Request) => new Response(String(input).split('/').pop())) as typeof fetch;
    expect(await s.service.check(s.domainId, ADMIN, NOW)).toEqual({ ok: false, step: 'response', detail: 'token' });
    expect(s.checks.size).toBe(0);
  });

  it('nieznana domena daje błąd z tekstem do panelu', async () => {
    const s = setup();
    await expect(s.service.check(999, ADMIN, NOW)).rejects.toThrow('Nie znaleziono domeny');
  });
});
