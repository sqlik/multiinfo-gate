import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/api/openapi.ts';

describe('opis API', () => {
  const doc = buildOpenApiDocument();

  it('ma wersję formatu, tytuł oraz wersję bramki', () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('Multiinfo Gate');
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('opisuje każdą trasę publicznego API', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/healthz', '/v1/messages', '/v1/messages/{id}/cancel', '/v1/packages', '/v1/packages/{id}/report',
    ]);
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

  it('każda odpowiedź błędu ma ten sam kształt', () => {
    const blad = doc.components.schemas['Blad']!;
    expect(Object.keys(blad.properties!).sort()).toEqual(['code', 'message', 'providerCode']);
    expect(blad.required!.slice().sort()).toEqual(['code', 'message']);

    for (const [sciezka, pozycja] of Object.entries(doc.paths)) {
      for (const [metoda, operacja] of Object.entries(pozycja)) {
        for (const [kod, odpowiedz] of Object.entries(operacja.responses)) {
          if (Number(kod) < 400) continue;
          const schema = odpowiedz.content?.['application/json']?.schema;
          expect(schema?.$ref, `${metoda.toUpperCase()} ${sciezka} ${kod}`)
            .toBe('#/components/schemas/OdpowiedzBledu');
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

  it('zapisany plik zgadza się z modułem', () => {
    const zapisany = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
    expect(zapisany).toEqual(JSON.parse(JSON.stringify(doc)));
  });
});
