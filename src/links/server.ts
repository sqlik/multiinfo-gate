// Serwer przekierowań krótkich linków: trzeci serwer bramki obok API i panelu. Obsługuje wyłącznie
// przekierowania, stronę główną domeny, strony „Link wygasł” i sprawdzenie domeny. Nie zapisuje adresu IP
// ani nagłówka User-Agent wejścia; adres klienta służy tylko do limitu żądań w pamięci procesu.
import { isIP, isIPv4, isIPv6 } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { RateLimiter } from '../api/rate-limit.ts';
import { silentLogger } from '../log.ts';
import { isAutomated } from './bots.ts';
import { isCode } from './codes.ts';
import { domainFor, handleClick, hostName, locationHeader, type ClickDeps } from './clicks.ts';
import type { DomainChecks } from './domain-checks.ts';
import { expiredPage, homePage, limitPage, unavailablePage } from './pages.ts';

export interface LinksServerDeps extends ClickDeps {
  checks: DomainChecks;
  /** Serwery pośredniczące, którym wolno podać adres klienta (MIG_TRUSTED_PROXIES). */
  trustedProxies?: string[];
  now?: () => Date;
}

/** Limit żądań na adres klienta przeciw przeszukiwaniu kodów. */
const RATE_PER_MIN = 60;
/**
 * Limit nieudanych prób (odpowiedź 404) na sieć IPv6 /48. Sieć /48 zawiera 65 536 sieci /64, czyli tyle osobnych
 * kubełków limitu podstawowego. Odbiorcy z prawdziwymi linkami nie otrzymują odpowiedzi 404.
 */
const FAILED_PER_MIN_48 = 600;
/** Czas na odebranie całego żądania. Bez niego wolno wysyłane body trzyma połączenie bez końca. */
const REQUEST_TIMEOUT_MS = 10_000;
const TLS_PATH = '/.well-known/multiinfo-gate/tls';
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Osiem grup adresu IPv6 w zapisie szesnastkowym bez zer wiodących. */
function ipv6Groups(address: string): string[] {
  const [head = '', tail] = address.split('::');
  const groups = (part: string | undefined): string[] => (part ? part.split(':') : []);
  const width = (parts: string[]): number => parts.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0);
  const h = groups(head);
  const t = groups(tail);
  const all = tail === undefined ? h : [...h, ...Array<string>(8 - width(h) - width(t)).fill('0'), ...t];
  return all.map((g) => (g.includes('.') ? g : Number.parseInt(g, 16).toString(16)));
}

/**
 * Klucz limitu żądań: adres IPv4 albo sieć /64 adresu IPv6. Operator komórkowy przydziela telefonowi
 * całą sieć /64, więc limit na pojedynczy adres IPv6 można by obejść zmianą adresu w tej sieci.
 */
export function limitKey(ip: string): string {
  const address = ip.split('%')[0]!.toLowerCase();
  if (!isIPv6(address)) return address;
  if (address.startsWith('::ffff:') && isIPv4(address.slice(7))) return address.slice(7);
  return `${ipv6Groups(address).slice(0, 4).join(':')}::/64`;
}

/** Klucz limitu nieudanych prób: sieć /48 adresu IPv6; null dla adresu IPv4. */
function failureKey(ip: string): string | null {
  const address = ip.split('%')[0]!.toLowerCase();
  if (!isIPv6(address) || (address.startsWith('::ffff:') && isIPv4(address.slice(7)))) return null;
  return `${ipv6Groups(address).slice(0, 3).join(':')}::/48`;
}

/**
 * Klucz limitu dla adresu klienta podanego przez serwer pośredniczący. Niektóre serwery dopisują port
 * (`203.0.113.5:40001`, `[2001:db8::1]:443`): bez jego odcięcia każdy port dawałby osobny kubełek.
 * Wartość, która nie jest adresem IP, zastępuje adres gniazda.
 */
export function clientKey(ip: string, socket: string): string {
  return limitKey(clientAddress(ip, socket));
}

function clientAddress(ip: string, socket: string): string {
  const value = ip.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  const address = bracketed ? bracketed[1]! : /^[\d.]+:\d+$/.test(value) ? value.slice(0, value.lastIndexOf(':')) : value;
  return isIP(address.split('%')[0]!) ? address : socket;
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
}

function sendPage(reply: FastifyReply, status: number, html: string): FastifyReply {
  return noStore(reply).code(status).header('content-security-policy', PAGE_CSP).type('text/html; charset=utf-8').send(html);
}

function redirect(reply: FastifyReply, location: string): FastifyReply {
  return noStore(reply).code(302).header('location', location).send();
}

/** Interpunkcja, którą telefon dołącza do linku na końcu zdania, na przykład „Zapis: l.firma.pl/aB3xK9q.”. */
const TRAILING_PUNCTUATION = /[.,;:!?…)"'»”]+$/u;

/** Kod ze ścieżki; interpunkcja na końcu odpada wyłącznie wtedy, gdy reszta jest poprawnym kodem. */
export function pathCode(segment: string): string {
  const trimmed = segment.replace(TRAILING_PUNCTUATION, '');
  return trimmed !== segment && isCode(trimmed) ? trimmed : segment;
}

export function buildLinksServer(deps: LinksServerDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;
  const limiter = new RateLimiter(() => now().getTime());
  const failures = new RateLimiter(() => now().getTime());

  const app = Fastify({
    logger: false,
    requestTimeout: REQUEST_TIMEOUT_MS,
    bodyLimit: 1024,
    ...(deps.trustedProxies?.length ? { trustProxy: deps.trustedProxies } : {}),
    // Zepsuty adres (błędne kodowanie procentowe) omija trasy: także wtedy strona „Link wygasł”.
    frameworkErrors: (_error, _request, reply) => { sendPage(reply, 404, expiredPage(null)); },
  });

  // Domenę wskazuje wyłącznie nagłówek Host. Fastify za zaufanym serwerem pośredniczącym podstawia w request.host
  // nagłówek X-Forwarded-Host, który nginx przekazuje od klienta bez zmian.
  const hostOf = (request: FastifyRequest): string | null => request.headers.host ?? null;
  const addressOf = (request: FastifyRequest): string => clientAddress(request.ip, request.socket.remoteAddress ?? '');
  // Pytanie Caddy o certyfikat przychodzi wprost, bez X-Forwarded-For, i nie podlega limitowi wejść: Caddy pyta
  // o każdą nazwę z uzgodnienia TLS, więc obce nazwy wyczerpałyby limit i zablokowały certyfikat nowej domeny.
  const caddyAsk = (request: FastifyRequest): boolean =>
    request.url.split('?')[0] === TLS_PATH && request.headers['x-forwarded-for'] === undefined;

  const expired = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    sendPage(reply, 404, expiredPage(domainFor(deps.linkDomains, hostOf(request))?.displayName ?? null));

  const respond = (request: FastifyRequest, reply: FastifyReply, code: string | null): FastifyReply => {
    const result = handleClick(deps, hostOf(request), code, isAutomated(request.method, request.headers), now());
    switch (result.kind) {
      case 'redirect':
        return redirect(reply, result.location);
      case 'home':
        return result.domain.homeUrl
          ? redirect(reply, locationHeader(result.domain.homeUrl))
          : sendPage(reply, 200, homePage(result.domain.displayName));
      case 'expired':
        return sendPage(reply, result.status, expiredPage(result.domain?.displayName ?? null));
    }
  };

  app.addHook('onRequest', async (request, reply) => {
    if (!caddyAsk(request)) {
      const address = addressOf(request);
      const network = failureKey(address);
      if (!limiter.check(limitKey(address), RATE_PER_MIN) || (network !== null && failures.exhausted(network, FAILED_PER_MIN_48))) {
        return sendPage(reply.header('retry-after', '60'), 429, limitPage());
      }
    }
    // Przekierowania obsługują wyłącznie GET i HEAD. Body innych metod bramka nie odczytuje i zamyka połączenie.
    if (request.method !== 'GET' && request.method !== 'HEAD') return expired(request, reply.header('connection', 'close'));
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode === 404 && !caddyAsk(request)) {
      const network = failureKey(addressOf(request));
      if (network !== null) failures.check(network, FAILED_PER_MIN_48);
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    // Błąd żądania (zepsute albo zbyt duże body) nie jest awarią bramki: strona „Link wygasł” bez wpisu w dzienniku.
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status < 500) return expired(request, reply);
    log.error('przekierowania.wyjatek', { method: request.method, url: request.url.split('?')[0], error });
    return sendPage(reply, 500, unavailablePage());
  });
  app.setNotFoundHandler((request, reply) => expired(request, reply));

  // Pytanie Caddy przed wystawieniem certyfikatu na żądanie: 200 wyłącznie dla aktywnej domeny skracacza.
  // Pytanie przez serwer pośredniczący (z X-Forwarded-For) pochodzi z internetu i nie może sprawdzać domen bramki.
  app.get<{ Querystring: { domain?: unknown } }>(TLS_PATH, async (request, reply) => {
    const name = typeof request.query.domain === 'string' && caddyAsk(request) ? hostName(request.query.domain) : null;
    if (name === null || deps.linkDomains.byDomain(name)?.enabled !== 1) return expired(request, reply);
    return noStore(reply).type('text/plain; charset=utf-8').send('ok');
  });

  app.get<{ Params: { token: string } }>('/.well-known/multiinfo-gate/:token', async (request, reply) => {
    const domain = domainFor(deps.linkDomains, hostOf(request));
    // Nagłówek X-Forwarded-For, którego bramka nie uwzględniła, oznacza serwer pośredniczący spoza MIG_TRUSTED_PROXIES.
    // Limit wejść liczy wtedy wszystkie kliknięcia na jego adres, dlatego panel ostrzega o tym przy sprawdzeniu domeny.
    const remote = request.socket.remoteAddress ?? '';
    const untrusted = request.headers['x-forwarded-for'] !== undefined && request.ip === remote ? remote.replace(/^::ffff:(?=\d+\.)/, '') : null;
    if (domain === null || !deps.checks.answer(request.params.token, now(), domain.id, untrusted)) return expired(request, reply);
    return noStore(reply).type('text/plain; charset=utf-8').send(request.params.token);
  });

  // Fastify obsługuje HEAD tymi samymi trasami; isAutomated uznaje HEAD za wejście automatu.
  app.get('/', async (request, reply) => respond(request, reply, null));
  app.get<{ Params: { code: string } }>('/:code', async (request, reply) => respond(request, reply, pathCode(request.params.code)));

  return app;
}
