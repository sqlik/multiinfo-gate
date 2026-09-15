import { describe, expect, it } from 'vitest';
import { enrich, safeUrl } from '../../src/integrations/enrich.ts';
import { TemplateEngine } from '../../src/integrations/templates.ts';

const engine = new TemplateEngine();
const bazowa = {
  url: 'https://przyklad.test/clients/{{ p.deal.client.external_ids.fakturownia }}.json',
  method: 'GET' as const, headers: [], query: [], timeoutMs: 2000, as: 'e', onError: 'error' as const,
};
const kontekst = () => ({
  p: { deal: { client: { external_ids: { fakturownia: 276200905 } } } },
  now: '2026-09-15T10:00:00.000Z', integration: { name: 'proba' },
});
const publiczny = async () => ['93.184.216.34'];

describe('zapytanie uzupełniające', () => {
  it('wstawia ładunek do adresu oraz oddaje odpowiedź', async () => {
    const wywolania: string[] = [];
    const out = await enrich({
      config: bazowa, secrets: {}, context: kontekst(), engine, resolve: publiczny,
      get: async (url) => { wywolania.push(url); return { status: 200, body: '{"phone":"+48601000001"}' }; },
    });
    expect(wywolania[0]).toBe('https://przyklad.test/clients/276200905.json');
    expect(out).toEqual({ ok: true, value: { phone: '+48601000001' } });
  });

  it('wstawia sekret do nagłówka, nie do kontekstu', async () => {
    let naglowki: Record<string, string> = {};
    const context = kontekst();
    await enrich({
      config: { ...bazowa, headers: [{ name: 'Authorization', valueRef: 'apiToken' }] },
      secrets: { apiToken: 'Bearer tajne123' }, context, engine, resolve: publiczny,
      get: async (_url, h) => { naglowki = h; return { status: 200, body: '{}' }; },
    });
    expect(naglowki.Authorization).toBe('Bearer tajne123');
    expect(JSON.stringify(context)).not.toContain('tajne123');
  });

  it('dokłada parametr adresu z sekretu oraz zostawia go poza dziennikiem', async () => {
    let adres = '';
    await enrich({
      config: { ...bazowa, query: [{ name: 'api_token', valueRef: 'apiToken' }] },
      secrets: { apiToken: 'tajne123' }, context: kontekst(), engine, resolve: publiczny,
      get: async (url) => { adres = url; return { status: 200, body: '{}' }; },
    });
    expect(adres).toContain('api_token=tajne123');
    expect(safeUrl(adres)).toBe('https://przyklad.test/clients/276200905.json');
  });

  it('przekazuje metodę oraz czas oczekiwania z ustawienia', async () => {
    let widziane = { method: '', timeoutMs: 0 };
    await enrich({
      config: { ...bazowa, method: 'POST', timeoutMs: 800 }, secrets: {}, context: kontekst(), engine, resolve: publiczny,
      get: async (_url, _h, method, timeoutMs) => { widziane = { method, timeoutMs }; return { status: 200, body: '{}' }; },
    });
    expect(widziane).toEqual({ method: 'POST', timeoutMs: 800 });
  });

  it('odmawia adresu w sieci wewnętrznej', async () => {
    const out = await enrich({
      config: bazowa, secrets: {}, context: kontekst(), engine,
      resolve: async () => ['10.0.0.5'],
      get: async () => { throw new Error('nie powinno dojść do wywołania'); },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('sieć wewnętrzną');
  });

  it('z jawną zgodą pyta pod adres w sieci wewnętrznej', async () => {
    const out = await enrich({
      config: bazowa, secrets: {}, context: kontekst(), engine, allowPrivate: true,
      resolve: async () => ['10.0.0.5'],
      get: async () => ({ status: 200, body: '{"phone":"48601000001"}' }),
    });
    expect(out).toEqual({ ok: true, value: { phone: '48601000001' } });
  });

  it('odmawia adresu, który nie jest http ani https', async () => {
    const out = await enrich({
      config: { ...bazowa, url: 'file:///etc/passwd' }, secrets: {}, context: kontekst(), engine, resolve: publiczny,
      get: async () => { throw new Error('nie powinno dojść do wywołania'); },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('https');
  });

  it('uznaje odpowiedź inną niż JSON za błąd', async () => {
    const out = await enrich({
      config: bazowa, secrets: {}, context: kontekst(), engine, resolve: publiczny,
      get: async () => ({ status: 200, body: '<html>nie ten adres</html>' }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('nie jest JSON-em');
  });

  it('uznaje kod poza 2xx za błąd i nie zdradza treści odpowiedzi', async () => {
    const out = await enrich({
      config: bazowa, secrets: {}, context: kontekst(), engine, resolve: publiczny,
      get: async () => ({ status: 404, body: '{"error":"tajne szczegóły"}' }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('404');
    expect(out.reason).not.toContain('tajne szczegóły');
  });

  it('uznaje przekroczony czas za błąd', async () => {
    const out = await enrich({
      config: bazowa, secrets: {}, context: kontekst(), engine, resolve: publiczny,
      get: async () => { throw new Error('The operation was aborted due to timeout'); },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('timeout');
  });

  it('odrzuca nazwę, która przykrywa ładunek', async () => {
    const out = await enrich({
      config: { ...bazowa, as: 'p' }, secrets: {}, context: kontekst(), engine, resolve: publiczny,
      get: async () => ({ status: 200, body: '{}' }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('nazwa');
  });

  it('błąd składni w adresie oraz pusty adres to błąd dopytania, nie wyjątek', async () => {
    const zly = await enrich({
      config: { ...bazowa, url: 'https://przyklad.test/clients/{{ p.deal' }, secrets: {}, context: kontekst(), engine, resolve: publiczny,
      get: async () => ({ status: 200, body: '{}' }),
    });
    expect(zly.ok).toBe(false);
    if (zly.ok) return;
    expect(zly.reason).toContain('adres zapytania');

    const pusty = await enrich({
      config: { ...bazowa, url: '{{ p.brak }}' }, secrets: {}, context: kontekst(), engine, resolve: publiczny,
      get: async () => ({ status: 200, body: '{}' }),
    });
    expect(pusty.ok).toBe(false);
  });

  it('nazwa bez adresu to błąd dopytania', async () => {
    const out = await enrich({
      config: bazowa, secrets: {}, context: kontekst(), engine,
      resolve: async () => { throw new Error('ENOTFOUND'); },
      get: async () => ({ status: 200, body: '{}' }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('nie rozwiązuje się');
  });

  it('adres do dziennika gubi część zapytania z tokenem, a szablon zostaje czytelny', () => {
    expect(safeUrl('https://firma.fakturownia.pl/clients/5.json?api_token=tajne123')).toBe('https://firma.fakturownia.pl/clients/5.json');
    expect(safeUrl('https://firma.fakturownia.pl/clients/{{ p.id }}.json?api_token=tajne123')).toBe('https://firma.fakturownia.pl/clients/{{ p.id }}.json');
    expect(safeUrl('')).toBe('(adres nie do odczytania)');
  });
});
