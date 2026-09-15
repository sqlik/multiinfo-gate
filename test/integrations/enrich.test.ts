import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { enrich, httpGet, READ_LIMIT, safeUrl } from '../../src/integrations/enrich.ts';
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

describe('adres zapytania zostaje tam, gdzie go wpisano', () => {
  const zapytaj = async (url: string, p: unknown) => {
    const wywolania: string[] = [];
    const out = await enrich({
      config: { ...bazowa, url, query: [{ name: 'api_token', valueRef: 'token' }] },
      secrets: { token: 'TOKEN-ADMINA' }, context: { p, now: '', integration: { name: 'proba' } },
      engine, resolve: publiczny,
      get: async (adres) => { wywolania.push(adres); return { status: 200, body: '{"ok":1}' }; },
    });
    return { out, wywolania };
  };

  it('odmawia, gdy wyrażenie siedzi w nazwie serwera', async () => {
    // Inaczej wartość z ładunku przestawia żądanie na obcy serwer, a bramka dokleja do niego
    // kod autoryzacyjny API administratora.
    const { out, wywolania } = await zapytaj('https://{{ p.account }}.aplikacja.example/v1/x', { account: 'napastnik.example/?' });
    expect(out.ok).toBe(false);
    expect(wywolania).toHaveLength(0);
  });

  it('odmawia, gdy wartość z ładunku wyprowadza ścieżkę poza wpisaną', async () => {
    const { out, wywolania } = await zapytaj('https://konto.fakturownia.pl/clients/{{ p.id }}.json', { id: '1/../../invoices' });
    expect(out.ok).toBe(false);
    expect(wywolania).toHaveLength(0);
  });

  it('zwykłe uzupełnienie ścieżki przechodzi', async () => {
    const { out, wywolania } = await zapytaj('https://konto.fakturownia.pl/clients/{{ p.id }}.json', { id: '276200905' });
    expect(out.ok).toBe(true);
    expect(wywolania[0]).toBe('https://konto.fakturownia.pl/clients/276200905.json?api_token=TOKEN-ADMINA');
  });
});

describe('httpGet: czytanie odpowiedzi', () => {
  /** Serwer, który odpowiada tak, jak każe `zachowanie`; zwraca adres oraz sprzątanie. */
  const serwer = async (zachowanie: Parameters<typeof createServer>[1]) => {
    const srv = createServer(zachowanie);
    await new Promise<void>((gotowe) => srv.listen(0, '127.0.0.1', gotowe));
    const { port } = srv.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/`, koniec: () => new Promise<void>((z) => { srv.close(() => z()); }) };
  };

  it('przerywa czytanie strumienia bez końca zamiast zbierać go w pamięci', async () => {
    let stop = false;
    const kawalek = 'x'.repeat(64 * 1024);
    const s = await serwer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('close', () => { stop = true; });
      const pisz = () => {
        if (stop) return res.end();
        if (res.write(kawalek)) setImmediate(pisz);
        else res.once('drain', pisz);
      };
      pisz();
    });
    try {
      const out = await httpGet(s.url, {}, 'GET', 5000);
      expect(out.status).toBe(200);
      expect(out.body.length).toBeGreaterThan(0);
      expect(out.body.length).toBeLessThanOrEqual(READ_LIMIT);
    } finally {
      stop = true;
      await s.koniec();
    }
  });

  it('nie czeka na odpowiedź zapowiedzianą ponad limit', async () => {
    const s = await serwer((_req, res) => {
      // Zapowiedź ogromna, treść skąpa: bez sprawdzenia nagłówka klient czekałby do przekroczenia czasu.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(READ_LIMIT * 10) });
      res.write('{"a":1}');
    });
    try {
      const out = await httpGet(s.url, {}, 'GET', 5000);
      expect(out.status).toBe(200);
      expect(out.body).toBe('');
    } finally {
      await s.koniec();
    }
  }, 8000);
});
