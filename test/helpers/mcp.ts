import type { FastifyInstance } from 'fastify';
import type { ToolDef } from '../../src/mcp/tools.ts';
import { z } from '../../src/zod.ts';

/** Narzędzia próbne rejestru: przygotowanie z widokiem i zakresem send oraz wysyłka tylko dla widoku. */
export const prepareSms: ToolDef = {
  name: 'prepare_sms', title: 'Przygotuj SMS', description: 'Sprawdza treść i numery, a następnie zapisuje szkic do podglądu.', scopes: ['send'],
  input: z.object({ text: z.string().min(1).describe('Treść SMS-a') }), annotations: { readOnlyHint: false, openWorldHint: false }, view: 'co-moge',
  run: (_ctx, input) => ({ text: `Szkic: ${(input as { text: string }).text}`, structured: { draft: 'drf_1' } }),
};
export const sendPrepared: ToolDef = {
  name: 'send_prepared', title: 'Wyślij przygotowany SMS', description: 'Wysyła szkic po zatwierdzeniu w widoku.', scopes: ['send', 'send_group'],
  input: z.object({ draftId: z.string() }), annotations: { destructiveHint: true }, appOnly: true, run: () => ({ text: 'Wysłano.' }),
};

/** Możliwości klienta, który wyświetla widoki MCP Apps. */
export const APPS_CAPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };

export interface CallResult {
  content: Array<{ type: string; text: string }>; structuredContent?: Record<string, any>; _meta?: Record<string, any>; isError?: boolean;
}

/** Tekst wyniku narzędzia. */
export const textOf = (r: CallResult): string => r.content.map((c) => c.text).join('\n');

/**
 * Sesja ery poprzedniej pod `/mcp` na zbudowanym serwerze: `initialize`, a potem żądania z nagłówkiem sesji.
 * `apps` deklaruje obsługę widoków.
 */
export async function mcpSession(app: FastifyInstance, token: string, opts: { apps?: boolean } = {}) {
  let id = 1;
  const post = (body: unknown, session?: string) => app.inject({
    method: 'POST', url: '/mcp', payload: JSON.stringify(body),
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`,
      ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' } : {}),
    },
  });
  const init = await post({
    jsonrpc: '2.0', id: id++, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: opts.apps ? APPS_CAPS : {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  const session = init.headers['mcp-session-id'] as string;
  const rpc = (method: string, params: Record<string, unknown> = {}) => post({ jsonrpc: '2.0', id: id++, method, params }, session);
  const result = async (method: string, params: Record<string, unknown> = {}) => (await rpc(method, params)).json().result;
  return {
    rpc, result,
    tools: async (): Promise<Array<Record<string, any>>> => (await result('tools/list')).tools,
    call: async (name: string, args: Record<string, unknown> = {}): Promise<CallResult> => (await rpc('tools/call', { name, arguments: args })).json().result,
  };
}
