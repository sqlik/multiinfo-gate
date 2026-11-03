import { beforeAll, describe, expect, it } from 'vitest';
import { paGroupBodySchema, paMessageBodySchema, paPackageBodySchema } from '../../src/api/pa-integrations.ts';
import {
  CONNECTOR_OMITTED, CONNECTOR_OPERATIONS, CONNECTOR_TITLE, buildPowerAutomateConnector, connectorAddress,
  type SwaggerOperation, type SwaggerParameter, type SwaggerSchema,
} from '../../src/api/power-automate.ts';
import { buildOpenApiDocument, type JsonSchema } from '../../src/api/openapi.ts';
import { GATE_VERSION } from '../../src/version.ts';
import { apiServerRoutes } from '../helpers/routes.ts';

describe('connectorAddress', () => {
  it('przyjmuje adres https z domeną, porządkuje wielkość liter i ukośnik końcowy', () => {
    expect(connectorAddress(' https://SMS.Firma.pl/ ')).toEqual({ ok: true, url: 'https://sms.firma.pl', host: 'sms.firma.pl' });
  });

  it('port 443 traktuje jak brak portu', () => {
    expect(connectorAddress('https://sms.firma.pl:443')).toEqual({ ok: true, url: 'https://sms.firma.pl', host: 'sms.firma.pl' });
  });

  it('odrzuca port inny niż 443: konektor jest sprawdzony na żywo tylko z portem 443', () => {
    const result = connectorAddress('https://sms.firma.pl:8443');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^Adres dla Power Automate nie może zawierać portu innego niż 443\./);
  });

  it.each([
    'http://sms.firma.pl', 'https://10.0.0.5', 'https://[2001:db8::1]', 'https://localhost', 'https://bramka',
    'https://sms.firma.pl/api', 'https://sms.firma.pl?x=1', 'https://sms.firma.pl#panel', 'https://a:b@sms.firma.pl',
    'sms.firma.pl', '', 'https://',
  ])('odrzuca %j komunikatem o adresie dla Power Automate', (raw) => {
    const result = connectorAddress(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^Adres dla Power Automate /);
      expect(result.error).toMatch(/artykuł „Power Automate”/);
    }
  });
});

/** Spacer po całym dokumencie: każdy obiekt z kluczem i ścieżką do niego. */
function walk(value: unknown, path: string, visit: (obj: Record<string, unknown>, path: string) => void): void {
  if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`, visit));
  else if (value !== null && typeof value === 'object') {
    visit(value as Record<string, unknown>, path);
    for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, visit);
  }
}

describe('buildPowerAutomateConnector', () => {
  const doc = buildPowerAutomateConnector('https://sms.firma.pl');
  const operations = new Map<string, SwaggerOperation & { method: string; path: string }>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) operations.set(op.operationId, { ...op, method, path });
  }
  const op = (id: string) => operations.get(id)!;
  const bodyOf = (id: string): SwaggerSchema => op(id).parameters!.find((p) => p.in === 'body')!.schema!;
  const resolve = (schema: SwaggerSchema): SwaggerSchema =>
    schema.$ref ? doc.definitions[schema.$ref.replace('#/definitions/', '')]! : schema;

  let routes: string[];
  beforeAll(async () => {
    routes = await apiServerRoutes();
  });

  it('jest dokumentem Swagger 2.0 dla adresu bramki', () => {
    expect(doc.swagger).toBe('2.0');
    expect(doc.host).toBe('sms.firma.pl');
    expect(doc.basePath).toBe('/');
    expect(doc.schemes).toEqual(['https']);
    expect(doc.consumes).toEqual(['application/json']);
    expect(doc.produces).toEqual(['application/json']);
    expect(doc.info.title).toBe(CONNECTOR_TITLE);
    expect(CONNECTOR_TITLE).toBe('Multiinfo Gate');
    expect(CONNECTOR_TITLE.length).toBeLessThanOrEqual(30);
    expect(doc.info.version).toBe(GATE_VERSION);
    expect(doc.info.description).toContain('https://sqlik.github.io/multiinfo-gate/power-automate/');
  });

  it('uwierzytelnia kluczem w nagłówku Authorization', () => {
    expect(doc.securityDefinitions).toEqual({ kluczApi: expect.objectContaining({ type: 'apiKey', in: 'header', name: 'Authorization' }) });
    expect(doc.security).toEqual([{ kluczApi: [] }]);
  });

  it('ma dokładnie stałe nazwy operacji, bo zapisane przepływy się do nich odwołują', () => {
    expect([...operations.keys()].sort()).toEqual([...CONNECTOR_OPERATIONS].sort());
    expect(CONNECTOR_OPERATIONS).toEqual(['WyslijSms', 'WyslijRozsylke', 'WyslijSmsDoGrupy', 'StanWiadomosci', 'StanRozsylki', 'RaportRozsylki', 'ListaIntegracji']);
  });

  it('każda operacja odpowiada trasie prawdziwego serwera', () => {
    for (const o of operations.values()) expect(routes, o.operationId).toContain(`${o.method} ${o.path}`);
  });

  it('nie ma grup SMS ani uprawnień klucza: grupy z panelu nie są dostępne z Power Automate', () => {
    for (const o of operations.values()) expect(o.path, o.operationId).not.toMatch(/^\/v1\/(groups|key)/);
    expect(routes.some((r) => r.includes('/v1/groups'))).toBe(false);
  });

  it('nie ma śladu OpenAPI 3', () => {
    const forbidden = ['openapi', 'servers', 'components', 'requestBody', 'oneOf', 'anyOf', 'allOf', 'nullable'];
    walk(doc, '$', (obj, path) => {
      for (const key of forbidden) expect(Object.hasOwn(obj, key), `${path}.${key}`).toBe(false);
    });
  });

  it('pole, które w API bywa null, nie ma typu: Power Automate odrzuca null przy podanym typie i nie zna x-nullable', () => {
    // Próba na żywo 2026-11-03: „Sprawdź stan wiadomości” kończyła się ResponseSwaggerSchemaValidationFailure,
    // bo inReplyTo przyszło jako null, a schemat podawał typ string. Sama flaga x-nullable tego nie zmienia.
    const schemas = buildOpenApiDocument().components.schemas as Record<string, JsonSchema>;
    const constraints = ['type', 'format', 'enum', 'pattern', 'minimum', 'maximum', 'minLength'] as const;
    const compare = (source: JsonSchema, target: SwaggerSchema, path: string): number => {
      let nullable = 0;
      if (source.nullable) nullable += 1;
      expect(target['x-nullable'], path).toBe(source.nullable ? true : undefined);
      if (source.nullable) for (const key of constraints) expect(target[key], `${path}.${key}`).toBeUndefined();
      else if (source.type) expect(target.type, path).toBe(source.type);
      if (source.items && target.items) nullable += compare(source.items, resolve(target.items), `${path}[]`);
      for (const [name, prop] of Object.entries(source.properties ?? {})) {
        if (prop.$ref || !target.properties?.[name]) continue;
        nullable += compare(prop, target.properties[name], `${path}.${name}`);
      }
      return nullable;
    };
    let total = 0;
    for (const name of ['Wiadomosc', 'Rozsylka', 'WierszRaportu']) total += compare(schemas[name]!, doc.definitions[name]!, name);
    expect(total).toBeGreaterThan(10);
    expect(doc.definitions.Wiadomosc!.properties!.inReplyTo!.type).toBeUndefined();
    expect(doc.definitions.Wiadomosc!.properties!.inReplyTo!['x-ms-summary']).toBe('Odpowiedź na wiadomość');
  });

  it('każde odwołanie prowadzi do istniejącej definicji', () => {
    walk(doc, '$', (obj, path) => {
      if (typeof obj.$ref !== 'string') return;
      expect(obj.$ref, path).toMatch(/^#\/definitions\//);
      expect(doc.definitions[obj.$ref.replace('#/definitions/', '')], path).toBeDefined();
    });
  });

  it('każda operacja ma nazwę i opis, każdy parametr miejsce i etykietę, najwyżej jedno body', () => {
    for (const o of operations.values()) {
      expect(o.summary, o.operationId).toBeTruthy();
      expect(o.description, o.operationId).toBeTruthy();
      expect(o.responses.default, o.operationId).toBeDefined();
      const params: SwaggerParameter[] = o.parameters ?? [];
      for (const p of params) {
        expect(p.in, `${o.operationId}.${p.name}`).toBeTruthy();
        expect(p['x-ms-summary'], `${o.operationId}.${p.name}`).toBeTruthy();
        expect(p.description, `${o.operationId}.${p.name}`).toBeTruthy();
        if (p.in !== 'body') expect(p.type, `${o.operationId}.${p.name}`).toBe('string');
      }
      expect(params.filter((p) => p.in === 'body').length, o.operationId).toBeLessThanOrEqual(1);
    }
  });

  it('każda właściwość body, odpowiedzi i definicji ma etykietę oraz opis', () => {
    walk(doc, '$', (obj, path) => {
      const props = obj.properties as Record<string, SwaggerSchema> | undefined;
      if (!props || typeof props !== 'object' || path.endsWith('.properties')) return;
      for (const [name, prop] of Object.entries(props)) {
        if (prop.$ref) continue;
        expect(prop['x-ms-summary'], `${path}.${name}`).toBeTruthy();
        expect(prop.description, `${path}.${name}`).toBeTruthy();
      }
    });
  });

  it('opisy dla autora przepływu: bez średników i potocznych słów, z pełną informacją o pustym polu', () => {
    walk(doc, '$', (obj, path) => {
      if (typeof obj.description !== 'string') return;
      expect(obj.description, path).not.toMatch(/;|\brusza\b|\bposzł|\bidzie\b|\bbierze\b|\bmyślnik/);
    });
    const recipient = resolve(bodyOf('WyslijRozsylke').properties!.recipients!.items!);
    expect(recipient.properties!.to!.description).toMatch(/Pusty albo nieprawidłowy numer na dowolnej pozycji odrzuca całą rozsyłkę/);
    expect(bodyOf('WyslijRozsylke').properties!.requestedBy!.description).toContain('przy wiadomości albo rozsyłce');
    expect(bodyOf('WyslijSms').properties!.to!.description).toContain('Spacje i łączniki są pomijane');
    expect(bodyOf('WyslijSms').properties!.text!.description).toMatch(/Puste pole kończy akcję błędem/);
    expect(bodyOf('WyslijRozsylke').properties!.startAt!.description).toMatch(/Puste pole oznacza wysyłkę od razu/);
    expect(bodyOf('WyslijSms').properties!.validTo!.description).toMatch(/Puste pole/);
  });

  it('pola wysyłki pochodzą ze schematów tras: żadne nie znika po cichu', () => {
    const covered = (id: string, shape: Record<string, unknown>, omitted: string[]) => {
      const props = Object.keys(bodyOf(id).properties!);
      for (const name of Object.keys(shape)) {
        if (omitted.includes(name)) expect(props, `${id}: ${name}`).not.toContain(name);
        else expect(props, `${id}: ${name}`).toContain(name);
      }
    };
    covered('WyslijSms', paMessageBodySchema.shape, CONNECTOR_OMITTED.WyslijSms!);
    covered('WyslijRozsylke', paPackageBodySchema.shape, CONNECTOR_OMITTED.WyslijRozsylke!);
    covered('WyslijSmsDoGrupy', paGroupBodySchema.shape, CONNECTOR_OMITTED.WyslijSmsDoGrupy!);
    expect(CONNECTOR_OMITTED).toEqual({ WyslijSms: [], WyslijRozsylke: [], WyslijSmsDoGrupy: [] });
  });

  it('w akcji „Wyślij SMS” numer odbiorcy to jeden numer, a numer i treść są wymagane i na wierzchu', () => {
    const body = bodyOf('WyslijSms');
    expect(body.properties!.to).toMatchObject({ type: 'string', 'x-ms-summary': 'Numer odbiorcy', 'x-ms-visibility': 'important' });
    expect(body.properties!.to!.description).toMatch(/[Pp]usty numer/);
    expect(body.properties!.text).toMatchObject({ 'x-ms-summary': 'Treść', 'x-ms-visibility': 'important' });
    expect(body.required).toEqual(['to', 'text']);
  });

  it('akcje wysyłające nie mają pól nadawcy ani usługi, a mają pole „Zlecający” na wierzchu', () => {
    for (const id of ['WyslijSms', 'WyslijRozsylke', 'WyslijSmsDoGrupy']) {
      const props = bodyOf(id).properties!;
      expect(props.orig, id).toBeUndefined();
      expect(props.serviceId, id).toBeUndefined();
      expect(props.requestedBy, id).toMatchObject({ type: 'string', 'x-ms-summary': 'Zlecający', 'x-ms-visibility': 'important' });
      expect(props.requestedBy!.description, id).toMatch(/Nie trafia do treści SMS-a/);
    }
  });

  it('„Wyślij SMS do grupy” nie ma numeru odbiorcy: odbiorców wyznacza lista integracji', () => {
    expect(bodyOf('WyslijSmsDoGrupy').properties!.to).toBeUndefined();
    expect(op('WyslijSmsDoGrupy').parameters!.some((p) => p.name === 'to')).toBe(false);
  });

  it('kodowanie ma polskie nazwy wartości', () => {
    expect(bodyOf('WyslijSms').properties!.encoding!['x-ms-enum-values']).toEqual([
      { value: 'auto', displayName: 'Automatyczne' },
      { value: 'gsm', displayName: 'GSM, bez polskich znaków' },
      { value: 'unicode', displayName: 'Unicode' },
    ]);
  });

  it('pierwszym polem każdej akcji wysyłającej jest „Integracja” z listy integracji klucza', () => {
    for (const id of ['WyslijSms', 'WyslijRozsylke', 'WyslijSmsDoGrupy']) {
      const first = op(id).parameters![0]!;
      expect(first, id).toMatchObject({
        name: 'id', in: 'path', required: true, type: 'string', 'x-ms-summary': 'Integracja', 'x-ms-visibility': 'important',
      });
      expect(first['x-ms-dynamic-values'], id).toEqual({
        operationId: 'ListaIntegracji', 'value-collection': 'data', 'value-path': 'id', 'value-title': 'name',
      });
      expect(first.description, id).toContain('Integracja z Power Automate');
      expect(op(id).path, id).toMatch(/^\/v1\/integrations\/\{id\}\//);
    }
    expect(op('WyslijSmsDoGrupy').parameters![0]!.description).toContain('każdego numeru z listy odbiorców');
    expect(op('WyslijSms').parameters![0]!.description).not.toContain('każdego numeru z listy odbiorców');
    expect(op('ListaIntegracji')).toMatchObject({ method: 'get', path: '/v1/integrations', 'x-ms-visibility': 'internal' });
    walk(doc, '$', (obj, path) => {
      const dyn = obj['x-ms-dynamic-values'] as { operationId: string } | undefined;
      if (dyn) expect(operations.has(dyn.operationId), path).toBe(true);
    });
  });

  it('rozsyłka przyjmuje listę odbiorców z własną treścią i identyfikatorem', () => {
    const body = bodyOf('WyslijRozsylke');
    expect(body.required).toEqual(['recipients']);
    const recipients = body.properties!.recipients!;
    expect(recipients).toMatchObject({ type: 'array', 'x-ms-summary': 'Odbiorcy', 'x-ms-visibility': 'important' });
    expect(recipients.items!.required).toEqual(['to']);
    expect(Object.keys(recipients.items!.properties!).sort()).toEqual(['clientId', 'text', 'to']);
    expect(body.properties!.defaultText).toMatchObject({ 'x-ms-summary': 'Treść wspólna', 'x-ms-visibility': 'important' });
  });

  it('klucz idempotencji jest nagłówkiem w ustawieniach zaawansowanych wysyłek', () => {
    for (const id of ['WyslijSms', 'WyslijSmsDoGrupy', 'WyslijRozsylke']) {
      const header = op(id).parameters!.find((p) => p.in === 'header')!;
      expect(header, id).toMatchObject({ name: 'Idempotency-Key', type: 'string', required: false, 'x-ms-visibility': 'advanced' });
    }
  });

  it('sukces wysyłek opisuje odpowiedź 200 bez nagłówka Location: projektant Power Automate pomija 202', () => {
    // Bramka odpowiada 202. Projektant bierze pola akcji tylko z odpowiedzi 200 albo default,
    // więc przy 202 podsuwał pola błędu zamiast identyfikatora (próba na żywo 2026-11-03).
    for (const id of ['WyslijSms', 'WyslijRozsylke', 'WyslijSmsDoGrupy']) {
      expect(op(id).responses['202'], id).toBeUndefined();
      const accepted = op(id).responses['200']!;
      expect(accepted.schema, id).toBeDefined();
      expect(accepted.headers, id).toBeUndefined();
    }
    expect(resolve(op('WyslijSms').responses['200']!.schema!).properties!.id!['x-ms-summary']).toBe('Identyfikator wiadomości');
  });

  it('stan wiadomości wymienia znaczenie każdej wartości stanu po polsku', () => {
    const status = resolve(op('StanWiadomosci').responses['200']!.schema!).properties!.status!;
    for (const value of ['queued', 'sent', 'delivered', 'failed', 'expired', 'cancelled', 'blocked', 'throttled', 'unknown']) {
      expect(status.description, value).toContain(`${value} -`);
    }
  });

  it('raport rozsyłki opisuje odpowiedź 409 dla raportu, który nie jest gotowy', () => {
    const notReady = op('RaportRozsylki').responses['409']!;
    expect(notReady.description).toMatch(/report_not_ready/);
    expect(op('RaportRozsylki').description).toMatch(/409/);
  });

  it('nie zawiera sekretów, ma postać zwykłych nagłówków i mieści się w limicie Microsoftu', () => {
    const text = JSON.stringify(doc);
    expect(text).not.toContain('mig_live_');
    expect(text).not.toContain('Bearer ');
    expect(Buffer.byteLength(JSON.stringify(doc, null, 2))).toBeLessThan(1_048_576);
    walk(doc, '$', (obj) => {
      if (obj.in === 'header') expect(String(obj.name)).toMatch(/^[\x21-\x7e]+$/);
    });
  });

  it('odmawia zbudowania pliku dla adresu z portem innym niż 443', () => {
    expect(() => buildPowerAutomateConnector('https://sms.firma.pl:8443')).toThrow(/portu innego niż 443/);
  });

  it('odmawia zbudowania pliku dla adresu, którego Power Automate nie użyje', () => {
    expect(() => buildPowerAutomateConnector('http://10.0.0.5:8080')).toThrow(/Adres dla Power Automate/);
  });
});
