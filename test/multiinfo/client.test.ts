import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultiinfoClient } from '../../src/multiinfo/client.ts';
import { ProviderError } from '../../src/multiinfo/response.ts';
import { startFakeMultiinfo, type FakeMultiinfo } from '../helpers/fake-multiinfo.ts';

let fake: FakeMultiinfo;
let client: MultiinfoClient;

beforeAll(async () => {
  fake = await startFakeMultiinfo();
  client = new MultiinfoClient({
    baseUrl: fake.baseUrl,
    login: 'firma_test',
    password: 'tajne',
    certPem: fake.clientCertPem,
    keyPem: fake.clientKeyPem,
    caPem: fake.caPem,
  }, { extraServerCa: fake.serverCaPem });
}, 60_000);

afterAll(async () => {
  client.close();
  await fake.close();
});

describe('MultiinfoClient.sendLong', () => {
  it('weryfikuje serwer zaufanymi CA, a serwerowi przedstawia pełny łańcuch klienta', async () => {
    // Łańcuch z .pfx nie może zastąpić magazynu zaufanych CA (serwer ma certyfikat z innego CA),
    // a CA pośrednie klienta musi dotrzeć do serwera, bo ten zna tylko korzeń.
    fake.reply('0\n1');
    await client.sendLong({
      serviceId: '24138', dest: '48601135134', text: 'Ala ma kota',
      deliveryReport: true, advancedEncoding: false, deleteContent: false,
    });
    const req = fake.requests.at(-1)!;
    expect(req.clientCn).toBe('firma_test');
    expect(req.clientIssuerCn).toBe('Fake Client Issuing CA');
  });

  it('uderza w sendsmslong.aspx i przedstawia certyfikat kliencki', async () => {
    fake.reply('0\n8841207\n8841208');
    await client.sendLong({
      serviceId: '24138', dest: '48601135134', text: 'Ala ma kota',
      deliveryReport: true, advancedEncoding: false, deleteContent: false,
    });
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe('/Api61/sendsmslong.aspx');
    expect(req.clientCn).toBe('firma_test');
  });

  it('przekazuje treść w parametrze text, nigdy w data', async () => {
    fake.reply('0\n1');
    await client.sendLong({
      serviceId: '24138', dest: '48601135134', text: 'Zażółć gęślą jaźń',
      deliveryReport: false, advancedEncoding: true, deleteContent: false,
    });
    const req = fake.requests.at(-1)!;
    expect(req.params.text).toBe('Zażółć gęślą jaźń');
    expect(req.params).not.toHaveProperty('data');
  });

  it('przekazuje komplet parametrów wysyłki', async () => {
    fake.reply('0\n1');
    await client.sendLong({
      serviceId: '24138', dest: '48601135134', text: 'x', orig: 'Firma Info',
      validTo: new Date(Date.UTC(2026, 7, 26, 10, 0, 0)), costCenter: 'marketing',
      deliveryReport: true, advancedEncoding: true, deleteContent: true,
    });
    const p = fake.requests.at(-1)!.params;
    expect(p.login).toBe('firma_test');
    expect(p.password).toBe('tajne');
    expect(p.serviceId).toBe('24138');
    expect(p.dest).toBe('48601135134');
    expect(p.orig).toBe('Firma Info');
    // Multiinfo czyta daty w czasie polskim: 10:00 UTC to latem 12:00.
    expect(p.validTo).toBe('20260826120000');
    expect(p.costCenter).toBe('marketing');
    expect(p.delivNotifRequest).toBe('true');
    expect(p.advancedEncoding).toBe('true');
    expect(p.deleteContent).toBe('true');
  });

  it('zapisuje termin ważności w czasie polskim także zimą', async () => {
    fake.reply('0\n1');
    await client.sendLong({
      serviceId: '24138', dest: '48601135134', text: 'x',
      validTo: new Date(Date.UTC(2026, 0, 15, 23, 30, 0)),
      deliveryReport: false, advancedEncoding: false, deleteContent: false,
    });
    // 23:30 UTC 15 stycznia to 00:30 16 stycznia czasu polskiego.
    expect(fake.requests.at(-1)!.params.validTo).toBe('20260116003000');
  });

  it('pomija parametry opcjonalne, których nie podano', async () => {
    fake.reply('0\n1');
    await client.sendLong({
      serviceId: '24138', dest: '48601135134', text: 'x',
      deliveryReport: false, advancedEncoding: false, deleteContent: false,
    });
    const p = fake.requests.at(-1)!.params;
    expect(p).not.toHaveProperty('orig');
    expect(p).not.toHaveProperty('validTo');
    expect(p).not.toHaveProperty('costCenter');
  });

  it('zwraca identyfikatory wszystkich części', async () => {
    fake.reply('0\n8841207\n8841208');
    const { miIds } = await client.sendLong({
      serviceId: '24138', dest: '48601135134', text: 'x',
      deliveryReport: false, advancedEncoding: false, deleteContent: false,
    });
    expect(miIds).toEqual(['8841207', '8841208']);
  });

  it('zwraca ślad protokołu z zamaskowanym hasłem', async () => {
    fake.reply('0\n8841207\n8841208');
    const result = await client.sendLong({
      serviceId: '24138', dest: '48601135134', text: 'Ala', deliveryReport: true, advancedEncoding: false, deleteContent: false,
    });
    expect(result.trace.script).toBe('sendsmslong.aspx');
    expect(result.trace.params.login).toBe('firma_test');
    expect(result.trace.params.password).toBe('••••••••');
    expect(result.trace.params.text).toBe('Ala');
    expect(result.trace.lines).toEqual(['8841207', '8841208']);
    expect(result.trace.httpStatus).toBe(200);
    expect(result.trace.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.trace.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('zgłasza ProviderError z kategorią przy błędzie usługi', async () => {
    fake.reply('-24\nUsługa o podanym identyfikatorze nie jest aktywna');
    await expect(client.sendLong({
      serviceId: '99999', dest: '48601135134', text: 'x',
      deliveryReport: false, advancedEncoding: false, deleteContent: false,
    })).rejects.toMatchObject({ code: -24, kind: 'permanent' });
  });

  it('rozpoznaje błąd certyfikatu jako osobną kategorię', async () => {
    fake.reply('-85\nPole CN podmiotu nie jest zgodne z loginem użytkownika');
    await expect(client.sendLong({
      serviceId: '24138', dest: '48601135134', text: 'x',
      deliveryReport: false, advancedEncoding: false, deleteContent: false,
    })).rejects.toMatchObject({ code: -85, kind: 'certificate' });
  });
});

describe('MultiinfoClient.info', () => {
  it('czyta status i substatus z odpowiedzi infosms', async () => {
    fake.reply('0\n33\n1\nala\n0\n0\n2\n1\n-1\n0\n030706085937\n010101000000\nFalse\nFirma Info\n48601357368\n21\n1\n2026-08-25 10:44:09');
    const info = await client.info('33');
    expect(info).toEqual({
      miId: '33', status: 21, substatus: 1, dest: '48601357368',
      orig: 'Firma Info', changedAt: '2026-08-25 10:44:09',
    });
  });
});

describe('MultiinfoClient.cancel', () => {
  it('wywołuje cancelsms.aspx z identyfikatorem części', async () => {
    fake.reply('0\nOK');
    await client.cancel('8841207');
    expect(fake.requests.at(-1)!.path).toBe('/Api61/cancelsms.aspx');
    expect(fake.requests.at(-1)!.params.smsId).toBe('8841207');
  });

  it('przepuszcza -41 jako błąd trwały', async () => {
    fake.reply('-41\nwiadomość już została przekazana, nie można anulować');
    await expect(client.cancel('8841207')).rejects.toMatchObject({ code: -41, kind: 'permanent' });
  });
});

describe('MultiinfoClient - rozsyłki', () => {
  it('createPackage wysyła powtórzony parametr dest w formacie z dokumentacji', async () => {
    fake.reply('0\n14');
    const id = await client.createPackage({
      serviceId: '24138', defaultText: 'Domyślna', deliveryReport: true, advancedEncoding: false, multipart: false,
      startAt: new Date(Date.UTC(2026, 7, 26, 6, 0, 0)), orig: 'Firma Info',
      recipients: [
        { dest: '48601135134', text: null, clientId: null },
        { dest: '48501052442', text: 'Indywidualna, z przecinkiem', clientId: null },
        { dest: '48501052443', text: null, clientId: 'faktura-114' },
        { dest: '48501052444', text: 'Tekst', clientId: 'f-115' },
      ],
    });
    expect(id).toBe('14');
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe('/Api61/package.aspx');
    expect(req.params.text).toBe('Domyślna');
    expect(req.params).not.toHaveProperty('data');
    expect(req.params).not.toHaveProperty('dests');
    expect(req.multi.dest).toEqual([
      '48601135134', '48501052442,Indywidualna, z przecinkiem', '48501052443[faktura-114]', '48501052444[f-115],Tekst',
    ]);
    expect(req.params.startDate).toBe('20260826080000');
    expect(req.params.delivNotifRequest).toBe('true');
    expect(req.params.advancedEncoding).toBe('false');
    expect(req.params.isMultiPart).toBe('false');
    expect(req.params.orig).toBe('Firma Info');
    expect(req.params).not.toHaveProperty('costCenter');
  });

  it('createPackage pomija treść domyślną, gdy jej nie ma, i przekazuje centrum kosztów', async () => {
    fake.reply('0\n15');
    await client.createPackage({
      serviceId: '24138', defaultText: null, deliveryReport: false, advancedEncoding: true, multipart: true,
      costCenter: 'marketing', recipients: [{ dest: '48601135134', text: 'Własna', clientId: null }],
    });
    const req = fake.requests.at(-1)!;
    expect(req.params).not.toHaveProperty('text');
    expect(req.params.costCenter).toBe('marketing');
    expect(req.params.isMultiPart).toBe('true');
  });

  it('createPackage zgłasza błąd, gdy odpowiedź nie niesie identyfikatora', async () => {
    fake.reply('0\n');
    await expect(client.createPackage({
      serviceId: '24138', defaultText: 'x', deliveryReport: false, advancedEncoding: false, multipart: false,
      recipients: [{ dest: '48601135134', text: null, clientId: null }],
    })).rejects.toMatchObject({ code: -71, kind: 'transient' });
  });

  it('packageInfo czyta identyfikator, liczby i status', async () => {
    fake.reply('0\n5\n10\n3\n2');
    expect(await client.packageInfo('5')).toEqual({ miPackageId: '5', saved: 10, remaining: 3, status: 2 });
    expect(fake.requests.at(-1)!.path).toBe('/Api61/packageinfo.aspx');
    expect(fake.requests.at(-1)!.params.packageId).toBe('5');
  });

  it('packageFullInfo czyta identyfikator raportu i etap z odpowiedzi z linią statusu', async () => {
    fake.reply('0\r\n28154463\n7506\n2\n58');
    expect(await client.packageFullInfo('28154463', 'csv')).toEqual({ reportId: '7506', generation: 2, minutesLeft: 58 });
  });

  it('packageFullInfo rozumie odpowiedź bez linii statusu', async () => {
    fake.reply('5\n123\n2\n30');
    expect(await client.packageFullInfo('5', 'csv')).toEqual({ reportId: '123', generation: 2, minutesLeft: 30 });
    expect(fake.requests.at(-1)!.path).toBe('/Api61/packagefullinfo.aspx');
    expect(fake.requests.at(-1)!.params.packageId).toBe('5');
    expect(fake.requests.at(-1)!.params.fileFormat).toBe('csv');
    fake.reply('-62\nBrak rozsyłki o podanym numerze');
    await expect(client.packageFullInfo('5', 'csv')).rejects.toMatchObject({ code: -62, kind: 'permanent' });
  });

  it('getReport zwraca surowe bajty, a odpowiedź tekstową z kodem traktuje jako błąd', async () => {
    const zip = Buffer.from('504b0304', 'hex');
    fake.reply(zip, 200, 'application/zip');
    expect((await client.getReport('123')).equals(zip)).toBe(true);
    expect(fake.requests.at(-1)!.path).toBe('/Api61/getreport.aspx');
    expect(fake.requests.at(-1)!.params.reportId).toBe('123');
    fake.reply('-62\nBrak raportu');
    await expect(client.getReport('123')).rejects.toMatchObject({ code: -62 });
  });
});

describe('MultiinfoClient.probe', () => {
  it('uznaje kod -31 za dowód poprawnego certyfikatu i logowania', async () => {
    fake.reply('-31\nNieprawidłowa wartość identyfikatora wiadomości');
    await expect(client.probe()).resolves.toEqual({ ok: true });
  });

  it('zgłasza problem, gdy logowanie się nie powiodło', async () => {
    fake.reply('-1\nNie udało się zalogować');
    await expect(client.probe()).resolves.toMatchObject({ ok: false, code: -1 });
  });

  it('zgłasza problem, gdy certyfikat nie został zaakceptowany', async () => {
    fake.reply('-85\nPole CN podmiotu nie jest zgodne z loginem użytkownika');
    await expect(client.probe()).resolves.toMatchObject({ ok: false, code: -85 });
  });
});

describe('MultiinfoClient - błędy transportu', () => {
  it('zgłasza ProviderError przy odpowiedzi HTTP 5xx', async () => {
    fake.reply('Service Unavailable', 503);
    await expect(client.sendLong({
      serviceId: '24138', dest: '48601135134', text: 'x',
      deliveryReport: false, advancedEncoding: false, deleteContent: false,
    })).rejects.toBeInstanceOf(ProviderError);
  });
});
