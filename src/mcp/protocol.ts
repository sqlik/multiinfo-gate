/**
 * Stałe i pomocnicze funkcje protokołu MCP. Bramka obsługuje dwie ery pod jednym adresem `/mcp`: bezstanową
 * rewizję 2026-07-28 (`server/discover`, wersja i możliwości klienta w `_meta` każdego żądania) oraz erę
 * poprzednią z `initialize` i sesjami.
 */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28'];
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18'];
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS];

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;
/** Kody rewizji 2026-07-28: nagłówek niezgodny z treścią i nieobsługiwana wersja protokołu. */
export const HEADER_MISMATCH = -32020, UNSUPPORTED_VERSION = -32022;
/** Zasób o podanym adresie nie istnieje. */
export const RESOURCE_NOT_FOUND = -32002;

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `_meta` z parametrów żądania albo pusty obiekt. */
export function requestMeta(params: unknown): Record<string, unknown> {
  return isObject(params) && isObject(params._meta) ? params._meta : {};
}

/** Nowa era, gdy `_meta` zawiera klucz wersji protokołu, tak jak rozpoznaje to SDK. */
export function requestEra(params: unknown): 'modern' | 'legacy' {
  return META_PROTOCOL_VERSION in requestMeta(params) ? 'modern' : 'legacy';
}

/** Era poprzednia: wersja klienta, gdy bramka ją obsługuje, w przeciwnym razie najnowsza wersja tej ery. */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0]!;
}

/** Wyjątek protokołu zamieniany na odpowiedź JSON-RPC z błędem; `httpStatus` dla błędów transportu. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>, readonly httpStatus = 200) {
    super(message);
    this.name = 'RpcError';
  }
}

export type RpcId = string | number | null;

export function rpcResult(id: RpcId, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: RpcId, code: number, message: string, data?: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}
