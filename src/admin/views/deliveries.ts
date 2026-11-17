import { sourceLabel } from '../../integrations/source-label.ts';
import type { DeliveryRow } from '../../store/webhook-deliveries.ts';
import type { AdminDeps } from '../server.ts';
import { esc } from './layout.ts';

export interface DeliveryView {
  delivery: DeliveryRow; keyName: string;
  /** Dostawa integracji wychodzącej: nazwa integracji zamiast klucza. */
  integration?: { id: number; name: string } | null;
}

/** Odnośnik do integracji; usunięta zostaje jako numer, żeby ślad nie zniknął. */
export function integrationLink(deps: Pick<AdminDeps, 'integrations'>, id: number): { id: number; name: string } {
  return { id, name: deps.integrations.get(id)?.name ?? `integracja ${id}` };
}

/** Źródło wiadomości albo rozsyłki słowami (`sourceLabel`); powiadomienie bramki jest oznaczone źródłem „bramka”. */
export function sourceWords(
  deps: Pick<AdminDeps, 'integrations' | 'agentConnections'>,
  row: { integrationId: number | null; agentConnectionId: number | null; requestedBy: string | null; system?: number; fileSendId?: string | null },
): string {
  if (row.system === 1) return 'bramka';
  return sourceLabel({ integrations: deps.integrations, connectionsRepo: deps.agentConnections }, row);
}

/** Wiersz „Połączenie” w szczegółach: nazwa osoby i odnośnik do integracji agenta. Nazwa zastępuje wiersz „Zlecający”. */
export function connectionRow(connection: { name: string; integration: { id: number; name: string } } | null | undefined): string {
  if (!connection) return '';
  return `<div>Połączenie</div><div>${esc(connection.name)} · <a href="/integracje/${esc(connection.integration.id)}">${esc(connection.integration.name)}</a></div>`;
}

/** Połączenie agenta, które zleciło wysyłkę, z integracją agenta; brak dla wysyłek bez połączenia. */
export function connectionLink(
  deps: Pick<AdminDeps, 'integrations' | 'agentConnections'>, id: number | null,
): { name: string; integration: { id: number; name: string } } | null {
  const connection = id === null ? undefined : deps.agentConnections.get(id);
  if (!connection) return null;
  return { name: connection.name, integration: integrationLink(deps, connection.integrationId) };
}

/** Widok dostawy dla obu szczegółów: klucz po nazwie, a dla dostawy integracji także integracja. */
export function deliveryView(deps: Pick<AdminDeps, 'apiKeys' | 'integrations'>, delivery: DeliveryRow): DeliveryView {
  return {
    delivery, keyName: deps.apiKeys.get(delivery.apiKeyId)?.name ?? `klucz ${delivery.apiKeyId}`,
    integration: delivery.integrationId === null ? null : integrationLink(deps, delivery.integrationId),
  };
}

const state = (d: DeliveryRow) =>
  d.status === 'delivered' ? '<span class="st"><span class="dot dot-ok"></span>doręczony</span>'
    : d.status === 'failed' ? '<span class="st"><span class="dot dot-fail"></span>nieudany</span>'
      : '<span class="st"><span class="dot dot-wait"></span>w toku</span>';

/**
 * Dostawa `message.received` z konta bez przechowywania treści po stanie końcowym ma już tylko
 * skrót - treści SMS-a nie ma nigdzie w bramce, więc nie da się jej wysłać ponownie.
 */
export function scrubbed(d: DeliveryRow): boolean {
  if (d.event !== 'message.received') return false;
  // Body dostawy integracji ma kształt obcej aplikacji; po wyczyszczeniu zostaje sam znacznik.
  if (d.integrationId !== null) return d.payload === '{"scrubbed":true}';
  try {
    const payload = JSON.parse(d.payload) as Record<string, unknown>;
    return typeof payload.text !== 'string' && typeof payload.hex !== 'string';
  } catch {
    return true;
  }
}

function action(d: DeliveryRow): string {
  if (d.status !== 'failed') return '';
  if (scrubbed(d)) {
    return '<span class="dim" style="font-size: 11px;">treść nieprzechowywana, aplikacja pobiera ją przez GET /v1/inbound</span>';
  }
  return `<form method="post" action="/dostawy/${esc(d.id)}/ponow"><button class="btn btn-s" type="submit" style="padding: 4px 9px; font-size: 12px;">Ponów</button></form>`;
}

/** Tabela dostaw do aplikacji - ta sama w szczególe odebranej i wysłanej; `withEvent` dodaje kolumnę zdarzenia. */
export function deliveriesTable(rows: DeliveryView[], emptyText: string, withEvent = false): string {
  const columns = withEvent ? 6 : 5;
  const body = rows.length === 0
    ? `<tr><td class="dim" colspan="${columns}">${esc(emptyText)}</td></tr>`
    : rows.map(({ delivery, keyName, integration }) => `<tr>
        <td class="txt">
          ${integration ? `<a href="/integracje/${esc(integration.id)}"><strong>${esc(integration.name)}</strong></a> <span class="tag">integracja</span>` : `<strong>${esc(keyName)}</strong>`}
          <div class="m dim txt" style="font-size: 11px; margin-top: 2px;" title="${esc(delivery.url)}">${esc(delivery.url)}</div>
        </td>
        ${withEvent ? `<td class="m">${esc(delivery.event)}</td>` : ''}
        <td class="m">${esc(delivery.attempts)}</td>
        <td class="nw">${state(delivery)}</td>
        <td class="m dim txt" title="${esc(delivery.lastResponse ?? '')}">${esc(delivery.lastResponse ?? '')}</td>
        <td>${action(delivery)}</td>
      </tr>`).join('');
  return `<table style="table-layout: fixed;">
          <tr><th>Klucz albo integracja · adres</th>${withEvent ? '<th style="width: 130px;">Zdarzenie</th>' : ''}<th style="width: 36px;">Próby</th><th style="width: 80px;">Stan</th><th style="width: 220px;">Odpowiedź</th><th style="width: 76px;"></th></tr>
          ${body}
        </table>`;
}
