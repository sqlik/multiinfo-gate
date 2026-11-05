// Serwer przekierowań krótkich linków: trzeci serwer bramki obok API i panelu. Obsługuje wyłącznie
// przekierowania, stronę główną domeny, strony „Link wygasł” i sprawdzenie domeny. Nie zapisuje adresu IP
// ani nagłówka User-Agent wejścia; adres klienta służy tylko do limitu żądań w pamięci procesu.
import { isIPv4, isIPv6 } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { RateLimiter } from '../api/rate-limit.ts';
import { silentLogger } from '../log.ts';
import { isAutomated } from './bots.ts';
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
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Klucz limitu żądań: adres IPv4 albo sieć /64 adresu IPv6. Operator komórkowy przydziela telefonowi
 * całą sieć /64, więc limit na pojedynczy adres IPv6 można by obejść zmianą adresu w tej sieci.
 */
export function limitKey(ip: string): string {
  const address = ip.split('%')[0]!.toLowerCase();
  if (!isIPv6(address)) return address;
  if (address.startsWith('::ffff:') && isIPv4(address.slice(7))) return address.slice(7);
  const [head = '', tail] = address.split('::');
  const groups = (part: string | undefined): string[] => (part ? part.split(':') : []);
  const width = (parts: string[]): number => parts.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0);
  const h = groups(head);
  const t = groups(tail);
  const all = tail === undefined ? h : [...h, ...Array<string>(8 - width(h) - width(t)).fill('0'), ...t];
  return `${all.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16)).join(':')}::/64`;
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

export function buildLinksServer(deps: LinksServerDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;
  const limiter = new RateLimiter(() => now().getTime());

  const app = Fastify({
    logger: false,
    ...(deps.trustedProxies?.length ? { trustProxy: deps.trustedProxies } : {}),
    // Zepsuty adres (błędne kodowanie procentowe) omija trasy: także wtedy strona „Link wygasł”.
    frameworkErrors: (_error, _request, reply) => { sendPage(reply, 404, expiredPage(null)); },
  });

  const expired = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    sendPage(reply, 404, expiredPage(domainFor(deps.linkDomains, request.host)?.displayName ?? null));

  const respond = (request: FastifyRequest, reply: FastifyReply, code: string | null): FastifyReply => {
    const result = handleClick(deps, request.host, code, isAutomated(request.method, request.headers), now());
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
    if (!limiter.check(limitKey(request.ip), RATE_PER_MIN)) return sendPage(reply.header('retry-after', '60'), 429, limitPage());
  });

  app.setErrorHandler((error, request, reply) => {
    log.error('przekierowania.wyjatek', { method: request.method, url: request.url.split('?')[0], error });
    return sendPage(reply, 500, unavailablePage());
  });
  app.setNotFoundHandler((request, reply) => expired(request, reply));

  // Pytanie Caddy przed wystawieniem certyfikatu na żądanie: 200 wyłącznie dla aktywnej domeny skracacza.
  app.get<{ Querystring: { domain?: unknown } }>('/.well-known/multiinfo-gate/tls', async (request, reply) => {
    const name = typeof request.query.domain === 'string' ? hostName(request.query.domain) : null;
    if (name === null || deps.linkDomains.byDomain(name)?.enabled !== 1) return expired(request, reply);
    return noStore(reply).type('text/plain; charset=utf-8').send('ok');
  });

  app.get<{ Params: { token: string } }>('/.well-known/multiinfo-gate/:token', async (request, reply) => {
    const domain = domainFor(deps.linkDomains, request.host);
    if (domain === null || !deps.checks.answer(request.params.token, now(), domain.id)) return expired(request, reply);
    return noStore(reply).type('text/plain; charset=utf-8').send(request.params.token);
  });

  // Fastify obsługuje HEAD tymi samymi trasami; isAutomated uznaje HEAD za wejście automatu.
  app.get('/', async (request, reply) => respond(request, reply, null));
  app.get<{ Params: { code: string } }>('/:code', async (request, reply) => respond(request, reply, request.params.code));

  return app;
}
