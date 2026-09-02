import type { AdminUsersRepo } from '../store/admin-users.ts';
import type { AccountsRepo } from '../store/accounts.ts';
import type { ApiKeysRepo } from '../store/api-keys.ts';
import type { IntegrationsRepo } from '../store/integrations.ts';
import type { MessagesRepo } from '../store/messages.ts';
import type { WebhookDeliveriesRepo } from '../store/webhook-deliveries.ts';
import type { NavCounts } from './views/layout.ts';
import { WINDOW_MS } from './window.ts';

export interface NavCountsDeps {
  messages: MessagesRepo;
  accounts: AccountsRepo;
  apiKeys: ApiKeysRepo;
  users: AdminUsersRepo;
  deliveries: WebhookDeliveriesRepo;
  integrations: IntegrationsRepo;
  now?: () => Date;
}

/**
 * Liczby przy pozycjach nawigacji, jedno źródło dla wszystkich ekranów.
 * „Wiadomości” to wiadomości w drodze, nie głębokość kolejki zadań workera -
 * ta druga liczy także zadania rozsyłek i webhooków i nic nie mówi o SMS-ach.
 * „Odebrane” to wiadomości, których aplikacja jeszcze nie dostała albo nie przyjęła
 * (dostawa w toku albo nieudana z ostatniej doby) - nie liczba odebranych, ta rośnie bez końca.
 * „Integracje” to integracje z błędem w ostatniej dobie - liczba integracji nic by nie mówiła.
 */
export function navCounts(deps: NavCountsDeps): NavCounts {
  const at = (deps.now ?? (() => new Date()))();
  return {
    wiadomosci: deps.messages.inTransitCount(),
    odebrane: deps.deliveries.troubledInboundCount(new Date(at.getTime() - WINDOW_MS)),
    konta: deps.accounts.list().length,
    klucze: deps.apiKeys.list().length,
    integracje: deps.integrations.countTroubled(new Date(at.getTime() - WINDOW_MS)),
    uzytkownicy: deps.users.count(),
  };
}
