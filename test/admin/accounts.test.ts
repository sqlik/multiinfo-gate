import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { startAdminHarness, seedAccount, type AdminHarness } from '../helpers/admin-app.ts';

// Materiał testowy powstaje przy wczytywaniu modułu, a nie w beforeAll: warunek
// it.runIf jest sprawdzany już przy zbieraniu testów, więc flaga ustawiona
// później zostawiłaby cały zestaw cicho pominięty.
const dir = mkdtempSync(join(tmpdir(), 'mig-admin-'));
let pfx = Buffer.alloc(0);
let havePfx = false;
try {
  execFileSync('sh', ['test/fixtures/make-pfx.sh', dir], { stdio: 'pipe' });
  pfx = readFileSync(join(dir, 'test.pfx'));
  havePfx = true;
} catch {
  havePfx = false;
}

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

let h: AdminHarness;
let accountId: number;

beforeEach(async () => {
  h = await startAdminHarness();
  accountId = seedAccount(h, { login: 'firma_test' });
});

/** Buduje wieloczęściowe body z plikiem i hasłem. */
function multipart(file: Buffer, passphrase: string) {
  const b = '----mig';
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="pfx"; filename="cert.pfx"\r\n` +
    `Content-Type: application/x-pkcs12\r\n\r\n`);
  const mid = Buffer.from(
    `\r\n--${b}\r\nContent-Disposition: form-data; name="passphrase"\r\n\r\n${passphrase}\r\n--${b}--\r\n`);
  return {
    payload: Buffer.concat([head, file, mid]),
    headers: { 'content-type': `multipart/form-data; boundary=${b}`, cookie: h.cookie },
  };
}

describe('POST /konta/:id/certyfikat', () => {
  it('odrzuca plik ponad limit odpowiedzią 400, nie błędem serwera', async () => {
    const zaDuzy = Buffer.alloc(600 * 1024, 1);
    const res = await h.app.inject({ method: 'POST', url: `/konta/${accountId}/certyfikat`, ...multipart(zaDuzy, 'tajne123') });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('większy niż pół megabajta');
  });

  it('odrzuca żądanie bez formularza wieloczęściowego odpowiedzią 400', async () => {
    const res = await h.app.inject({
      method: 'POST', url: `/konta/${accountId}/certyfikat`, headers: { cookie: h.cookie }, payload: { passphrase: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it.runIf(havePfx)('rozpakowuje wgrany plik pfx i zapisuje metadane certyfikatu', async () => {
    const res = await h.app.inject({ method: 'POST', url: `/konta/${accountId}/certyfikat`, ...multipart(pfx, 'tajne123') });
    expect(res.statusCode).toBe(302);
    const account = h.accounts.get(accountId)!;
    expect(account.certCn).toBe('firma_test');
    expect(account.certFingerprintSha1).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){19}$/);
    expect(Date.parse(account.certNotAfter)).toBeGreaterThan(Date.now());
  });

  it.runIf(havePfx)('odrzuca złe hasło do pliku i pokazuje komunikat po polsku', async () => {
    const res = await h.app.inject({ method: 'POST', url: `/konta/${accountId}/certyfikat`, ...multipart(pfx, 'zle-haslo') });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('złe hasło do pliku');
    expect(h.accounts.get(accountId)!.certFingerprintSha1).toBe('AA:BB:CC');
  });

  it.runIf(havePfx)('ostrzega, gdy CN certyfikatu nie zgadza się z loginem konta', async () => {
    const inny = seedAccount(h, { name: 'Windykacja', login: 'firma_wind' });
    const res = await h.app.inject({ method: 'POST', url: `/konta/${inny}/certyfikat`, ...multipart(pfx, 'tajne123') });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('nie zgadza się z loginem');
    expect(res.body).toContain('-85');
  });

  it.runIf(havePfx)('zapisuje klucz prywatny w postaci zaszyfrowanej', async () => {
    await h.app.inject({ method: 'POST', url: `/konta/${accountId}/certyfikat`, ...multipart(pfx, 'tajne123') });
    const row = h.db.prepare('SELECT key_pem_enc, password_enc FROM accounts WHERE id = ?').get(accountId) as {
      key_pem_enc: string; password_enc: string;
    };
    expect(row.key_pem_enc).not.toContain('PRIVATE KEY');
    expect(row.key_pem_enc.startsWith('v1.')).toBe(true);
    expect(row.password_enc).not.toContain('tajne-multiinfo');
    // a odszyfrowanie musi dawać z powrotem poprawny PEM
    expect(h.accounts.getSecrets(accountId, h.masterKey).keyPem).toContain('PRIVATE KEY');
  });

  it.runIf(havePfx)('unieważnia klienta w puli po wymianie certyfikatu', async () => {
    await h.app.inject({ method: 'POST', url: `/konta/${accountId}/certyfikat`, ...multipart(pfx, 'tajne123') });
    expect(h.invalidated).toContain(accountId);
  });

  it.runIf(havePfx)('zapisuje wymianę w dzienniku zdarzeń', async () => {
    await h.app.inject({ method: 'POST', url: `/konta/${accountId}/certyfikat`, ...multipart(pfx, 'tajne123') });
    const entries = h.audit.list(10, 0);
    expect(entries.some((e) => e.action === 'certyfikat.wymiana' && e.actor === 'janek')).toBe(true);
  });

  it.runIf(havePfx)('wznawia konto wstrzymane po błędzie certyfikatu', async () => {
    h.accounts.pause(accountId, 'Certyfikat odrzucony przez Multiinfo, kod -84');
    await h.app.inject({ method: 'POST', url: `/konta/${accountId}/certyfikat`, ...multipart(pfx, 'tajne123') });
    const account = h.accounts.get(accountId)!;
    expect(account.pausedReason).toBeNull();
    expect(account.active).toBe(1);
    expect(h.audit.list(10, 0).some((e) => e.action === 'konto.wznowienie')).toBe(true);
  });

  it('odrzuca żądanie bez sesji', async () => {
    const res = await h.app.inject({ method: 'POST', url: `/konta/${accountId}/certyfikat`, payload: '' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/zaloguj');
  });
});

describe('POST /konta/:id/sprawdz', () => {
  const check = () => h.app.inject({ method: 'POST', url: `/konta/${accountId}/sprawdz`, headers: { cookie: h.cookie } });

  it('pokazuje wynik pozytywny, gdy Multiinfo zwróci -31', async () => {
    h.probe.result = { ok: true };
    const res = await check();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Certyfikat przyjęty');
    expect(h.probe.calls).toBe(1);
  });

  it('pokazuje surową odpowiedź przy błędzie logowania -1', async () => {
    h.probe.result = { ok: false, code: -1, message: 'Nie udało się zalogować' };
    const res = await check();
    expect(res.body).toContain('-1');
    expect(res.body).toContain('Nie udało się zalogować');
    expect(res.body).toContain('hasło');
  });

  it('pokazuje certyfikat tak, jak widzi go Multiinfo na stronie test.aspx', async () => {
    h.probe.result = { ok: true };
    const res = await check();
    expect(res.body).toContain('GET api2.multiinfo.plus.pl/test.aspx');
    expect(res.body).toContain('Certyfikat widziany przez Multiinfo');
    expect(res.body).toContain('GCP Signing CA');
    expect(res.body).toContain('2028-04-19 13:01:04');
    expect(res.body).toContain('CN widziane przez Multiinfo zgadza się z loginem');
  });

  it('ostrzega, gdy CN widziane przez Multiinfo różni się od loginu konta', async () => {
    h.probe.result = { ok: false, code: -85, message: 'Pole CN podmiotu nie jest zgodne z loginem' };
    h.probe.certificate = {
      seen: true, subject: 'CN=inna_firma', subjectCn: 'inna_firma',
      issuer: 'CN=GCP Signing CA', issuerCn: 'GCP Signing CA', validTo: '2028-04-19 13:01:04',
    };
    const res = await check();
    expect(res.body).toContain('inna_firma');
    expect(res.body).toContain('nie zgadza się z loginem konta');
  });

  it('przy -80 mówi wprost, że Multiinfo nie zobaczyło certyfikatu', async () => {
    h.probe.result = { ok: false, code: -80, message: 'Brak certyfikatu' };
    h.probe.certificate = { seen: false, message: 'Brak certyfikatu.' };
    const res = await check();
    expect(res.body).toContain('Multiinfo nie zobaczyło certyfikatu');
  });

  it('błąd sieci przy test.aspx nie psuje wyniku sprawdzenia', async () => {
    h.probe.result = { ok: true };
    h.probe.certificate = new Error('ECONNRESET');
    const res = await check();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Certyfikat przyjęty');
    expect(res.body).toContain('test.aspx nie odpowiedziała');
  });

  it('udane sprawdzenie wznawia konto wstrzymane przez workera', async () => {
    h.accounts.pause(accountId, 'Certyfikat odrzucony przez Multiinfo, kod -85');
    h.probe.result = { ok: true };
    const res = await check();
    expect(res.body).toContain('wznowione');
    expect(h.accounts.get(accountId)!.pausedReason).toBeNull();
    expect(h.audit.list(10, 0).some((e) => e.action === 'konto.wznowienie')).toBe(true);
  });

  it('nieudane sprawdzenie zostawia konto wstrzymane', async () => {
    h.accounts.pause(accountId, 'Certyfikat odrzucony przez Multiinfo, kod -85');
    h.probe.result = { ok: false, code: -85, message: 'Pole CN podmiotu nie jest zgodne z loginem' };
    await check();
    expect(h.accounts.get(accountId)!.pausedReason).toMatch(/-85/);
  });

  it('maszt panelu pokazuje numer wersji bramki', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/konta/${accountId}`, headers: { cookie: h.cookie } });
    expect(res.body).toMatch(/<span class="ver">\d+\.\d+\.\d+<\/span>/);
  });

  it('szczegół konta pokazuje powód wstrzymania', async () => {
    h.accounts.pause(accountId, 'Certyfikat odrzucony przez Multiinfo, kod -84: nie potwierdzono odcisku');
    const res = await h.app.inject({ method: 'GET', url: `/konta/${accountId}`, headers: { cookie: h.cookie } });
    expect(res.body).toContain('wstrzymane');
    expect(res.body).toContain('nie potwierdzono odcisku');
  });

  it('rozróżnia brak certyfikatu -80 od niezgodnego CN -85', async () => {
    h.probe.result = { ok: false, code: -80, message: 'Brak użycia certyfikatu klienckiego' };
    expect((await check()).body).toContain('certyfikat nie został przedstawiony');

    h.probe.result = { ok: false, code: -85, message: 'Pole CN podmiotu nie jest zgodne z loginem' };
    expect((await check()).body).toContain('nie zgadza się z loginem');
  });
});

describe('POST /konta/:id/nadpisy', () => {
  const save = (origs: string, defaultOrig = 'Firma Info') => h.app.inject({
    method: 'POST', url: `/konta/${accountId}/nadpisy`,
    headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ origs, defaultOrig }).toString(),
  });

  it('zapisuje słownik nadpisów uzgodnionych z Polkomtelem', async () => {
    const res = await save('Firma Info\nFirma Wind\nFirma Alert');
    expect(res.statusCode).toBe(302);
    expect(h.accounts.origs(accountId).sort()).toEqual(['Firma Alert', 'Firma Info', 'Firma Wind']);
  });

  it('odrzuca nadpis o nieprawidłowym formacie', async () => {
    const res = await save('Firma Info\nFirma_Informacje_Dlugie');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Firma_Informacje_Dlugie');
    expect(h.accounts.origs(accountId)).toEqual(['Firma Info']);
  });

  it('nie pozwala ustawić wartości domyślnej spoza słownika', async () => {
    const res = await save('Firma Info\nFirma Wind', 'Inna Firma');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('spoza słownika');
  });

  it('usunięcie nadpisu ze słownika kasuje go też z kluczy', async () => {
    await save('Firma Info\nFirma Wind');
    h.apiKeys.insert({
      accountId, name: 'Windykacja', keyHash: 'h1', keyPrefix: 'p1',
      defaultServiceId: '24138', defaultOrig: 'Firma Info', maxParts: 5, ratePerMin: 60,
      webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], origs: ['Firma Wind'],
    });
    expect(h.apiKeys.list().at(-1)!.allowedOrigs).toEqual(['Firma Wind']);

    await save('Firma Info');
    expect(h.apiKeys.list().at(-1)!.allowedOrigs).toEqual([]);
  });

  it('zachowuje nadpisy kluczy, gdy słownik zapisano bez zmian', async () => {
    await save('Firma Info\nFirma Wind');
    h.apiKeys.insert({
      accountId, name: 'Windykacja', keyHash: 'h2', keyPrefix: 'p2',
      defaultServiceId: '24138', defaultOrig: 'Firma Info', maxParts: 5, ratePerMin: 60,
      webhookUrl: null, webhookSecret: null, serviceIds: ['24138'], origs: ['Firma Wind'],
    });

    await save('Firma Info\nFirma Wind');
    expect(h.apiKeys.list().at(-1)!.allowedOrigs).toEqual(['Firma Wind']);
  });

  it('zapisuje zmianę w dzienniku zdarzeń', async () => {
    await save('Firma Info\nFirma Wind');
    expect(h.audit.list(10, 0).some((e) => e.action === 'konto.nadpisy')).toBe(true);
  });

  it('po zapisie nadpisów pokazuje komunikat na liście kont', async () => {
    const res = await h.app.inject({ method: 'POST', url: `/konta/${accountId}/nadpisy`,
      headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ origs: 'Firma Info', defaultOrig: 'Firma Info' }).toString() });
    expect(res.statusCode).toBe(302);
    const list = await h.app.inject({ method: 'GET', url: '/konta', headers: { cookie: h.cookie } });
    expect(list.body).toContain('class="flash flash-ok"');
    expect(list.body).toContain('Nadpisy konta Firma Info zapisane.');
  });

  it.runIf(havePfx)('po wczytaniu certyfikatu pokazuje CN i datę ważności', async () => {
    await h.app.inject({ method: 'POST', url: `/konta/${accountId}/certyfikat`, ...multipart(pfx, 'tajne123') });
    const detail = await h.app.inject({ method: 'GET', url: `/konta/${accountId}`, headers: { cookie: h.cookie } });
    expect(detail.body).toContain('class="flash flash-ok"');
    expect(detail.body).toMatch(/Certyfikat wczytany\. CN firma_test, ważny do \d{4}-\d{2}-\d{2}\./);
  });
});

describe('zakładanie konta', () => {
  /** Wieloczęściowe body z polami formularza i plikiem .pfx. */
  function form(fields: Record<string, string>, file: Buffer | null) {
    const b = '----mig2';
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    if (file !== null) {
      parts.push(Buffer.from(
        `--${b}\r\nContent-Disposition: form-data; name="pfx"; filename="cert.pfx"\r\n` +
        `Content-Type: application/x-pkcs12\r\n\r\n`));
      parts.push(file);
      parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${b}--\r\n`));
    return {
      payload: Buffer.concat(parts),
      headers: { 'content-type': `multipart/form-data; boundary=${b}`, cookie: h.cookie },
    };
  }

  const pola = {
    name: 'Windykacja', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/', login: 'firma_test',
    password: 'tajne-multiinfo', serviceIds: '24902\n24903', defaultCountryCode: '48',
    storeContent: '0', passphrase: 'tajne123',
  };

  const create = (patch: Partial<typeof pola> = {}, file: Buffer | null = pfx) =>
    h.app.inject({ method: 'POST', url: '/konta', ...form({ ...pola, ...patch }, file) });

  it('pokazuje formularz nowego konta', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/konta/nowe', headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Nowe konto Multiinfo');
  });

  it('domyślnie proponuje nieprzechowywanie treści wiadomości', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/konta/nowe', headers: { cookie: h.cookie } });
    expect(res.body).toMatch(/<option value="0" selected>/);
    expect(res.body).not.toMatch(/<option value="1" selected>/);
  });

  it.runIf(havePfx)('przechowuje treść tylko, gdy wybrano to jawnie', async () => {
    await create({ storeContent: '1' });
    expect(h.accounts.list().find((a) => a.name === 'Windykacja')!.storeContent).toBe(1);
  });

  it.runIf(havePfx)('zakłada konto z certyfikatem i zapisuje sekrety zaszyfrowane', async () => {
    const res = await create();
    expect(res.statusCode).toBe(302);

    const utworzone = h.accounts.list().find((a) => a.name === 'Windykacja')!;
    expect(utworzone.login).toBe('firma_test');
    expect(utworzone.certCn).toBe('firma_test');
    expect(utworzone.storeContent).toBe(0);
    expect(h.accounts.serviceIds(utworzone.id)).toEqual(['24902', '24903']);
    expect(h.accounts.getSecrets(utworzone.id, h.masterKey).password).toBe('tajne-multiinfo');

    const row = h.db.prepare('SELECT password_enc FROM accounts WHERE id = ?').get(utworzone.id) as
      { password_enc: string };
    expect(row.password_enc).not.toContain('tajne-multiinfo');
  });

  it.runIf(havePfx)('nie zakłada konta, gdy CN certyfikatu nie zgadza się z loginem', async () => {
    const res = await create({ login: 'ktos_inny' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('nie zgadza się z podanym loginem');
    expect(h.accounts.list().some((a) => a.name === 'Windykacja')).toBe(false);
  });

  it.runIf(havePfx)('nie odsyła hasła konta z powrotem do przeglądarki po błędzie', async () => {
    const res = await create({ login: 'ktos_inny' });
    expect(res.body).not.toContain('tajne-multiinfo');
    expect(res.body).not.toContain('tajne123');
  });

  it('odrzuca adres bazowy bez https', async () => {
    const res = await create({ baseUrl: 'http://api2.multiinfo.plus.pl/Api61/' }, null);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('https://');
  });

  it('odrzuca konto bez identyfikatora usługi', async () => {
    const res = await create({ serviceIds: '' }, null);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('identyfikator usługi');
  });

  it.runIf(havePfx)('zapisuje utworzenie konta w dzienniku zdarzeń', async () => {
    await create();
    expect(h.audit.list(10, 0).some((e) => e.action === 'konto.utworzenie')).toBe(true);
  });
});

describe('edycja konta', () => {
  const edit = (id: number, over: Record<string, string> = {}) =>
    h.app.inject({ method: 'POST', url: `/konta/${id}/edytuj`,
      headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ name: 'Firma Info', baseUrl: 'https://api2.multiinfo.plus.pl/Api61/',
        password: '', defaultCountryCode: '48', storeContent: '1', serviceIds: '24138', ...over }).toString() });

  it('pokazuje formularz z loginem tylko do odczytu', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/konta/${accountId}/edytuj`, headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Login jest związany z polem CN certyfikatu. Zmiana loginu oznacza nowe konto.');
    expect(res.body).not.toContain('name="login"');
    expect(res.body).toContain('value="Firma Info"');
  });

  it('zapisuje pola i ID usług, pokazuje komunikat, zapisuje zdarzenie', async () => {
    const res = await edit(accountId, { name: 'Firma 2', serviceIds: '24138\n99001', defaultCountryCode: '49' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/konta/${accountId}`);
    expect(h.accounts.get(accountId)!.name).toBe('Firma 2');
    expect(h.accounts.serviceIds(accountId)).toEqual(['24138', '99001']);
    const detail = await h.app.inject({ method: 'GET', url: `/konta/${accountId}`, headers: { cookie: h.cookie } });
    expect(detail.body).toContain('Konto Firma 2 zapisane.');
    const entry = h.audit.list(1, 0)[0]!;
    expect(entry.action).toBe('konto.edycja');
    expect(entry.meta?.pola).toEqual(expect.arrayContaining(['name', 'serviceIds', 'defaultCountryCode']));
    expect(JSON.stringify(entry.meta)).not.toContain('tajne');
  });

  it('odmawia odebrania ID usługi używanego przez czynny klucz i nic nie zmienia', async () => {
    h.apiKeys.insert({ accountId, name: 'Sklep', keyHash: 'h', keyPrefix: 'p1', defaultServiceId: '24138',
      defaultOrig: null, maxParts: 5, ratePerMin: 60, webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] });
    const res = await edit(accountId, { name: 'Firma 2', serviceIds: '99001' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('ID usługi 24138 jest używane przez klucze: Sklep. Najpierw zmień lub odwołaj te klucze.');
    expect(h.accounts.get(accountId)!.name).toBe('Firma Info');
    expect(h.accounts.serviceIds(accountId)).toEqual(['24138']);
  });

  it('po zmianie hasła sprawdza połączenie i przy porażce ostrzega, nie wstrzymując konta', async () => {
    h.probe.result = { ok: false, code: -1, message: 'Błędny login lub hasło' };
    const res = await edit(accountId, { password: 'nowe-haslo' });
    expect(res.statusCode).toBe(302);
    expect(h.probe.calls).toBe(1);
    expect(h.invalidated).toContain(accountId);
    expect(h.accounts.getSecrets(accountId, h.masterKey).password).toBe('nowe-haslo');
    expect(h.accounts.get(accountId)!.pausedReason).toBeNull();
    const detail = await h.app.inject({ method: 'GET', url: `/konta/${accountId}`, headers: { cookie: h.cookie } });
    expect(detail.body).toContain('class="flash flash-warn"');
    expect(detail.body).toContain('Konto Firma Info zapisane, ale sprawdzenie połączenia nie powiodło się');
    expect(detail.body).toContain('Konto nie zostało wstrzymane.');
  });

  it('zapis samych ID usług nie wywołuje sprawdzenia', async () => {
    await edit(accountId, { serviceIds: '24138\n99001' });
    expect(h.probe.calls).toBe(0);
  });

  it('puste hasło nie zmienia zapisanego', async () => {
    await edit(accountId, { name: 'Firma 3' });
    expect(h.accounts.getSecrets(accountId, h.masterKey).password).toBe('tajne-multiinfo');
  });

  it('nie edytuje konta, którego nie ma', async () => {
    const res = await edit(999);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /konta', () => {
  it('licznik kluczy API liczy tylko czynne klucze', async () => {
    const base = { accountId, defaultServiceId: '24138', defaultOrig: null, maxParts: 5, ratePerMin: 60,
      webhookUrl: null, webhookSecret: null, serviceIds: ['24138'] };
    h.apiKeys.insert({ ...base, name: 'Czynny', keyHash: 'h1', keyPrefix: 'p1' });
    const stary = h.apiKeys.insert({ ...base, name: 'Stary', keyHash: 'h2', keyPrefix: 'p2' });
    h.apiKeys.revoke(stary);
    const res = await h.app.inject({ method: 'GET', url: '/konta', headers: { cookie: h.cookie } });
    expect(res.body).toContain('<td class="m">1</td>');
    expect(res.body).not.toContain('<td class="m">2</td>');
  });
  it('wypisuje słownik nadpisów konta', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/konta', headers: { cookie: h.cookie } });
    expect(res.body).toContain('Firma Info');
  });

  it('przypomina, skąd biorą się nadpisy, gdy słownik jest pusty', async () => {
    seedAccount(h, { name: 'Nowe', login: 'nowe', origs: [] });
    const res = await h.app.inject({ method: 'GET', url: '/konta', headers: { cookie: h.cookie } });
    expect(res.body).toContain('na wniosek złożony w panelu Multiinfo');
  });

  it('nie ujawnia hasła ani klucza prywatnego w treści strony', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/konta', headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('tajne-multiinfo');
    expect(res.body).not.toContain('PRIVATE KEY');
    expect(res.body).not.toContain('v1.');
  });

  it('pokazuje liczbę dni do wygaśnięcia certyfikatu', async () => {
    seedAccount(h, { name: 'Windykacja', login: 'firma_wind', notAfter: '2026-09-08' });
    const res = await h.app.inject({ method: 'GET', url: '/konta', headers: { cookie: h.cookie } });
    expect(res.body).toContain('14 dni');
  });

  it('ucieka znaki HTML w nazwie konta', async () => {
    seedAccount(h, { name: '<script>alert(1)</script>', login: 'x' });
    const res = await h.app.inject({ method: 'GET', url: '/konta', headers: { cookie: h.cookie } });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });
});

describe('teksty ekranów kont', () => {
  it('mówi, gdzie w panelu Multiinfo wpisać dane certyfikatu', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/konta/${accountId}`, headers: { cookie: h.cookie } });
    expect(res.body).toContain('Przed pierwszym użyciem uzupełnij wystawcę, podmiot i odcisk palca w panelu Multiinfo '
      + '(edycja użytkownika API, zakładka Uwierzytelnianie).');
    expect(res.body).not.toContain('prześlij do Polkomtel');
  });

  it('formularz nowego konta prowadzi do panelu Multiinfo i instrukcji certyfikatu', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/konta/nowe', headers: { cookie: h.cookie } });
    expect(res.body).toContain('Dane użytkownika API należy utworzyć w panelu Multiinfo.');
    expect(res.body).toContain('href="https://plk-assets.s3.pl-waw.scw.cloud/certyfikaty-multiinfo.zip"');
    expect(res.body).toContain('api1 lub api2 - informacje o właściwej instancji otrzymasz od przedstawiciela Polkomtel.');
    expect(res.body).toContain('ID usług, jedno w wierszu');
  });

  it('lista kont mówi o autoryzacji nadpisów po stronie Polkomtel', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/konta', headers: { cookie: h.cookie } });
    expect(res.body).toContain('Nadpis uruchamia Polkomtel na wniosek złożony w panelu Multiinfo.');
    expect(res.body).toContain('<th style="width: 150px;">ID usług</th>');
  });
});
