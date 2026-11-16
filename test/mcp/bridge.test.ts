import { describe, expect, it, vi } from 'vitest';
import { APPS_PROTOCOL_VERSION, createBridge, esc, stamp } from '../../src/mcp/views/client/bridge.js';

interface Sent { jsonrpc: string; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }

/** Atrapa okna widoku: rodzic zbiera wysłane komunikaty, `deliver` odgrywa komunikat od aplikacji. */
function fakeWindow() {
  const listeners: Array<(event: { data: unknown; source: unknown }) => void> = [];
  const sent: Sent[] = [];
  const parent = { postMessage: (msg: Sent, target: string) => { expect(target).toBe('*'); sent.push(msg); } };
  const win = {
    parent,
    addEventListener: (type: string, fn: (event: { data: unknown; source: unknown }) => void) => { if (type === 'message') listeners.push(fn); },
  };
  const deliver = (data: unknown, source: unknown = parent) => { for (const fn of listeners) fn({ data, source }); };
  return { win, sent, deliver };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const HOST = { protocolVersion: '2026-01-26', hostInfo: { name: 'aplikacja', version: '1.0' }, hostContext: { theme: 'dark', displayMode: 'inline' } };

async function connected(hostCapabilities: Record<string, unknown> = { serverTools: {}, message: {}, openLinks: {} }, handlers: Record<string, unknown> = {}) {
  const w = fakeWindow();
  const bridge = createBridge(w.win, handlers);
  const init = w.sent[0]!;
  w.deliver({ jsonrpc: '2.0', id: init.id, result: { ...HOST, hostCapabilities } });
  await bridge.ready;
  return { ...w, bridge, init };
}

describe('most widoku z aplikacją AI', () => {
  it('host() zwraca hostInfo, możliwości i kontekst aplikacji z wyniku ui/initialize', async () => {
    const { bridge } = await connected({ serverTools: {} });
    expect(bridge.host()).toEqual({ info: { name: 'aplikacja', version: '1.0' }, capabilities: { serverTools: {} }, context: { theme: 'dark', displayMode: 'inline' } });
  });

  it('ui/initialize z wersją 2026-01-26, appInfo i trybami, potem ui/notifications/initialized i kontekst aplikacji', async () => {
    const onContext = vi.fn();
    const { sent, init } = await connected(undefined, { onContext });
    expect(APPS_PROTOCOL_VERSION).toBe('2026-01-26');
    expect(init).toMatchObject({
      jsonrpc: '2.0', method: 'ui/initialize',
      params: { protocolVersion: '2026-01-26', appInfo: { name: 'multiinfo-gate' }, appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] } },
    });
    expect(sent[1]).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    expect(onContext).toHaveBeenCalledWith(HOST.hostContext);
  });

  it('bridge: tool-result wywołuje onToolResult z structuredContent', async () => {
    const onToolResult = vi.fn();
    const onToolInput = vi.fn();
    const { deliver } = await connected(undefined, { onToolResult, onToolInput });
    deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { text: 'Dyżur' } } });
    expect(onToolInput).toHaveBeenCalledWith({ text: 'Dyżur' });
    const result = { content: [{ type: 'text', text: 'Połączenie: Ewa Nowak' }], structuredContent: { available: true, connection: 'Ewa Nowak' } };
    deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result });
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ structuredContent: { available: true, connection: 'Ewa Nowak' } }));
  });

  it('komunikat spoza okna nadrzędnego i komunikat bez jsonrpc 2.0 są pomijane', async () => {
    const onToolResult = vi.fn();
    const { deliver } = await connected(undefined, { onToolResult });
    deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { obcy: true } } }, { inne: 'okno' });
    deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { obcy: true } } });
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it('bridge: callTool wysyła tools/call i rozwiązuje obietnicę odpowiedzią o tym samym id', async () => {
    const { sent, deliver, bridge } = await connected();
    const first = bridge.callTool('connection_status', {});
    const second = bridge.callTool('delivery_trace', { id: 'msg_1' });
    await flush();
    const [a, b] = sent.filter((m) => m.method === 'tools/call');
    expect(a).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'connection_status', arguments: {} } });
    expect(b!.id).not.toBe(a!.id);
    deliver({ jsonrpc: '2.0', id: b!.id, result: { content: [{ type: 'text', text: 'drugie' }] } });
    deliver({ jsonrpc: '2.0', id: a!.id, result: { content: [{ type: 'text', text: 'pierwsze' }], structuredContent: { ok: 1 } } });
    await expect(first).resolves.toMatchObject({ structuredContent: { ok: 1 } });
    await expect(second).resolves.toMatchObject({ content: [{ text: 'drugie' }] });
  });

  it('bridge: odpowiedź z błędem odrzuca obietnicę komunikatem', async () => {
    const { sent, deliver, bridge } = await connected();
    const call = bridge.callTool('connection_status', {});
    await flush();
    const req = sent.find((m) => m.method === 'tools/call')!;
    deliver({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'Serwer MCP jest niedostępny' } });
    await expect(call).rejects.toThrow('Serwer MCP jest niedostępny');
  });

  it('bridge: ui/resource-teardown dostaje pusty wynik, nieznane żądanie aplikacji -32601', async () => {
    const { sent, deliver } = await connected();
    deliver({ jsonrpc: '2.0', id: 'td-1', method: 'ui/resource-teardown', params: {} });
    expect(sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 'td-1', result: {} });
    deliver({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage', params: {} });
    expect(sent.at(-1)).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32601 } });
  });

  it('bridge: bez hostCapabilities.serverTools callTool odrzuca obietnicę komunikatem', async () => {
    const { sent, bridge } = await connected({ message: {} });
    await expect(bridge.callTool('connection_status', {})).rejects.toThrow(/nie pozwala widokowi wywoływać narzędzi bramki/);
    expect(sent.some((m) => m.method === 'tools/call')).toBe(false);
  });

  it('ui/message tylko przy hostCapabilities.message, w przeciwnym razie false bez wysyłki', async () => {
    const { sent, deliver, bridge } = await connected();
    const sending = bridge.sendMessage('Popraw treść SMS-a');
    await flush();
    const req = sent.find((m) => m.method === 'ui/message')!;
    expect(req.params).toEqual({ role: 'user', content: [{ type: 'text', text: 'Popraw treść SMS-a' }] });
    deliver({ jsonrpc: '2.0', id: req.id, result: {} });
    await expect(sending).resolves.toBe(true);

    const bare = await connected({ serverTools: {} });
    await expect(bare.bridge.sendMessage('Popraw treść SMS-a')).resolves.toBe(false);
    expect(bare.sent.some((m) => m.method === 'ui/message')).toBe(false);
  });

  it('ui/open-link, ui/request-display-mode i ui/notifications/size-changed', async () => {
    const { sent, deliver, bridge } = await connected();
    const link = bridge.openLink('https://bramka.serwis.example/pobierz/abc');
    await flush();
    const open = sent.find((m) => m.method === 'ui/open-link')!;
    expect(open.params).toEqual({ url: 'https://bramka.serwis.example/pobierz/abc' });
    deliver({ jsonrpc: '2.0', id: open.id, result: { isError: true } });
    await expect(link).resolves.toBe(false);

    const mode = bridge.requestDisplayMode('fullscreen');
    await flush();
    const req = sent.find((m) => m.method === 'ui/request-display-mode')!;
    expect(req.params).toEqual({ mode: 'fullscreen' });
    deliver({ jsonrpc: '2.0', id: req.id, result: { mode: 'inline' } });
    await expect(mode).resolves.toBe('inline');

    bridge.notifySize({ width: 640, height: 412 });
    bridge.notifySize({ width: 640, height: 412 });
    expect(sent.filter((m) => m.method === 'ui/notifications/size-changed')).toEqual([
      { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 640, height: 412 } },
    ]);
  });

  it('host-context-changed scala kontekst, tool-cancelled przekazuje powód', async () => {
    const onContext = vi.fn();
    const onToolCancelled = vi.fn();
    const { deliver } = await connected(undefined, { onContext, onToolCancelled });
    deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
    expect(onContext).toHaveBeenLastCalledWith({ theme: 'light', displayMode: 'inline' });
    deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled', params: { reason: 'Użytkownik przerwał' } });
    expect(onToolCancelled).toHaveBeenCalledWith('Użytkownik przerwał');
  });
});

describe('pomocniki widoków', () => {
  it('esc ucieka &, <, >, cudzysłów i apostrof', () => {
    expect(esc(`<img src=x onerror="alert('1')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
    expect(esc(null)).toBe('');
  });

  it('stamp podaje czas warszawski RRRR-MM-DD GG:MM także po zmianie czasu', () => {
    expect(stamp('2026-11-15T11:40:00.000Z')).toBe('2026-11-15 12:40');
    expect(stamp('2026-10-24T22:30:00.000Z')).toBe('2026-10-25 00:30');
    expect(stamp('2026-07-01T10:00:00.000Z')).toBe('2026-07-01 12:00');
  });
});
