import type { FastifyInstance } from 'fastify';
import { authenticate } from './auth.ts';
import { cancelMessage } from './cancel-message.ts';
import type { ApiDeps } from './server.ts';

export function registerCancelRoute(app: FastifyInstance, deps: ApiDeps): void {
  const now = deps.now ?? (() => new Date());

  app.post<{ Params: { id: string } }>('/v1/messages/:id/cancel', async (request) => {
    const auth = authenticate(request.headers.authorization, deps.apiKeys);
    return cancelMessage(deps, auth.apiKeyId, request.params.id, now());
  });
}
