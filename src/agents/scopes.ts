import { AGENT_SCOPES, type AgentScope } from '../integrations/config.ts';

export const SCOPE_LABELS: Record<AgentScope, string> = {
  send: 'Wysyłka SMS-ów',
  send_group: 'Wysyłka do grup',
  read_sent: 'Odczyt wysłanych',
  campaigns: 'Wyniki kampanii',
  read_inbound: 'Odczyt odebranych',
  reply: 'Odpowiedź nadawcy',
};

/** Zakresy w stałej kolejności. Odpowiedź nadawcy wymaga odczytu odebranych, bo agent musi widzieć, na co odpowiada. */
export function normalizeScopes(scopes: readonly AgentScope[]): { scopes: AgentScope[]; addedReadInbound: boolean } {
  const set = new Set(scopes);
  const addedReadInbound = set.has('reply') && !set.has('read_inbound');
  if (addedReadInbound) set.add('read_inbound');
  return { scopes: AGENT_SCOPES.filter((s) => set.has(s)), addedReadInbound };
}

/** Wysyłka na dowolne numery razem z odczytem odebranych: treść od obcych może przemycić polecenie wysyłki. */
export const needsWarning = (scopes: readonly AgentScope[]): boolean => scopes.includes('send') && scopes.includes('read_inbound');
