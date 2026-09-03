import { beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { hashApiKey } from '../../src/api/keys.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';
import { defaultInboundConfig } from '../../src/integrations/config.ts';

let h: AdminHarness;
let accountId: number;

beforeEach(async () => {
  h = await startAdminHarness();
  accountId = seedAccount(h);
});

const form = (fields: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(fields).toString(),
});

const create = (over: Record<string, string> = {}) =>
  h.app.inject({ url: '/klucze', ...form({
    name: 'Powiadomienia magazyn', accountId: String(accountId),
    serviceIds: '24138', origs: 'Firma Info', maxParts: '5', ratePerMin: '60', noExpiry: '1', ...over,
  }) });

const KEY_PATTERN = /mig_live_[A-Za-z0-9_-]{43}/;

describe('POST /klucze', () => {
  it('pokazuje pełny klucz dokładnie raz, po utworzeniu', async () => {
    const res = await create();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(KEY_PATTERN);
    expect(res.body).toContain('Pokazujemy go wyłącznie teraz');
  });

  it('nie pokazuje pełnego klucza przy kolejnym wejściu na listę', async () => {
    const created = (await create()).body.match(KEY_PATTERN)![0];
    const list = await h.app.inject({ method: 'GET', url: '/klucze', headers: { cookie: h.cookie } });
    expect(list.body).not.toContain(created);
    expect(list.body).toContain(created.slice('mig_live_'.length, 'mig_live_'.length + 8));
  });

  it('zapisuje w bazie wyłącznie skrót', async () => {
    const created = (await create()).body.match(KEY_PATTERN)![0];
    const row = h.db.prepare('SELECT key_hash, key_prefix FROM api_keys ORDER BY id DESC LIMIT 1').get() as {
      key_hash: string; key_prefix: string;
    };
    expect(row.key_hash).not.toBe(created);
    expect(row.key_hash).toBe(hashApiKey(created));
    expect(row.key_prefix).toHaveLength(8);
  });

  it('nie umieszcza klucza w adresie ani w nagłówkach odpowiedzi', async () => {
    const res = await create();
    const created = res.body.match(KEY_PATTERN)![0];
    expect(res.headers.location ?? '').not.toContain(created);
    expect(JSON.stringify(res.headers)).not.toContain(created);
  });

  it('przypisuje klucz do wskazanego konta i usług', async () => {
    await create();
    const key = h.apiKeys.list().at(-1)!;
    expect(key.accountId).toBe(accountId);
    expect(key.allowedServiceIds).toEqual(['24138']);
    expect(key.maxParts).toBe(5);
    expect(key.ratePerMin).toBe(60);
  });

  it('odrzuca usługę spoza uprawnień konta', async () => {
    const res = await create({ serviceIds: '99999' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('99999');
    expect(h.apiKeys.list()).toHaveLength(0);
  });

  it('zapisuje zdarzenie w dzienniku', async () => {
    await create();
    const entries = h.audit.list(10, 0);
    const entry = entries.find((e) => e.action === 'klucz.utworzenie');
    expect(entry).toBeTruthy();
    expect(entry!.actor).toBe('janek');
    expect(JSON.stringify(entry!.meta ?? {})).not.toMatch(KEY_PATTERN);
  });
});

describe('POST /klucze - webhook', () => {
  it('odmawia adresu webhooka w sieci wewnętrznej, dopóki MIG_WEBHOOK_ALLOW_PRIVATE nie jest ustawione', async () => {
    const res = await create({ webhookUrl: 'http://127.0.0.1:9000/webhook.php' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('MIG_WEBHOOK_ALLOW_PRIVATE');
    expect(h.apiKeys.list()).toHaveLength(0);
  });

  it('odmawia nazwy rozwiązującej się na adres wewnętrzny', async () => {
    h.resolve.value = async () => ['192.168.1.20'];
    const res = await create({ webhookUrl: 'https://crm.example/hook' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('sieć wewnętrzną');
    expect(res.body).toContain('192.168.1.20');
  });

  it('odmawia nazwy, której nie da się rozwiązać', async () => {
    h.resolve.value = async () => { throw new Error('ENOTFOUND'); };
    const res = await create({ webhookUrl: 'https://nie.ma.example/hook' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('nie rozwiązuje się');
  });

  it('z MIG_WEBHOOK_ALLOW_PRIVATE przyjmuje adres wewnętrzny', async () => {
    h = await startAdminHarness(undefined, { allowPrivateWebhooks: true });
    accountId = seedAccount(h);
    const res = await create({ webhookUrl: 'http://172.18.0.1:9000/webhook.php' });
    expect(res.statusCode).toBe(200);
    expect(h.apiKeys.list()[0]!.webhookUrl).toBe('http://172.18.0.1:9000/webhook.php');
  });

  it('generuje sekret webhooka razem z kluczem i pokazuje go raz', async () => {
    const res = await create({ webhookUrl: 'https://crm.example/hook' });
    expect(res.statusCode).toBe(200);
    const key = h.apiKeys.list()[0]!;
    expect(key.webhookUrl).toBe('https://crm.example/hook');
    const secret = h.apiKeys.webhookSecret(key.id)!;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body).toContain(secret);
    expect(res.body).toContain('X-MIG-Signature');
    const list = await h.app.inject({ method: 'GET', url: '/klucze', headers: { cookie: h.cookie } });
    expect(list.body).not.toContain(secret);
    expect(list.body).toContain('crm.example');
  });

  it('bez adresu nie tworzy sekretu', async () => {
    const res = await create({ webhookUrl: '' });
    expect(res.statusCode).toBe(200);
    expect(h.apiKeys.webhookSecret(h.apiKeys.list()[0]!.id)).toBeNull();
    expect(res.body).not.toContain('Sekret webhooka');
  });

  it('odrzuca adres webhooka bez http(s)', async () => {
    const res = await create({ webhookUrl: 'ftp://x' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('https://');
    expect(h.apiKeys.list()).toHaveLength(0);
  });
});

describe('edycja klucza', () => {
  const edit = (id: number, over: Record<string, string> = {}) =>
    h.app.inject({ url: `/klucze/${id}/edytuj`, ...form({
      name: 'Powiadomienia magazyn', serviceIds: '24138', defaultServiceId: '24138',
      origs: 'Firma Info', defaultOrig: '', maxParts: '5', ratePerMin: '60', webhookUrl: '',
      webhookSecret: '', expiresOn: '', noExpiry: '1', ...over,
    }) });

  it('pokazuje formularz z wartościami klucza', async () => {
    await create();
    const key = h.apiKeys.list()[0]!;
    const res = await h.app.inject({ method: 'GET', url: `/klucze/${key.id}/edytuj`, headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="Powiadomienia magazyn"');
    expect(res.body).toContain('Nie wygasa (nie rekomendowane)');
    expect(res.body).toContain('type="date"');
  });

  it('zapisuje zmienione pola i pokazuje komunikat', async () => {
    await create();
    const key = h.apiKeys.list()[0]!;
    const res = await edit(key.id, { name: 'Magazyn v2', maxParts: '3', ratePerMin: '10', expiresOn: '2026-09-30', noExpiry: '' });
    expect(res.statusCode).toBe(302);
    const row = h.apiKeys.get(key.id)!;
    expect(row.name).toBe('Magazyn v2');
    expect(row.maxParts).toBe(3);
    expect(row.expiresAt).toBe('2026-09-30T22:00:00.000Z');
    const list = await h.app.inject({ method: 'GET', url: '/klucze', headers: { cookie: h.cookie } });
    expect(list.body).toContain('Klucz Magazyn v2 zapisany.');
    expect(list.body).toContain('2026-09-30');
    const entry = h.audit.list(1, 0)[0]!;
    expect(entry.action).toBe('klucz.edycja');
    expect(entry.meta?.pola).toEqual(expect.arrayContaining(['name', 'maxParts', 'ratePerMin', 'expiresAt']));
  });

  it('wymaga daty albo zaznaczenia „Nie wygasa”', async () => {
    await create();
    const key = h.apiKeys.list()[0]!;
    const res = await edit(key.id, { expiresOn: '', noExpiry: '' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Podaj datę ważności albo zaznacz „Nie wygasa”');
  });

  it('odrzuca datę z przeszłości', async () => {
    await create();
    const key = h.apiKeys.list()[0]!;
    const res = await edit(key.id, { expiresOn: '2026-08-24', noExpiry: '' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Data ważności nie może być w przeszłości.');
  });

  it('dzisiejsza data jest dozwolona - klucz działa do końca dnia', async () => {
    await create();
    const key = h.apiKeys.list()[0]!;
    const res = await edit(key.id, { expiresOn: '2026-08-25', noExpiry: '' });
    expect(res.statusCode).toBe(302);
    expect(h.apiKeys.get(key.id)!.expiresAt).toBe('2026-08-25T22:00:00.000Z');
  });

  it('nowy adres webhooka bez sekretu wydaje nowy sekret i pokazuje go raz', async () => {
    await create({ webhookUrl: 'https://crm.example/hook' });
    const key = h.apiKeys.list()[0]!;
    const before = h.apiKeys.webhookSecret(key.id);
    const res = await edit(key.id, { webhookUrl: 'https://crm.example/v2' });
    expect(res.statusCode).toBe(200);
    const after = h.apiKeys.webhookSecret(key.id)!;
    expect(after).not.toBe(before);
    expect(res.body).toContain(after);
    expect(h.apiKeys.get(key.id)!.webhookUrl).toBe('https://crm.example/v2');
    const entry = h.audit.list(1, 0)[0]!;
    expect(entry.action).toBe('klucz.edycja');
    expect(JSON.stringify(entry.meta)).not.toContain(after);
  });

  it('ten sam adres webhooka bez sekretu zostawia stary sekret', async () => {
    await create({ webhookUrl: 'https://crm.example/hook' });
    const key = h.apiKeys.list()[0]!;
    const before = h.apiKeys.webhookSecret(key.id);
    const res = await edit(key.id, { webhookUrl: 'https://crm.example/hook' });
    expect(res.statusCode).toBe(302);
    expect(h.apiKeys.webhookSecret(key.id)).toBe(before);
  });

  it('pusty adres wyłącza webhook i kasuje sekret', async () => {
    await create({ webhookUrl: 'https://crm.example/hook' });
    const key = h.apiKeys.list()[0]!;
    await edit(key.id, { webhookUrl: '' });
    expect(h.apiKeys.get(key.id)!.webhookUrl).toBeNull();
    expect(h.apiKeys.webhookSecret(key.id)).toBeNull();
  });

  it('odrzuca zły adres i nie rusza sekretu', async () => {
    await create({ webhookUrl: 'https://crm.example/hook' });
    const key = h.apiKeys.list()[0]!;
    const before = h.apiKeys.webhookSecret(key.id);
    const res = await edit(key.id, { webhookUrl: 'mailto:x' });
    expect(res.statusCode).toBe(400);
    expect(h.apiKeys.webhookSecret(key.id)).toBe(before);
  });

  it('odrzuca domyślne ID usługi spoza zaznaczonych', async () => {
    await create();
    const key = h.apiKeys.list()[0]!;
    const res = await edit(key.id, { serviceIds: '24138', defaultServiceId: '99999' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Domyślne ID usługi musi być jednym z zaznaczonych.');
  });

  it('klucz odwołany nie ma edycji', async () => {
    await create();
    const key = h.apiKeys.list()[0]!;
    h.apiKeys.revoke(key.id);
    const res = await h.app.inject({ method: 'GET', url: `/klucze/${key.id}/edytuj`, headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('nie edytuje klucza, którego nie ma', async () => {
    const res = await edit(999);
    expect(res.statusCode).toBe(404);
  });

  it('lista pokazuje kolumnę Ważny do, ostrzega tydzień przed i oznacza wygasły', async () => {
    await create({ name: 'Wkrótce', expiresOn: '2026-08-30', noExpiry: '' });
    await create({ name: 'Stary', expiresOn: '2026-09-01', noExpiry: '' });
    const stary = h.apiKeys.list().find((k) => k.name === 'Stary')!;
    // Walidacja nie wpuści daty z przeszłości, więc wygaśnięcie symulujemy w bazie.
    h.db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run('2026-08-24T22:00:00.000Z', stary.id);
    const res = await h.app.inject({ method: 'GET', url: '/klucze', headers: { cookie: h.cookie } });
    expect(res.body).toContain('Ważny do');
    expect(res.body).toMatch(/class="m wait">2026-08-30/);
    expect(res.body).toContain('<span class="tag">wygasł</span>');
    expect(res.body).toContain(`/klucze/${stary.id}/edytuj`);
  });
});

describe('GET /klucze - zakładki', () => {
  it('domyślnie pokazuje tylko czynne klucze, odwołane pod zakładką', async () => {
    await create({ name: 'Czynny' });
    await create({ name: 'Wycofany' });
    const wycofany = h.apiKeys.list().find((k) => k.name === 'Wycofany')!;
    h.apiKeys.revoke(wycofany.id);

    const active = await h.app.inject({ method: 'GET', url: '/klucze', headers: { cookie: h.cookie } });
    expect(active.body).toContain('<strong>Czynny</strong>');
    expect(active.body).not.toContain('<strong>Wycofany</strong>');
    expect(active.body).toContain('Odwołane (1)');
    expect(active.body).toContain('1 · 1 konta');

    const revoked = await h.app.inject({ method: 'GET', url: '/klucze?status=odwolane', headers: { cookie: h.cookie } });
    expect(revoked.body).toContain('<strong>Wycofany</strong>');
    expect(revoked.body).not.toContain('<strong>Czynny</strong>');
    expect(revoked.body).toContain('<span class="tag">odwołany</span>');
  });

  it('pusta zakładka mówi, że nie ma kluczy', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/klucze?status=odwolane', headers: { cookie: h.cookie } });
    expect(res.body).toContain('Brak odwołanych kluczy.');
  });
});

describe('POST /klucze - nadpisy', () => {
  it('przypisuje kluczowi zaznaczone nadpisy', async () => {
    h.accounts.setOrigs(accountId, [
      { orig: 'Firma Info', label: null }, { orig: 'Firma Alert', label: null },
    ]);
    await create({ origs: 'Firma Alert' });
    expect(h.apiKeys.list().at(-1)!.allowedOrigs).toEqual(['Firma Alert']);
  });

  it('odrzuca nadpis spoza słownika konta', async () => {
    const res = await create({ origs: 'Inna Firma' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Inna Firma');
    expect(h.apiKeys.list()).toHaveLength(0);
  });

  it('pozwala utworzyć klucz bez żadnego nadpisu', async () => {
    const res = await create({ origs: '' });
    expect(res.statusCode).toBe(200);
    expect(h.apiKeys.list().at(-1)!.allowedOrigs).toEqual([]);
  });

  it('pokazuje na formularzu wyłącznie nadpisy wybranego konta', async () => {
    const inne = seedAccount(h, { name: 'Windykacja', login: 'firma_wind', origs: ['Firma Wind'] });
    const res = await h.app.inject({ method: 'GET', url: `/klucze/nowy?accountId=${inne}`, headers: { cookie: h.cookie } });
    expect(res.body).toContain('Firma Wind');
    expect(res.body).not.toContain('Firma Info');
  });
});

describe('POST /klucze/:id/odwolaj', () => {
  it('oznacza klucz jako odwołany', async () => {
    await create();
    const id = h.apiKeys.list().at(-1)!.id;
    const res = await h.app.inject({ url: `/klucze/${id}/odwolaj`, ...form({}) });
    expect(res.statusCode).toBe(302);
    expect(h.apiKeys.list().find((k) => k.id === id)!.revokedAt).not.toBeNull();
  });

  it('po odwołaniu pokazuje komunikat raz, na liście kluczy', async () => {
    await create();
    const key = h.apiKeys.list()[0]!;
    const res = await h.app.inject({ url: `/klucze/${key.id}/odwolaj`, ...form({}) });
    expect(res.statusCode).toBe(302);
    const list = await h.app.inject({ method: 'GET', url: '/klucze', headers: { cookie: h.cookie } });
    expect(list.body).toContain('class="flash flash-ok"');
    expect(list.body).toContain(`Klucz ${key.name} odwołany. Żądania z tym kluczem dostają od teraz 401.`);
    const again = await h.app.inject({ method: 'GET', url: '/klucze', headers: { cookie: h.cookie } });
    expect(again.body).not.toContain('class="flash');
  });

  it('sprawia, że klucz przestaje działać w publicznym API', async () => {
    const created = (await create()).body.match(KEY_PATTERN)![0];
    const api = buildApiServer({
      accounts: h.accounts, apiKeys: h.apiKeys, messages: h.messages, jobs: h.jobs,
      events: new MessageEventsRepo(h.db), packages: new PackagesRepo(h.db), clients: {} as never,
      inbound: new InboundMessagesRepo(h.db), rateLimiter: new RateLimiter(), ...integrationDeps(h.db, h.masterKey),
    });
    await api.ready();

    const before = await api.inject({
      method: 'POST', url: '/v1/messages',
      headers: { authorization: `Bearer ${created}` },
      payload: { to: '48601135134', text: 'x', serviceId: '24138' },
    });
    expect(before.statusCode).toBe(202);

    const id = h.apiKeys.list().at(-1)!.id;
    await h.app.inject({ url: `/klucze/${id}/odwolaj`, ...form({}) });

    const after = await api.inject({
      method: 'POST', url: '/v1/messages',
      headers: { authorization: `Bearer ${created}` },
      payload: { to: '48601135134', text: 'x', serviceId: '24138' },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('revoked_api_key');
  });

  it('zapisuje zdarzenie w dzienniku', async () => {
    await create();
    const id = h.apiKeys.list().at(-1)!.id;
    await h.app.inject({ url: `/klucze/${id}/odwolaj`, ...form({}) });
    expect(h.audit.list(10, 0).some((e) => e.action === 'klucz.odwolanie')).toBe(true);
  });

  it('odrzuca odwołanie bez sesji', async () => {
    await create();
    const id = h.apiKeys.list().at(-1)!.id;
    const res = await h.app.inject({ method: 'POST', url: `/klucze/${id}/odwolaj`, payload: '' });
    expect(res.headers.location).toBe('/zaloguj');
    expect(h.apiKeys.list().find((k) => k.id === id)!.revokedAt).toBeNull();
  });
});

describe('GET /klucze/nowy - teksty', () => {
  it('mówi o ID usług i limicie części ludzkim językiem', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/klucze/nowy?accountId=${accountId}`, headers: { cookie: h.cookie } });
    expect(res.body).toContain('ID usług');
    expect(res.body).toContain('Limit części jednej wiadomości (1-9)');
    expect(res.body).toContain('Dłuższa treść zostanie odrzucona, nie przycięta');
    expect(res.body).toContain('Gdy w żądaniu nie pojawi się żadna ze zdefiniowanych pozycji');
    expect(res.body).not.toContain('Najwięcej części');
  });
});

describe('klucz - subskrypcja wiadomości przychodzących', () => {
  it('pole jest w formularzu i domyślnie odznaczone', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/klucze/nowy?accountId=${accountId}`, headers: { cookie: h.cookie } });
    expect(res.body).toContain('name="inboundSubscribed"');
    expect(res.body).not.toMatch(/name="inboundSubscribed"[^>]*checked/);
  });

  it('zapisuje subskrypcję przy kluczu z webhookiem i odświeża odbiornik', async () => {
    const res = await create({ webhookUrl: 'https://crm.example/hook', inboundSubscribed: '1' });
    expect(res.statusCode).toBe(200);
    const key = h.apiKeys.list()[0]!;
    expect(key.inboundSubscribed).toBe(1);
    expect(h.refreshed).toEqual([{ retryAccount: accountId }]);
    expect(h.audit.list(10, 0)[0]!.meta).toMatchObject({ odbior: true });
  });

  it('odrzuca subskrypcję bez adresu webhooka', async () => {
    const res = await create({ inboundSubscribed: '1' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('wymaga adresu webhooka');
    expect(h.apiKeys.list()).toHaveLength(0);
  });

  it('edycja zmienia subskrypcję i odnotowuje pole w dzienniku', async () => {
    await create({ webhookUrl: 'https://crm.example/hook' });
    const key = h.apiKeys.list()[0]!;
    const res = await h.app.inject({ url: `/klucze/${key.id}/edytuj`, ...form({
      name: key.name, serviceIds: '24138', defaultServiceId: '24138', origs: 'Firma Info', maxParts: '5', ratePerMin: '60',
      webhookUrl: 'https://crm.example/hook', noExpiry: '1', inboundSubscribed: '1',
    }) });
    expect(res.statusCode).toBe(302);
    expect(h.apiKeys.get(key.id)!.inboundSubscribed).toBe(1);
    expect(h.audit.list(10, 0)[0]!.meta).toMatchObject({ pola: expect.arrayContaining(['inboundSubscribed']) });
    expect(h.refreshed.length).toBeGreaterThanOrEqual(2);
  });

  it('formularz edycji pokazuje zaznaczone pole dla subskrybującego klucza', async () => {
    await create({ webhookUrl: 'https://crm.example/hook', inboundSubscribed: '1' });
    const key = h.apiKeys.list()[0]!;
    const res = await h.app.inject({ method: 'GET', url: `/klucze/${key.id}/edytuj`, headers: { cookie: h.cookie } });
    expect(res.body).toMatch(/name="inboundSubscribed"[^>]*checked/);
  });

  it('odwołanie klucza odświeża odbiornik', async () => {
    await create({ webhookUrl: 'https://crm.example/hook', inboundSubscribed: '1' });
    const key = h.apiKeys.list()[0]!;
    await h.app.inject({ url: `/klucze/${key.id}/odwolaj`, ...form({}) });
    expect(h.refreshed.length).toBeGreaterThanOrEqual(2);
  });

  it('lista pokazuje, który klucz odbiera', async () => {
    await create({ webhookUrl: 'https://crm.example/hook', inboundSubscribed: '1' });
    const res = await h.app.inject({ method: 'GET', url: '/klucze', headers: { cookie: h.cookie } });
    expect(res.body).toContain('<span class="tag">odbiera</span>');
  });
});

describe('klucz z integracjami', () => {
  const seedIntegration = (apiKeyId: number, enabled: 0 | 1) => h.integrations.insert({
    name: 'Kuma', kind: 'webhook_in', apiKeyId, serviceId: null, orig: null, preset: 'uptime-kuma', enabled,
    config: defaultInboundConfig(), secrets: {}, storePayloads: 0, createdAt: new Date('2026-08-25T10:00:00Z'),
  });

  it('edycja klucza pokazuje listę integracji klucza', async () => {
    await create();
    const key = h.apiKeys.list()[0]!;
    const id = seedIntegration(key.id, 1);
    const res = await h.app.inject({ method: 'GET', url: `/klucze/${key.id}/edytuj`, headers: { cookie: h.cookie } });
    expect(res.body).toContain(`href="/integracje/${id}">Kuma</a>`);
  });

  it('odwołanie klucza z włączoną integracją jest zablokowane z komunikatem', async () => {
    await create();
    const key = h.apiKeys.list()[0]!;
    const id = seedIntegration(key.id, 1);
    const res = await h.app.inject({ url: `/klucze/${key.id}/odwolaj`, ...form({}) });
    expect(res.statusCode).toBe(302);
    expect(h.apiKeys.get(key.id)!.revokedAt).toBeNull();
    const list = await h.app.inject({ method: 'GET', url: '/klucze', headers: { cookie: h.cookie } });
    expect(list.body).toContain('najpierw wyłącz albo przepnij');
    expect(h.audit.list(10, 0).some((e) => e.action === 'klucz.odwolanie')).toBe(false);

    h.integrations.setEnabled(id, false, new Date());
    await h.app.inject({ url: `/klucze/${key.id}/odwolaj`, ...form({}) });
    expect(h.apiKeys.get(key.id)!.revokedAt).not.toBeNull();
  });
});
