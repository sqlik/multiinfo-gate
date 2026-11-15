/**
 * Błąd potoku agenta z komunikatem dla człowieka. Narzędzie MCP zamienia go na błąd narzędzia, a przy limicie
 * dopisuje czas do ponowienia. Zadanie 9 dopisuje w tym module potok agenta.
 */
export class AgentError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterSec?: number) {
    super(message);
    this.name = 'AgentError';
  }
}
