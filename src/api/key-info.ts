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
    };
  });
}
