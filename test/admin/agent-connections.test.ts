import { beforeEach, describe, expect, it } from 'vitest';
import { handoffText } from '../../src/admin/views/agent-connections.ts';
import { AGENTS_DOCS_URL } from '../../src/docs-links.ts';
import { defaultAgentConfig, defaultSmsGroupConfig } from '../../src/integrations/config.ts';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

const NOW = new Date('2026-11-15T10:00:00Z');
const CODE = /[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/;
const TOKEN = /mig_mcp_[A-Za-z0-9_-]{43}/;

let h: AdminHarness;
let accountId: number;
let apiKeyId: number;
let agentId: number;

function agentIntegration(name: string, enabled: 0 | 1 = 1): number {
  return h.integrations.insert({
    name, kind: 'agent', apiKeyId, serviceId: null, orig: null, preset: 'agent-ai', enabled,
    config: defaultAgentConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
  });
}

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Marketing', keyHash: 'argon2:aaa', keyPrefix: 'a1b2c3d4', defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
    webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  h.settings.setApiUrl('https://sms.firma.pl', NOW);
  agentId = agentIntegration('Agent AI - marketing');
});

const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string, fields: Record<string, string> = {}) => h.app.inject({
  method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString(),
});
const addConnection = (over: Record<string, string> = {}, id = agentId) =>
  post(`/integracje/${id}/polaczenia`, { name: 'Ewa Nowak', method: 'oauth', codeValidity: '24h', validity: '90d', ...over });
const connections = () => h.agentConnections.listForIntegration(agentId);
const auditActions = () => h.audit.list(50, 0).map((e) => e.action);

/** Połączenie z logowaniem po użyciu kodu przez aplikację, z jednym tokenem dostępu. */
function usedConnection(name: string): number {
  const created = h.connectionService.create(agentId, { name, method: 'oauth', codeValidity: '24h', validity: '90d' }, 'janek', NOW);
  if (!h.oauth.getClient('klient-1')) {
    h.oauth.upsertClient({
      clientId: 'klient-1', kind: 'dynamic', name: 'claude.ai', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], sourceIp: null,
      createdAt: NOW.toISOString(), fetchedAt: null,
    });
  }
  h.agentConnections.useCode(created.id, { clientId: 'klient-1', clientName: 'claude.ai' }, NOW);
  h.oauth.insertToken(`skrot-tokenu-${created.id}`, { connectionId: created.id, kind: 'access', expiresAt: '2026-11-15T11:00:00.000Z', createdAt: NOW.toISOString() });
  return created.id;
}

describe('dodanie połączenia', () => {
  it('formularz dodania pokazuje sposoby połączenia z przykładowymi aplikacjami i ważności', async () => {
    const res = await get(`/integracje/${agentId}/polaczenia/nowe`);
    expect(res.statusCode).toBe(200);
    for (const t of ['Dodaj połączenie', 'Agent AI - marketing', 'Aplikacja z logowaniem', 'claude.ai, ChatGPT, aplikacje Claude, Gemini Enterprise',
      'Aplikacja z kluczem w nagłówku', 'Copilot Studio, Claude Code, VS Code, n8n', 'Ważność kodu', 'Ważność połączenia']) {
      expect(res.body).toContain(t);
    }
    expect(res.body).toMatch(/<option value="24h" selected>/);
    expect(res.body).toMatch(/<option value="90d" selected>/);
  });

  it('dodanie połączenia z logowaniem pokazuje kod, adres MCP i tekst do przekazania, zapisuje agent.polaczenie_utworzenie', async () => {
    const res = await addConnection();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const code = res.body.match(CODE)?.[0];
    expect(code).toBeDefined();
    expect(res.body).toContain('https://sms.firma.pl/mcp');
    expect(res.body).toContain('Tekst do przekazania');
    expect(res.body).toContain(AGENTS_DOCS_URL);
    expect(res.body).toContain('2026-11-16 11:00');
    expect(res.body).toContain('2027-02-13');
    expect(res.body).toContain('Customize');
    const [row] = connections();
    expect(row).toMatchObject({ name: 'Ewa Nowak', method: 'oauth', createdBy: 'janek' });
    const entry = h.audit.list(10, 0).find((e) => e.action === 'agent.polaczenie_utworzenie');
    expect(entry?.target).toBe('Agent AI - marketing / Ewa Nowak');
    expect(JSON.stringify(entry)).not.toContain(code!);
  });

  it('połączenie z kluczem w nagłówku pokazuje token i instrukcję nagłówka, bez ważności kodu', async () => {
    const res = await addConnection({ method: 'token', name: 'Serwer n8n' });
    expect(res.statusCode).toBe(200);
    const token = res.body.match(TOKEN)?.[0];
    expect(token).toBeDefined();
    expect(res.body).toContain(`Authorization: Bearer ${token}`);
    expect(res.body).not.toMatch(CODE);
    expect(res.body).not.toContain('Kod ważny do');
    expect(connections()[0]).toMatchObject({ method: 'token', codeExpiresAt: null });
  });

  it('strona z sekretem odświeżona drugi raz nie pokazuje kodu', async () => {
    const code = (await addConnection()).body.match(CODE)![0];
    const again = await get(`/integracje/${agentId}/polaczenia`);
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toBe(`/integracje/${agentId}#polaczenia`);
    const details = (await get(`/integracje/${agentId}`)).body;
    expect(details).toContain('Ewa Nowak');
    expect(details).not.toContain(code);
  });

  it('nazwa połączenia powtórzona w integracji: błąd formularza', async () => {
    await addConnection();
    const res = await addConnection({ name: '  ewa nowak ' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Integracja zawiera już połączenie o tej nazwie');
    expect(res.body).not.toMatch(CODE);
    expect(connections()).toHaveLength(1);
    // Ta sama nazwa w innej integracji jest dozwolona.
    const other = agentIntegration('Agent AI - dyspozytornia');
    expect((await addConnection({}, other)).statusCode).toBe(200);
  });

  it('pusta nazwa, nieznany sposób i ważność spoza listy: błąd formularza bez zapisu', async () => {
    for (const over of [{ name: '  ' }, { method: 'haslo' }, { validity: '2d' }, { codeValidity: '30d' }, { name: 'x'.repeat(81) }]) {
      const res = await addConnection(over);
      expect(res.statusCode).toBe(400);
    }
    expect(connections()).toHaveLength(0);
  });

  it('nazwa z cudzysłowem i znacznikiem wyświetla się jako tekst', async () => {
    const res = await addConnection({ name: 'Ewa "<b>Nowak</b>"' });
    expect(res.body).toContain('Ewa &quot;&lt;b&gt;Nowak&lt;/b&gt;&quot;');
    expect(res.body).not.toContain('<b>Nowak</b>');
    expect((await get(`/integracje/${agentId}`)).body).not.toContain('<b>Nowak</b>');
  });

  it('integracja innego rodzaju nie ma połączeń: 404', async () => {
    const group = h.integrations.insert({
      name: 'SERWIS', kind: 'sms_group', apiKeyId, serviceId: null, orig: null, preset: 'sms-group', enabled: 1,
      config: defaultSmsGroupConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    expect((await get(`/integracje/${group}/polaczenia/nowe`)).statusCode).toBe(404);
    expect((await addConnection({}, group)).statusCode).toBe(404);
    expect((await get('/integracje/999/polaczenia/nowe')).statusCode).toBe(404);
  });

  it('bez adresu bramki strona z sekretem prosi o adres zamiast tekstu do przekazania', async () => {
    h.settings.setApiUrl(null, NOW);
    const res = await addConnection();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(CODE);
    expect(res.body).toContain('Panel nie zna adresu bramki');
    expect(res.body).not.toContain('/mcp</');
  });
});

describe('sekcja „Połączenia” w szczegółach', () => {
  it('pokazuje stany, aplikację, ostatnie użycie i ważność z przyciskami według stanu', async () => {
    const waiting = h.connectionService.create(agentId, { name: 'Ewa Nowak', method: 'oauth', codeValidity: '1h', validity: '90d' }, 'janek', NOW).id;
    const used = usedConnection('Jan Kowalski');
    h.agentConnections.touch(used, new Date('2026-11-15T09:30:00Z'));
    const token = h.connectionService.create(agentId, { name: 'Serwer n8n', method: 'token', codeValidity: '24h', validity: 'none' }, 'janek', NOW).id;
    const expiredCode = h.connectionService.create(agentId, { name: 'Anna Wiśniewska', method: 'oauth', codeValidity: '15m', validity: '30d' }, 'janek', new Date('2026-11-14T10:00:00Z')).id;
    const revoked = usedConnection('Piotr Zieliński');
    h.connectionService.revoke(revoked, NOW);

    const body = (await get(`/integracje/${agentId}`)).body;
    const section = body.slice(body.indexOf('id="polaczenia"'), body.indexOf('<div class="lab">Dziennik</div>'));
    for (const t of ['Nazwa', 'Aplikacja', 'Stan', 'Ostatnie użycie', 'Ważne do']) expect(section).toContain(`>${t}<`);
    expect(section).toMatch(/czeka na kod<\/span><div[^>]*>do 2026-11-15 12:00</);
    expect(section).toContain('claude.ai');
    expect(section).toContain('klucz w nagłówku');
    expect(section).toContain('kod wygasł');
    expect(section).toContain('odwołane');
    expect(section).toContain('2026-11-15 10:30');
    expect(section).toContain('2027-02-13');
    expect(section).toContain(`href="/integracje/${agentId}/polaczenia/${waiting}/kod"`);
    expect(section).toContain(`action="/integracje/${agentId}/polaczenia/${token}/token"`);
    expect(section).toContain(`action="/integracje/${agentId}/polaczenia/${used}/odwolaj"`);
    expect(section).toContain(`action="/integracje/${agentId}/polaczenia/${waiting}/usun"`);
    expect(section).toContain(`action="/integracje/${agentId}/polaczenia/${expiredCode}/usun"`);
    expect(section).not.toContain(`/polaczenia/${used}/usun"`);
    expect(section).not.toContain(`/polaczenia/${revoked}/odwolaj"`);
    expect(section).toContain(`href="/integracje/${agentId}/polaczenia/nowe"`);
    expect(body.indexOf('id="polaczenia"')).toBeGreaterThan(body.indexOf('<div class="lab">Konfiguracja</div>'));
  });

  it('pusta lista zachęca do dodania połączenia', async () => {
    const body = (await get(`/integracje/${agentId}`)).body;
    expect(body).toContain('Integracja nie zawiera jeszcze połączeń.');
    expect(body).toContain(`href="/integracje/${agentId}/polaczenia/nowe"`);
  });

  it('wyłączona integracja: połączenia nie działają do ponownego włączenia', async () => {
    const off = agentIntegration('Agent AI - dyspozytornia', 0);
    const body = (await get(`/integracje/${off}`)).body;
    expect(body).toContain('Integracja jest wyłączona, dlatego jej połączenia nie działają. Po ponownym włączeniu integracji połączenia działają bez nowego kodu.');
  });

  it('połączenie wygasłe razem z kluczem ma stan „wygasłe” i datę klucza', async () => {
    h.db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run('2026-11-01T00:00:00.000Z', apiKeyId);
    usedConnection('Jan Kowalski');
    const body = (await get(`/integracje/${agentId}`)).body;
    expect(body).toContain('wygasłe');
    expect(body).toContain('2026-11-01');
  });

  it('szczegóły integracji innego rodzaju nie zawierają sekcji', async () => {
    const group = h.integrations.insert({
      name: 'SERWIS', kind: 'sms_group', apiKeyId, serviceId: null, orig: null, preset: 'sms-group', enabled: 1,
      config: defaultSmsGroupConfig(), secrets: {}, storePayloads: 0, createdAt: NOW,
    });
    expect((await get(`/integracje/${group}`)).body).not.toContain('id="polaczenia"');
  });
});

describe('nowy kod, nowy token, odwołanie i usunięcie', () => {
  it('nowy kod dla aktywnego połączenia zapisuje agent.nowy_kod', async () => {
    const id = usedConnection('Ewa Nowak');
    const form = await get(`/integracje/${agentId}/polaczenia/${id}/kod`);
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('Ważność kodu');
    expect(form.body).toContain('Dotychczasowe połączenie działa do użycia nowego kodu');
    const res = await post(`/integracje/${agentId}/polaczenia/${id}/kod`, { codeValidity: '1h' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(CODE);
    expect(res.body).toContain('2026-11-15 12:00');
    expect(auditActions()).toContain('agent.nowy_kod');
    expect(h.agentConnections.get(id)!.codeExpiresAt).toBe('2026-11-15T11:00:00.000Z');
  });

  it('nowy token unieważnia poprzedni i zapisuje agent.nowy_token', async () => {
    const created = h.connectionService.create(agentId, { name: 'Serwer n8n', method: 'token', codeValidity: '24h', validity: '90d' }, 'janek', NOW);
    const res = await post(`/integracje/${agentId}/polaczenia/${created.id}/token`);
    expect(res.statusCode).toBe(200);
    const token = res.body.match(TOKEN)![0];
    expect(token).not.toBe(created.secret);
    expect(h.connectionService.authenticate(`Bearer ${created.secret}`, NOW)).toEqual({ ok: false, code: 'invalid' });
    expect(h.connectionService.authenticate(`Bearer ${token}`, NOW)).toEqual({ ok: true, connectionId: created.id });
    expect(auditActions()).toContain('agent.nowy_token');
  });

  it('kod dla połączenia z tokenem i nowy kod odwołanego połączenia: błąd bez zmian', async () => {
    const created = h.connectionService.create(agentId, { name: 'Serwer n8n', method: 'token', codeValidity: '24h', validity: '90d' }, 'janek', NOW);
    expect((await post(`/integracje/${agentId}/polaczenia/${created.id}/kod`, { codeValidity: '1h' })).statusCode).toBe(409);
    const id = usedConnection('Ewa Nowak');
    h.connectionService.revoke(id, NOW);
    const res = await post(`/integracje/${agentId}/polaczenia/${id}/kod`, { codeValidity: '1h' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('Odwołanego połączenia nie można przywrócić');
    expect(res.body).not.toMatch(CODE);
  });

  it('połączenie z innej integracji pod adresem tej integracji: 404', async () => {
    const other = agentIntegration('Agent AI - dyspozytornia');
    const created = h.connectionService.create(other, { name: 'Ewa Nowak', method: 'oauth', codeValidity: '24h', validity: '90d' }, 'janek', NOW);
    expect((await post(`/integracje/${agentId}/polaczenia/${created.id}/kod`, { codeValidity: '1h' })).statusCode).toBe(404);
    expect((await post(`/integracje/${agentId}/polaczenia/${created.id}/odwolaj`)).statusCode).toBe(404);
  });

  it('odwołanie: stan odwołane, tokeny OAuth usunięte', async () => {
    const id = usedConnection('Ewa Nowak');
    const res = await post(`/integracje/${agentId}/polaczenia/${id}/odwolaj`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/integracje/${agentId}#polaczenia`);
    expect(h.agentConnections.get(id)).toMatchObject({ revokedReason: 'admin' });
    expect(h.oauth.getToken(`skrot-tokenu-${id}`)).toBeUndefined();
    const entry = h.audit.list(10, 0).find((e) => e.action === 'agent.odwolanie');
    expect(entry).toMatchObject({ actor: 'janek', target: 'Agent AI - marketing / Ewa Nowak' });
    const body = (await get(`/integracje/${agentId}`)).body;
    expect(body).toContain('Połączenie Ewa Nowak odwołane. Aplikacja utraciła dostęp do bramki.');
    expect(body).toContain('odwołane');
  });

  it('usunięcie połączenia czekającego na kod zapisuje agent.polaczenie_usuniecie', async () => {
    const id = h.connectionService.create(agentId, { name: 'Ewa Nowak', method: 'oauth', codeValidity: '24h', validity: '90d' }, 'janek', NOW).id;
    const res = await post(`/integracje/${agentId}/polaczenia/${id}/usun`);
    expect(res.statusCode).toBe(302);
    expect(h.agentConnections.get(id)).toBeUndefined();
    expect(auditActions()).toContain('agent.polaczenie_usuniecie');
  });

  it('usunięcie aktywnego połączenia: 409 i komunikat', async () => {
    const id = usedConnection('Ewa Nowak');
    const res = await post(`/integracje/${agentId}/polaczenia/${id}/usun`);
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('Połączenie, które było używane, można tylko odwołać.');
    expect(h.agentConnections.get(id)).toBeDefined();
    expect(auditActions()).not.toContain('agent.polaczenie_usuniecie');
  });
});

describe('handoffText', () => {
  it('logowanie: adres, kod, termin kodu i połączenia, odnośnik do artykułu', () => {
    const text = handoffText({ method: 'oauth', mcpUrl: 'https://sms.firma.pl/mcp', secret: 'ABCD-EFGH-JKMN', secretExpiresAt: '2026-11-16T10:00:00.000Z', effectiveExpiry: '2027-02-13T10:00:00.000Z' });
    expect(text).toContain('Adres serwera MCP: https://sms.firma.pl/mcp');
    expect(text).toContain('Kod jednorazowy: ABCD-EFGH-JKMN');
    expect(text).toContain('16.11.2026 11:00');
    expect(text).toContain('13.02.2027');
    expect(text).toContain(AGENTS_DOCS_URL);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it('klucz w nagłówku: nagłówek z tokenem, bez terminu połączenia', () => {
    const text = handoffText({ method: 'token', mcpUrl: 'https://sms.firma.pl/mcp', secret: 'mig_mcp_abc', secretExpiresAt: null, effectiveExpiry: null });
    expect(text).toContain('Authorization: Bearer mig_mcp_abc');
    expect(text).toContain('Połączenie jest ważne bezterminowo.');
    expect(text).not.toContain('Kod jednorazowy');
  });
});
