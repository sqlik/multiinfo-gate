import { beforeEach, describe, expect, it } from 'vitest';
import { seedAccount, startAdminHarness, type AdminHarness } from '../helpers/admin-app.ts';
import { messageInput } from '../store/helpers.ts';
import { FOLDER, SPRING, SPRING_PACKAGE, dest, seedSpringCampaign } from '../links/campaign-fixture.ts';

const START = new Date('2026-11-05T10:00:00Z');
const NOW = new Date('2026-11-08T10:00:00Z');

let h: AdminHarness;
let apiKeyId: number;
let accountId: number;

beforeEach(async () => {
  h = await startAdminHarness(NOW);
  accountId = seedAccount(h);
  apiKeyId = h.apiKeys.insert({
    accountId, name: 'Biuro handlowe - kampanie', keyHash: 'h', keyPrefix: 'p', defaultServiceId: '24138', defaultOrig: null,
    maxParts: 3, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'],
  });
  h.linkDomains.create({ domain: 'l.firma.pl', displayName: 'Firma Serwis', homeUrl: null, bareLinks: false }, START);
});

const page = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
const post = (url: string) => h.app.inject({
  method: 'POST', url, headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: '',
});
const seed = () => seedSpringCampaign(h.db, { apiKeyId, accountId, domain: 'l.firma.pl', start: START });
const actions = () => (h.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'kampania.%' ORDER BY id").all() as Array<{ action: string }>)
  .map((r) => r.action);

/** Panel używa wyłącznie łącznika i zapisu „na przykład”. */
const plainText = (html: string) => {
  expect(html).not.toMatch(/[\u2013\u2014]/);
  expect(html).not.toMatch(/\bnp\./);
};

describe('Kampanie: menu i lista', () => {
  it('pozycja „Kampanie” w grupie Ruch, po Rozsyłkach, bez licznika', async () => {
    const res = await page('/kampanie');
    expect(res.statusCode).toBe(200);
    const nav = res.body.slice(res.body.indexOf('>Ruch<'), res.body.indexOf('>Konfiguracja<'));
    expect(nav).toContain('<a href="/kampanie" class="on">Kampanie</a>');
    expect(nav.indexOf('Kampanie')).toBeGreaterThan(nav.indexOf('Rozsyłki'));
    expect(nav.indexOf('Kampanie')).toBeLessThan(nav.indexOf('Odebrane'));
  });

  it('pusta lista wyjaśnia, skąd biorą się kampanie', async () => {
    const res = await page('/kampanie');
    expect(res.body).toContain('Brak kampanii');
    plainText(res.body);
  });

  it('wiersz kampanii: nazwa, klucz, okres, wysłane, otwarcia i kliknięcia', async () => {
    const { campaignId } = seed();
    const res = await page('/kampanie');
    expect(res.body).toContain(`<a href="/kampanie/${campaignId}">${SPRING}</a>`);
    expect(res.body).toContain('Biuro handlowe - kampanie');
    expect(res.body).toContain('2026-11-05 11:00');
    expect(res.body).toContain('1 240');
    expect(res.body).toContain('>312<');
    expect(res.body).toContain('>455<');
    plainText(res.body);
  });

  it('stronicowanie jak na liście rozsyłek', async () => {
    for (let i = 0; i < 27; i++) h.campaigns.open(apiKeyId, `kampania-${i}`, new Date(START.getTime() + i * 60_000));
    const first = await page('/kampanie');
    expect(first.body).toContain('href="/kampanie?offset=25"');
    expect(first.body).toContain('kampania-26');
    const second = await page('/kampanie?offset=25');
    expect(second.body).toContain('kampania-0');
    expect(second.body).not.toContain('kampania-26');
  });
});

describe('Kampanie: szczegóły', () => {
  it('nagłówek, kafelki, wykres, linki, analityka i odbiorcy według makiety', async () => {
    const { campaignId } = seed();
    const res = await page(`/kampanie/${campaignId}`);
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain(`<h1 class="h1">${SPRING}</h1>`);
    expect(body).toContain('klucz „Biuro handlowe - kampanie”');
    expect(body).toContain('1 rozsyłka');
    // Kafelki
    expect(body).toContain('>Wysłane<');
    expect(body).toContain('1 204');
    expect(body).toContain('97,1 % wysłanych');
    expect(body).toContain('25,9 % doręczonych');
    expect(body).toContain('1,46 na otwarcie');
    expect(body).toContain('>41<');
    // Wykres bez skryptu i przełącznik widoku dla kampanii dłuższej niż 48 godzin
    expect(body).toContain('<svg');
    expect(body).toContain(`href="/kampanie/${campaignId}?widok=dzien"`);
    // Linki
    expect(body).toContain(FOLDER);
    expect(body).toContain('https://firma.pl/oferta/{…}');
    expect(body).toContain('wspólny');
    expect(body).toContain('indywidualny');
    // Analityka
    expect(body).toContain('utm_campaign');
    expect(body).toContain('l.firma.pl');
    expect(body).toContain('2027-02-03');
    // Odbiorcy
    expect(body).toContain('pierwszych 50 z 312 - pełna lista w CSV');
    expect(body.match(/<tr class="opener">/g)).toHaveLength(50);
    expect(body).toContain(`href="/kampanie/${campaignId}/odbiorcy.csv"`);
    plainText(body);
  });

  it('plakietki linków odbiorcy w kolejności tabeli „Linki”, z odnośnikiem do adresu docelowego w nowej karcie', async () => {
    const { campaignId } = seed();
    const body = (await page(`/kampanie/${campaignId}`)).body;
    const row = body.slice(body.indexOf(`<td class="m">${dest(185)}</td>`));
    const cells = row.slice(0, row.indexOf('</tr>'));
    const tag = (url: string, label: string) =>
      `<a class="tag" href="${url}" title="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    expect(cells).toContain(`${tag(FOLDER, 'link 1')} ${tag('https://firma.pl/oferta/KL-10185', 'link 2')}`);
  });

  it('tabela „Linki”: link wspólny klikalny, wzorzec linków indywidualnych bez odnośnika', async () => {
    const { campaignId } = seed();
    const body = (await page(`/kampanie/${campaignId}`)).body;
    expect(body).toContain(`<td class="m url"><a href="${FOLDER}" target="_blank" rel="noopener noreferrer">${FOLDER}</a></td>`);
    expect(body).toContain('<td class="m url">https://firma.pl/oferta/{…}</td>');
  });

  it('widok dzienny wykresu', async () => {
    const { campaignId } = seed();
    const res = await page(`/kampanie/${campaignId}?widok=dzien`);
    expect(res.body).toContain('Kliknięcia dziennie');
    expect(res.body).toContain(`href="/kampanie/${campaignId}"`);
  });

  it('kampania bez raportu doręczenia: „brak raportu” i procent otwarć od wysłanych', async () => {
    const id = h.campaigns.open(apiKeyId, 'cennik-zima', START);
    h.packages.insert({
      id: 'pkg_bez_raportu', apiKeyId, accountId, serviceId: '24138', defaultText: 'a', orig: null, costCenter: null, startAt: null,
      deliveryReport: 0, encoding: 'gsm', multipart: 0, createdAt: START.toISOString(), campaignId: id,
    }, [{ dest: '48601000001', text: null, clientId: null, links: 1 }, { dest: '48601000002', text: null, clientId: null, links: 1 }]);
    h.campaigns.addSent(id, 2);
    h.db.prepare('UPDATE campaigns SET opens = 1, clicks = 1 WHERE id = ?').run(id);
    const res = await page(`/kampanie/${id}`);
    expect(res.body).toContain('brak raportu');
    expect(res.body).toContain('50,0 % wysłanych');
  });

  it('nieznana kampania daje 404', async () => {
    expect((await page('/kampanie/999')).statusCode).toBe(404);
    expect((await page('/kampanie/abc')).statusCode).toBe(404);
  });

  it('kampania po retencji: liczby, wykres i linki ze zdaniem o usunięciu szczegółów odbiorców', async () => {
    const { campaignId } = seed();
    h.shortLinks.purge(new Date(START.getTime() + 200 * 86_400_000));
    h.campaigns.setDetailsPurged(campaignId, NOW);
    const res = await page(`/kampanie/${campaignId}`);
    expect(res.body).toContain('Szczegóły odbiorców zostały usunięte po okresie przechowywania');
    expect(res.body).not.toMatch(/retencj/i);
    expect(res.body).toContain('1 240');
    expect(res.body).toContain('<svg');
    expect(res.body).toContain(FOLDER);
    expect(res.body).not.toContain('<tr class="opener">');
    expect(res.body).not.toContain('/odbiorcy.csv');
    expect(res.body).not.toContain('Wyłącz linki');
    plainText(res.body);
  });
});

describe('Kampanie: CSV odbiorców', () => {
  it('pełna lista odbiorców z otwarciem do pobrania', async () => {
    const { campaignId } = seed();
    const res = await page(`/kampanie/${campaignId}/odbiorcy.csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${SPRING}-odbiorcy.csv"`);
    expect(res.body.trimEnd().split('\r\n')).toHaveLength(313);
    expect(res.body).toContain(`${dest(200)};KL-10200;`);
    // Excel z polskimi ustawieniami rozpoznaje UTF-8 wyłącznie po znaczniku BOM na początku pliku.
    expect(res.body.startsWith('\uFEFFnumer;')).toBe(true);
  });

  it('nazwa pliku bez znaków spoza ASCII i bez cudzysłowów', async () => {
    const id = h.campaigns.open(apiKeyId, 'Przegląd "wiosna"/2027', START);
    const res = await page(`/kampanie/${id}/odbiorcy.csv`);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="kampania-${id}-odbiorcy.csv"`);
  });
});

describe('Kampanie: wyłączenie i włączenie linków', () => {
  it('„Wyłącz linki” z potwierdzeniem, potem „Włącz linki”, z wpisami w dzienniku', async () => {
    const { campaignId } = seed();
    const before = await page(`/kampanie/${campaignId}`);
    expect(before.body).toContain(`action="/kampanie/${campaignId}/wylacz"`);
    expect(before.body).toMatch(/data-confirm="Wyłączyć linki kampanii [^"]+"/);
    expect(before.body).toContain('także w wysłanych SMS-ach i w kolejnych wysyłkach tej kampanii');

    const off = await post(`/kampanie/${campaignId}/wylacz`);
    expect(off.statusCode).toBe(303);
    expect(off.headers.location).toBe(`/kampanie/${campaignId}`);
    expect(h.shortLinks.get('f000001')!.disabledAt).toBe(NOW.toISOString());
    const after = await page(`/kampanie/${campaignId}`);
    expect(after.body).toContain(`action="/kampanie/${campaignId}/wlacz"`);
    expect(after.body).toContain('Włącz linki');
    expect(after.body).toContain('linki wyłączone');

    await post(`/kampanie/${campaignId}/wlacz`);
    expect(h.shortLinks.get('f000001')!.disabledAt).toBeNull();
    expect(actions()).toEqual(['kampania.linki_wylaczone', 'kampania.linki_wlaczone']);
  });

  it('nieznana kampania daje 404', async () => {
    expect((await post('/kampanie/999/wylacz')).statusCode).toBe(404);
  });
});

describe('Stronicowanie list panelu', () => {
  it('przesunięcie spoza zakresu liczb całkowitych daje pustą stronę, a nie błąd 500', async () => {
    seed();
    for (const path of ['/kampanie', '/wiadomosci', '/rozsylki', '/dziennik']) {
      const res = await page(`${path}?offset=99999999999999999999`);
      expect(res.statusCode, path).toBe(200);
    }
  });
});

describe('Kampania w szczegółach rozsyłki i wiadomości', () => {
  it('rozsyłka: wiersz „Kampania” z odnośnikiem', async () => {
    const { campaignId } = seed();
    const res = await page(`/rozsylki/${SPRING_PACKAGE}`);
    expect(res.body).toContain(`<div>Kampania</div><div><a href="/kampanie/${campaignId}">${SPRING}</a></div>`);
  });

  it('rozsyłka: tabela odbiorców pokazuje liczbę kliknięć każdego odbiorcy', async () => {
    seed();
    const clicks = (seq: number) => (h.db.prepare('SELECT SUM(clicks) AS n FROM short_links WHERE package_id = ? AND seq = ?')
      .get(SPRING_PACKAGE, seq) as { n: number }).n;
    const res = await page(`/rozsylki/${SPRING_PACKAGE}`);
    const table = res.body.slice(res.body.indexOf('<div class="lab">Odbiorcy</div>'));
    expect(table).toContain('<th style="width: 90px;">Kliknięcia</th>');
    const row = (seq: number) => table.slice(table.indexOf(`>${dest(seq)}<`), table.indexOf('</tr>', table.indexOf(`>${dest(seq)}<`)));
    for (const seq of [1, 2]) expect(row(seq)).toContain(`<td class="m">${clicks(seq)}</td>`);
  });

  it('wiadomość: kampania, liczba kliknięć i pierwsze otwarcie', async () => {
    const id = h.campaigns.open(apiKeyId, SPRING, START);
    h.messages.insert(messageInput({ id: 'msg_1', apiKeyId, accountId, campaignId: id }));
    const domainId = h.linkDomains.byDomain('l.firma.pl')!.id;
    h.shortLinks.insert({
      code: 'aB3xK9q', domainId, apiKeyId, campaignId: id, target: FOLDER, utm: 1, recipientKey: 'msg_1', messageId: 'msg_1',
      packageId: null, seq: null, dest: '48601000001', clientId: null, expiresAt: '2027-02-03T10:00:00.000Z',
      purgeAfter: '2027-03-05T10:00:00.000Z', createdAt: START.toISOString(),
    });
    h.shortLinks.click('aB3xK9q', new Date('2026-11-05T10:05:00Z'), false);
    h.shortLinks.click('aB3xK9q', new Date('2026-11-05T12:00:00Z'), false);
    const res = await page('/wiadomosci/msg_1');
    expect(res.body).toContain(`<div>Kampania</div><div><a href="/kampanie/${id}">${SPRING}</a></div>`);
    expect(res.body).toContain('<div>Kliknięcia</div><div class="m">2</div>');
    expect(res.body).toContain('<div>Pierwsze otwarcie</div><div class="m">2026-11-05 11:05:00</div>');
  });

  it('wiadomość kampanii po usunięciu kodów podaje okres przechowywania zamiast liczby kliknięć', async () => {
    const id = h.campaigns.open(apiKeyId, SPRING, START);
    h.messages.insert(messageInput({ id: 'msg_3', apiKeyId, accountId, campaignId: id }));
    const res = await page('/wiadomosci/msg_3');
    expect(res.body).toContain('<div>Kliknięcia</div><div class="dim">szczegóły usunięte po okresie przechowywania</div>');
    expect(res.body).not.toMatch(/retencj/i);
  });

  it('wiadomość bez kampanii nie ma tych wierszy', async () => {
    h.messages.insert(messageInput({ id: 'msg_2', apiKeyId, accountId }));
    const res = await page('/wiadomosci/msg_2');
    expect(res.body).not.toContain('<div>Kampania</div>');
  });
});
