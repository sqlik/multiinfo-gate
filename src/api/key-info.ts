import type { FastifyInstance } from 'fastify';
import { authenticate } from './auth.ts';
import { ApiError } from './errors.ts';
import { keyOrigs } from './orig.ts';
import type { ApiDeps } from './server.ts';

/**
 * Uprawnienia klucza, którym aplikacja się uwierzytelnia: usługi, nadpisy i limity. Służy listom
 * wyboru (konektor Power Automate) i sprawdzeniu klucza przez programistę. Bez danych konta
 * Multiinfo i bez sekretów: odpowiedź mówi tylko o kluczu, którego aplikacja i tak używa.
 */
/**
 * Skracanie linków przy kluczu: tryb, aktywne domeny skracacza z domyślną, ważność i UTM. Lista dozwolonych
 * domen docelowych zostaje w panelu, bo aplikacja nie potrzebuje jej do wysyłki. Tryb „off” daje pustą listę.
 */
function linksBlock(deps: ApiDeps, keyId: number) {
  const s = deps.apiKeys.linkSettings(keyId);
  const domains = s.mode === 'off' ? [] : s.domainIds
    .map((id) => deps.linkDomains.get(id))
    .filter((d) => d !== undefined && d.enabled === 1)
    .map((d) => ({ domain: d!.domain, default: d!.id === s.defaultDomainId }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
  return { mode: s.mode, domains, validityDays: s.validityDays, utm: s.utm };
}

export function registerKeyInfoRoute(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/v1/key', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    if (!deps.rateLimiter.check(auth.apiKeyId, auth.ratePerMin)) {
      throw new ApiError(429, 'rate_limited', `Przekroczono limit ${auth.ratePerMin} żądań na minutę.`);
    }

    const key = deps.apiKeys.get(auth.apiKeyId);
    const account = deps.accounts.get(auth.accountId);
    if (!key || !account) throw new ApiError(500, 'account_missing', 'Konto przypisane do klucza nie istnieje.');

    const { allowed, fallback } = keyOrigs(auth, account, deps.accounts);
    return {
      name: key.name,
      services: auth.allowedServiceIds.map((id) => ({ id, default: id === auth.defaultServiceId })),
      origs: allowed.map((orig) => ({ orig, default: orig === fallback })),
      maxParts: auth.maxParts,
      ratePerMin: auth.ratePerMin,
      links: linksBlock(deps, key.id),
    };
  });
}
