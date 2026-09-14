import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/api/openapi.ts';
import { RateLimiter } from '../../src/api/rate-limit.ts';
import { buildApiServer } from '../../src/api/server.ts';
import { AccountsRepo } from '../../src/store/accounts.ts';
import { ApiKeysRepo } from '../../src/store/api-keys.ts';
import { openDatabase } from '../../src/store/db.ts';
import { InboundMessagesRepo } from '../../src/store/inbound-messages.ts';
import { JobsRepo } from '../../src/store/jobs.ts';
import { MessageEventsRepo } from '../../src/store/message-events.ts';
import { MessagesRepo } from '../../src/store/messages.ts';
import { PackagesRepo } from '../../src/store/packages.ts';
import { integrationDeps } from '../helpers/api-deps.ts';

/**
 * Trasy prawdziwego serwera, w postaci `METODA /adres`. Fastify rysuje je drzewem ze wspólnymi
 * przedrostkami, więc pełny adres powstaje ze sklejenia gałęzi od korzenia do liścia.
 */
function trasySerwera(drzewo: string): string[] {
  const sciezki: string[] = [];
  const przodkowie: string[] = [];
  for (const linia of drzewo.split('\n')) {
    const marker = linia.search(/[├└]── /);
    if (marker === -1) continue;
    const poziom = Math.floor(marker / 4);
    const tresc = linia.slice(marker + 4);
    const [, segment = '', metody] = /^(.*?)(?: \(([^()]*)\))?$/.exec(tresc) ?? [];
    przodkowie.length = poziom;
    przodkowie.push(segment);
    if (!metody) continue;
    // Fastify dokłada HEAD do każdego GET-a; opis API mówi o metodach, które wywołuje aplikacja.
    const adres = przodkowie.join('').replace(/:([A-Za-z]+)/g, '{$1}');
    for (const metoda of metody.split(', ')) {
      if (metoda !== 'HEAD') sciezki.push(`${metoda.toLowerCase()} ${adres}`);
    }
  }
  return sciezki;
}

let trasy: string[];

beforeAll(async () => {
  const masterKey = randomBytes(32);
  const db = openDatabase(':memory:');
  const app = buildApiServer({
    accounts: new AccountsRepo(db, masterKey),
    apiKeys: new ApiKeysRepo(db, masterKey),
    messages: new MessagesRepo(db),
    events: new MessageEventsRepo(db),
    jobs: new JobsRepo(db),
    packages: new PackagesRepo(db),
    inbound: new InboundMessagesRepo(db),
    clients: {} as never,
    rateLimiter: new RateLimiter(),
    healthMode: 'public',
    ...integrationDeps(db, masterKey),
  });
  await app.ready();
  trasy = trasySerwera(app.printRoutes({ commonPrefix: false }));
  await app.close();
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

  it('każde pole odpowiedzi odczytu ma opis po polsku', () => {
    for (const nazwa of ['Wiadomosc', 'WiadomoscPrzychodzaca', 'Rozsylka', 'WierszRaportu']) {
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

  it('nazwa operacji jest niepowtarzalna, bo po niej nazywają się metody wygenerowanego klienta', () => {
    const nazwy = Object.values(doc.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId);
    expect(new Set(nazwy).size).toBe(nazwy.length);
  });

  it('zapisany plik zgadza się z modułem', () => {
    const zapisany = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
    expect(zapisany).toEqual(JSON.parse(JSON.stringify(doc)));
  });
});
