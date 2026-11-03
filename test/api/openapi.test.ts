import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/api/openapi.ts';
import { paGroupBodySchema, paMessageBodySchema, paPackageBodySchema } from '../../src/api/pa-integrations.ts';
import { apiServerRoutes } from '../helpers/routes.ts';

let trasy: string[];

beforeAll(async () => {
  trasy = await apiServerRoutes();
});

describe('opis API', () => {
  const doc = buildOpenApiDocument();

  it('ma wersję formatu, tytuł oraz wersję bramki', () => {
    // Wersja 3.0, a nie 3.1: konektor własny Power Platform czyta tylko 2.0 oraz 3.0.
    expect(doc.openapi).toMatch(/^3\.0\./);
    expect(doc.info.title).toBe('Multiinfo Gate');
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(doc.info.license.url).toMatch(/^https:\/\//);
  });

  it('opisuje każdą trasę publicznego API i żadnej zmyślonej', () => {
    // Adres wejściowy integracji ma osobne uwierzytelnienie i osobną dokumentację, więc go tu nie ma.
    const publiczne = trasy.filter((t) => !t.includes('/hooks/')).sort();
    const opisane: string[] = [];
    for (const [sciezka, pozycja] of Object.entries(doc.paths)) {
      for (const metoda of Object.keys(pozycja)) opisane.push(`${metoda} ${sciezka}`);
    }
    expect(publiczne.length).toBeGreaterThan(8);
    expect(opisane.sort()).toEqual(publiczne);
  });

  it('wysyłka wymaga klucza oraz opisuje wszystkie pola ciała', () => {
    const wyslij = doc.paths['/v1/messages']!.post!;
    expect(wyslij.security).toEqual([{ bearerAuth: [] }]);
    const schema = wyslij.requestBody!.content['application/json']!.schema;
    expect(Object.keys(schema.properties!).sort()).toEqual(
      ['costCenter', 'deliveryReport', 'encoding', 'inReplyTo', 'maxParts', 'orig', 'serviceId', 'text', 'to', 'validTo'],
    );
    expect(schema.required!.slice().sort()).toEqual(['text', 'to']);
  });

  it('każde pole ciała wysyłki ma opis po polsku', () => {
    const schema = doc.paths['/v1/messages']!.post!.requestBody!.content['application/json']!.schema;
    for (const [nazwa, pole] of Object.entries(schema.properties!)) {
      expect(pole.description, nazwa).toBeTruthy();
    }
  });

  it('wywołania integracji Power Automate opisują każde pole ciała, bez usługi i nadpisu, ze zlecającym', () => {
    const ciala = {
      '/v1/integrations/{id}/messages': paMessageBodySchema.shape,
      '/v1/integrations/{id}/packages': paPackageBodySchema.shape,
      '/v1/integrations/{id}/group': paGroupBodySchema.shape,
    };
    for (const [sciezka, shape] of Object.entries(ciala)) {
      const operacja = doc.paths[sciezka]!.post!;
      expect(operacja.parameters![0], sciezka).toMatchObject({ name: 'id', in: 'path', required: true });
      const schema = operacja.requestBody!.content['application/json']!.schema;
      expect(Object.keys(schema.properties!).sort(), sciezka).toEqual(Object.keys(shape).sort());
      for (const [nazwa, pole] of Object.entries(schema.properties!)) expect(pole.description, `${sciezka} ${nazwa}`).toBeTruthy();
      expect(schema.properties!['requestedBy']!.maxLength, sciezka).toBe(100);
    }
    const numer = doc.paths['/v1/integrations/{id}/messages']!.post!.requestBody!.content['application/json']!.schema.properties!['to']!;
    expect(numer.type).toBe('string');
    expect(numer.description).toMatch(/[Pp]usty numer/);
    expect(doc.paths['/v1/integrations']!.get!.operationId).toBe('listaIntegracjiPowerAutomate');
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(['IntegracjaPowerAutomate', 'WysylkaDoGrupy']));
    // Odpowiedź grupy nie podaje numerów członków listy.
    const wiadomosc = doc.components.schemas.WysylkaDoGrupy!.properties!.messages!.items!;
    expect(Object.keys(wiadomosc.properties!)).toEqual(['id', 'status', 'parts']);
    expect(wiadomosc.required).toEqual(['id', 'status', 'parts']);
  });

  it('każde pole odpowiedzi odczytu ma opis po polsku', () => {
    for (const nazwa of ['Wiadomosc', 'WiadomoscPrzychodzaca', 'Rozsylka', 'WierszRaportu', 'IntegracjaPowerAutomate', 'WysylkaDoGrupy']) {
      const schema = doc.components.schemas[nazwa]!;
      for (const [pole, opis] of Object.entries(schema.properties!)) {
        expect(opis.description, `${nazwa}.${pole}`).toBeTruthy();
      }
    }
  });

  it('każda odpowiedź błędu niesie opis błędu w tym samym kształcie', () => {
    const blad = doc.components.schemas['Blad']!;
    expect(Object.keys(blad.properties!).sort()).toEqual(['code', 'message', 'providerCode']);
    expect(blad.required!.slice().sort()).toEqual(['code', 'message']);

    for (const [sciezka, pozycja] of Object.entries(doc.paths)) {
      for (const [metoda, operacja] of Object.entries(pozycja)) {
        for (const [kod, odpowiedz] of Object.entries(operacja.responses)) {
          if (Number(kod) < 400) continue;
          const gdzie = `${metoda.toUpperCase()} ${sciezka} ${kod}`;
          const ref = odpowiedz.content?.['application/json']?.schema.$ref;
          expect(ref, gdzie).toBeTruthy();
          const nazwa = ref!.replace('#/components/schemas/', '');
          expect(doc.components.schemas[nazwa]?.properties?.['error']?.$ref, gdzie)
            .toBe('#/components/schemas/Blad');
        }
      }
    }
  });

  it('każda trasa poza stanem bramki wymaga klucza', () => {
    for (const [sciezka, pozycja] of Object.entries(doc.paths)) {
      for (const operacja of Object.values(pozycja)) {
        expect(operacja.security, sciezka).toEqual(sciezka === '/healthz' ? [] : [{ bearerAuth: [] }]);
      }
    }
  });

  it('stan bramki opisuje tryb awaryjny odpowiedzią 503 ze stanem unavailable', () => {
    const odp = doc.paths['/healthz']!['get']!.responses['503'];
    const ref = odp?.content?.['application/json']?.schema.$ref;
    expect(ref).toBe('#/components/schemas/StanNiedostepny');
    expect(doc.components.schemas['StanNiedostepny']?.properties?.['status']?.enum).toEqual(['unavailable']);
  });

  it('nazwa operacji jest niepowtarzalna, bo po niej nazywają się metody wygenerowanego klienta', () => {
    const nazwy = Object.values(doc.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId);
    expect(new Set(nazwy).size).toBe(nazwy.length);
  });

  it('zapisany plik zgadza się z modułem', () => {
    const zapisany = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
    expect(zapisany).toEqual(JSON.parse(JSON.stringify(doc)));
  });
});
