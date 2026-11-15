import { effectiveExpiry } from '../../agents/connections.ts';
import { SCOPE_LABELS } from '../../agents/scopes.ts';
import { senderOptions } from '../../integrations/agent.ts';
import { warsawStamp } from '../../time/warsaw.ts';
import { z } from '../../zod.ts';
import type { ToolContext, ToolDef, ToolResult } from '../tools.ts';

const MIN = 60_000;

function unavailable(ctx: ToolContext): ToolResult {
  const details = ctx.deps.connections.details(ctx.connectionId);
  const connection = details?.connection.name ?? '-';
  const integration = details?.integrationName ?? '-';
  const reason = ctx.unavailable ?? 'powód nieznany';
  return {
    text: [
      `Połączenie: ${connection}, integracja ${integration}.`,
      `Połączenie jest chwilowo niedostępne: ${reason}. Dostęp przywraca administrator bramki, a połączenie zadziała ponownie bez nowego kodu.`,
    ].join('\n'),
    structured: { available: false, connection, integration, reason },
  };
}

/** „Co mogę?”: uprawnienia, usługi, limity i ważność połączenia, także gdy integracja jest chwilowo niedostępna. */
export const connectionStatusTool: ToolDef = {
  name: 'connection_status',
  title: 'Co mogę?',
  description: 'Pokazuje, co to połączenie może zrobić w bramce SMS: uprawnienia, usługi Multiinfo, limity i ważność połączenia. '
    + 'Wywołaj je na początku pracy oraz wtedy, gdy inne narzędzie odmówi.',
  scopes: 'any',
  input: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  view: 'co-moge',
  run(ctx) {
    const conn = ctx.conn;
    if (conn === null) return unavailable(ctx);
    const { deps, now } = ctx;
    const config = conn.integration.config;
    const scopes = [...conn.scopes].map((id) => ({ id, label: SCOPE_LABELS[id] }));
    const expiresAt = effectiveExpiry(conn.connection, conn.key.expiresAt);
    const options = senderOptions(deps, conn);
    // Usługa bez nazwy w koncie ma w senderOptions etykietę równą identyfikatorowi; widok pokazuje wtedy sam identyfikator.
    const services = options.services.map((s) => ({ id: s.id, label: s.label === s.id ? null : s.label }));
    const defaultSender = options.senders.find((s) => s.value === options.orig)?.label ?? options.orig ?? '-';
    const others = options.senders.filter((s) => s.value !== options.orig).map((s) => s.label);
    const { limit, windowMinutes, recipients: recipientLimit } = config.throttle;
    const window = deps.guards.peek(conn.integration.id, windowMinutes, now);
    const resetsAt = window.windowStart === null ? null : new Date(Date.parse(window.windowStart) + windowMinutes * MIN).toISOString();
    const groups = deps.integrations.listForKey(conn.key.id).filter((i) => i.kind === 'sms_group' && i.enabled === 1).length;

    const lines = [
      `Połączenie: ${conn.connection.name}, integracja ${conn.integration.name}.`,
      `Uprawnienia: ${scopes.map((s) => s.label).join(', ')}.`,
      expiresAt === null ? 'Połączenie jest ważne bez terminu.' : `Połączenie jest ważne do ${warsawStamp(expiresAt)} czasu polskiego.`,
      `Usługi Multiinfo: ${services.map((s) => (s.label ? `${s.id} ${s.label}` : s.id)).join(', ')}.`,
      `Nadawca domyślny: ${defaultSender}.` + (others.length > 0 ? ` Inni nadawcy do wyboru: ${others.join(', ')}.` : ''),
      `Limit części SMS-a: ${config.maxParts}. ${config.overflow === 'reject' ? 'Dłuższa treść zostaje odrzucona.' : 'Dłuższa treść zostaje skrócona do tego limitu.'}`,
      `Limit żądań klucza: ${conn.key.ratePerMin} na minutę.`,
      `Ochrona przed burzą: wykorzystano ${window.count} z ${limit} wywołań wysyłających i ${window.recipients} z ${recipientLimit} odbiorców w oknie ${windowMinutes} minut.`
        + (resetsAt === null ? '' : ` Okno kończy się ${warsawStamp(resetsAt)} czasu polskiego.`),
      `Grupy SMS klucza: ${groups}.`,
    ];
    return {
      text: lines.join('\n'),
      structured: {
        available: true, connection: conn.connection.name, integration: conn.integration.name, scopes, expiresAt, services, senders: options.senders, orig: options.orig,
        maxParts: config.maxParts, overflow: config.overflow, ratePerMin: conn.key.ratePerMin,
        guard: { calls: window.count, callLimit: limit, recipients: window.recipients, recipientLimit, windowMinutes, resetsAt }, groups,
      },
      // Punkt kontrolny A: znacznik pokazuje, czy agent aplikacji widzi _meta wyniku. Zadanie 13 go usuwa.
      meta: { 'multiinfo-gate/proba': 'Znacznik _meta: MIG-META-PROBA' },
    };
  },
};
