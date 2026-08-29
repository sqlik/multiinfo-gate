import type { FastifyInstance } from 'fastify';
import type { Renderer } from '../render.ts';
import type { AdminDeps } from '../server.ts';
import { scrubbed } from '../views/deliveries.ts';

/** Dokąd wrócić po akcji: do odebranej albo do wiadomości, której zdarzenie dotyczy. */
function backTo(delivery: { inboundId: string | null; payload: string }): string {
  if (delivery.inboundId !== null) return `/odebrane/${delivery.inboundId}`;
  try {
    const id = (JSON.parse(delivery.payload) as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') return `/wiadomosci/${id}`;
  } catch { /* payload bez identyfikatora - przegląd */ }
  return '/przeglad';
}

export function registerDeliveryRoutes(app: FastifyInstance, deps: AdminDeps, render: Renderer): void {
  const now = deps.now ?? (() => new Date());
  const actorOf = (userId: number | null): string => {
    if (userId === null) return '(nieznany)';
    return deps.users.findById(userId)?.login ?? String(userId);
  };

  /**
   * Ponowienie nieudanej dostawy webhooka: wraca do kolejki jak nowa, worker podpisze ją bieżącym
   * sekretem klucza. Odmowy tłumaczą się komunikatem, nie błędem - to akcja z listy.
   */
  app.post<{ Params: { id: string } }>('/dostawy/:id/ponow', async (request, reply) => {
    const id = Number(request.params.id);
    const delivery = deps.deliveries.get(id);
    if (!delivery) return reply.callNotFound();
    const back = backTo(delivery);
    const key = deps.apiKeys.get(delivery.apiKeyId);

    if (delivery.status !== 'failed') {
      render.flash(request, 'warn', 'Ponowić można tylko dostawę nieudaną.');
    } else if (scrubbed(delivery)) {
      render.flash(request, 'warn', 'Treść tej wiadomości nie jest przechowywana - aplikacja może ją dociągnąć przez GET /v1/inbound.');
    } else if (!key || key.revokedAt !== null || key.webhookUrl === null) {
      render.flash(request, 'warn', 'Klucz jest odwołany albo nie ma adresu webhooka - nie ma dokąd dostarczyć.');
    } else {
      const at = now();
      deps.deliveries.requeue(id);
      deps.jobs.enqueue('webhook', { deliveryId: id }, at);
      deps.audit.record({
        actor: actorOf(request.adminUserId), action: 'dostawa.ponowienie', target: `dostawa:${id}`,
        meta: { zdarzenie: delivery.event, klucz: key.name, adres: delivery.url },
        ip: request.ip,
      });
      render.flash(request, 'ok', `Dostawa ponowiona - ${delivery.event} pójdzie na ${delivery.url} za chwilę.`);
    }
    return reply.redirect(back, 302);
  });
}
