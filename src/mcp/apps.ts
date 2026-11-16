import { isObject } from './protocol.ts';

/** Rozszerzenie MCP Apps i typ zasobu widoku (specyfikacja 2026-01-26). */
export const APPS_EXTENSION = 'io.modelcontextprotocol/ui';
export const APP_MIME = 'text/html;profile=mcp-app';

/** Klient obsługuje widoki, gdy w `capabilities.extensions` deklaruje rozszerzenie z typem widoku. */
export function clientSupportsApps(capabilities: unknown): boolean {
  if (!isObject(capabilities) || !isObject(capabilities.extensions)) return false;
  const ui = capabilities.extensions[APPS_EXTENSION];
  return isObject(ui) && Array.isArray(ui.mimeTypes) && ui.mimeTypes.includes(APP_MIME);
}
