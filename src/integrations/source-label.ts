import type { AgentConnectionsRepo } from '../store/agent-connections.ts';
import type { IntegrationsRepo } from '../store/integrations.ts';

/**
 * Źródło wysyłki dla człowieka i agenta: „API”, „integracja <nazwa>”, „Power Automate <nazwa>”,
 * „agent <integracja> · <połączenie>” albo „grupa <nazwa> · agent <integracja> · <połączenie>”.
 * Połączenie znika razem z integracją agenta, dlatego wtedy nazwę osoby podaje zapisane `requested_by`.
 */
export function sourceLabel(
  deps: { integrations: Pick<IntegrationsRepo, 'get'>; connectionsRepo: Pick<AgentConnectionsRepo, 'get'> },
  row: { integrationId: number | null; agentConnectionId: number | null; requestedBy: string | null },
): string {
  const integration = row.integrationId === null ? undefined : deps.integrations.get(row.integrationId);
  const connection = row.agentConnectionId === null ? undefined : deps.connectionsRepo.get(row.agentConnectionId);
  const person = connection?.name ?? row.requestedBy;
  const agentIntegration = connection ? deps.integrations.get(connection.integrationId) : integration?.kind === 'agent' ? integration : undefined;
  const agent = `agent ${agentIntegration?.name ?? 'AI'}${person ? ` · ${person}` : ''}`;

  if (!integration) {
    if (connection) return agent;
    return person ? `usunięta integracja · ${person}` : 'API';
  }
  if (integration.kind === 'agent') return agent;
  if (integration.kind === 'power_automate') return `Power Automate ${integration.name}`;
  // Grupa przez agenta: wysyłkę zleciło połączenie, a grupa z SMS-a nie zapisuje zlecającego.
  if (integration.kind === 'sms_group' && (connection || row.requestedBy)) return `grupa ${integration.name} · ${agent}`;
  return `integracja ${integration.name}`;
}
