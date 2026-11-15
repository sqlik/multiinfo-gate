import type { ConnectionContext } from '../agents/connections.ts';
import { SCOPE_LABELS } from '../agents/scopes.ts';
import { ApiError } from '../api/errors.ts';
import type { AgentServerDeps, ApiDeps } from '../api/server.ts';
import { AgentError } from '../integrations/agent.ts';
import type { AgentScope } from '../integrations/config.ts';
import type { PipelineDeps } from '../integrations/pipeline.ts';
import { silentLogger } from '../log.ts';
import { z } from '../zod.ts';
import { RPC, RpcError } from './protocol.ts';
import { viewUri, type ViewId } from './views/index.ts';

/** Zależności narzędzi: agenci, potok integracji i to z API, czego potrzebuje wysyłka. */
export type AgentToolDeps = AgentServerDeps & PipelineDeps & Pick<ApiDeps, 'packages' | 'clients' | 'rateLimiter' | 'linksServer' | 'notifier'>;

export interface ToolResult { text: string; structured?: Record<string, unknown>; meta?: Record<string, unknown>; isError?: boolean }

/**
 * Kontekst wywołania. `conn` jest pusty, gdy połączenie istnieje, ale integracja, klucz albo konto są
 * niedostępne; powód podaje `unavailable`. `apps` mówi, czy aplikacja wyświetla widoki: w erze poprzedniej
 * według sesji, w nowej według możliwości klienta w bieżącym żądaniu.
 */
export interface ToolContext {
  connectionId: number;
  /** Sesja ery poprzedniej; nowa era nie ma sesji. */
  sessionId: string | null;
  conn: ConnectionContext | null;
  unavailable: string | null;
  apps: boolean;
  protocolVersion: string;
  deps: AgentToolDeps;
  base: string | null;
  now: Date;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scopes: readonly AgentScope[] | 'any';
  input: z.ZodType;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  view?: ViewId;
  /** Narzędzie dla widoku: przy obsłudze widoków agent go nie widzi, a wysyła człowiek przyciskiem. */
  appOnly?: boolean;
  run(ctx: ToolContext, input: unknown): ToolResult | Promise<ToolResult>;
}

/** Schemat wejścia z zod z opisami pól, bez nagłówka `$schema`. */
function inputSchema(input: z.ZodType): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>;
  return schema;
}

const allowedBy = (def: ToolDef, scopes: ReadonlySet<AgentScope> | null): boolean =>
  def.scopes === 'any' || (scopes !== null && def.scopes.some((s) => scopes.has(s)));

/** Lista `tools/list` według zakresów połączenia; bez zakresów (integracja niedostępna) tylko narzędzia „każdy”. */
export function visibleTools(defs: readonly ToolDef[], scopes: ReadonlySet<AgentScope> | null, apps: boolean): Array<Record<string, unknown>> {
  return defs.filter((def) => allowedBy(def, scopes)).map((def) => {
    // Bez widoków narzędzie wysyłki jest widoczne dla agenta, dlatego aplikacja musi wiedzieć, że działa nieodwracalnie.
    const destructive = !apps && def.appOnly === true && def.annotations.readOnlyHint !== true;
    const annotations = { title: def.title, ...def.annotations, ...(destructive ? { destructiveHint: true } : {}) };
    const ui = apps ? { ...(def.view ? { resourceUri: viewUri(def.view) } : {}), ...(def.appOnly ? { visibility: ['app'] } : {}) } : {};
    return {
      name: def.name, title: def.title, description: def.description, inputSchema: inputSchema(def.input), annotations,
      ...(Object.keys(ui).length > 0 ? { _meta: { ui } } : {}),
    };
  });
}

const toolError = (text: string, structured?: Record<string, unknown>): Record<string, unknown> =>
  ({ content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}), isError: true });

/** Czas ponowienia dla człowieka: sekundy poniżej minuty, powyżej pełne minuty w górę. */
const retryText = (sec: number): string => (sec < 60 ? `Spróbuj ponownie za ${sec} s.` : `Spróbuj ponownie za ${Math.ceil(sec / 60)} min.`);

function toCallResult(r: ToolResult): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: r.text }], ...(r.structured ? { structuredContent: r.structured } : {}), ...(r.meta ? { _meta: r.meta } : {}),
    ...(r.isError ? { isError: true } : {}),
  };
}

/**
 * `tools/call`: zakres, limit żądań klucza (ten sam licznik co API), walidacja argumentów i wynik. Błędy
 * walidacji, zakresu i potoku są błędami narzędzia, ponieważ agent może je poprawić sam. Nieznane narzędzie
 * jest błędem protokołu.
 */
export async function callTool(defs: readonly ToolDef[], ctx: ToolContext, name: string, args: unknown): Promise<Record<string, unknown>> {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new RpcError(RPC.invalidParams, `Narzędzie ${name} nie istnieje.`);
  const conn = ctx.conn;
  if (conn === null) {
    if (def.scopes !== 'any') {
      return toolError(`Połączenie jest chwilowo niedostępne: ${ctx.unavailable ?? 'powód nieznany'}. Dostęp przywraca administrator bramki.`);
    }
  } else {
    if (!allowedBy(def, conn.scopes)) {
      const labels = (def.scopes as readonly AgentScope[]).map((s) => `„${SCOPE_LABELS[s]}”`).join(' ani ');
      return toolError(`Połączenie nie ma uprawnienia ${labels}. Uprawnienia nadaje administrator bramki w integracji Agent AI.`);
    }
    if (!ctx.deps.rateLimiter.check(conn.key.id, conn.key.ratePerMin)) {
      return toolError(`Przekroczono limit ${conn.key.ratePerMin} żądań na minutę klucza. Spróbuj ponownie za minutę.`);
    }
  }
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : 'argumenty'}: ${i.message}`).join(' ');
    return toolError(`Nieprawidłowe argumenty narzędzia. ${fields}`);
  }
  ctx.deps.connectionsRepo.touch(ctx.connectionId, ctx.now);
  try {
    return toCallResult(await def.run(ctx, parsed.data));
  } catch (error) {
    if (error instanceof AgentError) {
      const retry = error.retryAfterSec;
      return toolError(retry === undefined ? error.message : `${error.message} ${retryText(retry)}`,
        { error: error.code, ...(retry === undefined ? {} : { retryAfterSec: retry }) });
    }
    if (error instanceof ApiError) return toolError(error.message, { error: error.code });
    // Argumenty mogą zawierać numery i treść SMS-ów, dlatego nie trafiają do logu.
    (ctx.deps.log ?? silentLogger).error('mcp.wyjatek', { tool: name, connectionId: ctx.connectionId, error });
    return toolError('Błąd wewnętrzny bramki.');
  }
}
