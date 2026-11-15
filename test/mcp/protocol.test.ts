import { describe, expect, it } from 'vitest';
import { APP_MIME, APPS_EXTENSION, clientSupportsApps } from '../../src/mcp/apps.ts';
import {
  LEGACY_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSIONS, negotiateVersion, requestEra, RPC, SUPPORTED_PROTOCOL_VERSIONS,
} from '../../src/mcp/protocol.ts';

describe('wersje protokołu', () => {
  it('obsługiwane wersje: najnowsza 2026-07-28 i era poprzednia', () => {
    expect(MODERN_PROTOCOL_VERSIONS).toEqual(['2026-07-28']);
    expect(LEGACY_PROTOCOL_VERSIONS).toEqual(['2025-11-25', '2025-06-18']);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(['2026-07-28', '2025-11-25', '2025-06-18']);
    expect(RPC).toEqual({ parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 });
  });

  it('era żądania po kluczu wersji w _meta', () => {
    expect(requestEra({ _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } })).toBe('modern');
    expect(requestEra({ _meta: { 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } })).toBe('modern');
    expect(requestEra({ protocolVersion: '2025-11-25' })).toBe('legacy');
    expect(requestEra({ _meta: { progressToken: 1 } })).toBe('legacy');
    expect(requestEra(undefined)).toBe('legacy');
    expect(requestEra('tekst')).toBe('legacy');
  });

  it('uzgodnienie wersji w erze poprzedniej: wersja klienta z listy, inaczej najnowsza poprzedniej ery', () => {
    expect(negotiateVersion('2025-06-18')).toBe('2025-06-18');
    expect(negotiateVersion('2025-11-25')).toBe('2025-11-25');
    expect(negotiateVersion('2024-11-05')).toBe('2025-11-25');
    expect(negotiateVersion('2026-07-28')).toBe('2025-11-25');
    expect(negotiateVersion(undefined)).toBe('2025-11-25');
  });
});

describe('rozszerzenie MCP Apps', () => {
  it('obsługa widoków z capabilities.extensions z typem widoku', () => {
    expect(APPS_EXTENSION).toBe('io.modelcontextprotocol/ui');
    expect(APP_MIME).toBe('text/html;profile=mcp-app');
    expect(clientSupportsApps({ extensions: { [APPS_EXTENSION]: { mimeTypes: [APP_MIME] } } })).toBe(true);
    expect(clientSupportsApps({ extensions: { [APPS_EXTENSION]: { mimeTypes: ['text/html'] } } })).toBe(false);
    expect(clientSupportsApps({ extensions: { [APPS_EXTENSION]: {} } })).toBe(false);
    expect(clientSupportsApps({ roots: {} })).toBe(false);
    expect(clientSupportsApps(null)).toBe(false);
  });
});
