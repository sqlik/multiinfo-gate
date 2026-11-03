import { beforeAll, describe, expect, it } from 'vitest';
import { groupMessageBodySchema } from '../../src/api/groups.ts';
import { messageBodySchema } from '../../src/api/messages.ts';
import { packageBodySchema } from '../../src/api/packages.ts';
import {
  CONNECTOR_OMITTED, CONNECTOR_OPERATIONS, CONNECTOR_TITLE, buildPowerAutomateConnector, connectorAddress,
  type SwaggerOperation, type SwaggerParameter, type SwaggerSchema,
} from '../../src/api/power-automate.ts';
import { GATE_VERSION } from '../../src/version.ts';
import { apiServerRoutes } from '../helpers/routes.ts';

describe('connectorAddress', () => {
  it('przyjmuje adres https z domeną, porządkuje wielkość liter i ukośnik końcowy', () => {
    expect(connectorAddress(' https://SMS.Firma.pl/ ')).toEqual({ ok: true, url: 'https://sms.firma.pl', host: 'sms.firma.pl', port: null });
  });

  it('port 443 traktuje jak brak portu', () => {
    expect(connectorAddress('https://sms.firma.pl:443')).toMatchObject({ ok: true, url: 'https://sms.firma.pl', port: null });
  });

  it('inny port zostaje w adresie i w nazwie hosta', () => {
    expect(connectorAddress('https://sms.firma.pl:8443')).toEqual({
      ok: true, url: 'https://sms.firma.pl:8443', host: 'sms.firma.pl:8443', port: 8443,
    });
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
  });

  it('każda operacja odpowiada trasie prawdziwego serwera', () => {
    for (const o of operations.values()) expect(routes, o.operationId).toContain(`${o.method} ${o.path}`);
  });

  it('nie ma śladu OpenAPI 3', () => {
    const forbidden = ['openapi', 'servers', 'components', 'requestBody', 'oneOf', 'anyOf', 'allOf', 'nullable'];
    walk(doc, '$', (obj, path) => {
      for (const key of forbidden) expect(Object.hasOwn(obj, key), `${path}.${key}`).toBe(false);
    });
  });

  it('każde odwołanie prowadzi do istniejącej definicji', () => {
    walk(doc, '$', (obj, path) => {
      if (typeof obj.$ref !== 'string') return;
      expect(obj.$ref, path).toMatch(/^#\/definitions\//);
      expect(doc.definitions[obj.$ref.replace('#/definitions/', '')], path).toBeDefined();
    });
  });

  it('każda operacja ma nazwę i opis, każdy parametr miejsce i etykietę, najwyżej jedno ciało', () => {
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

  it('każda właściwość ciała, odpowiedzi i definicji ma etykietę oraz opis', () => {
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

  it('pola wysyłki pochodzą ze schematów tras: żadne nie znika po cichu', () => {
    const covered = (id: string, shape: Record<string, unknown>, omitted: string[]) => {
      const props = Object.keys(bodyOf(id).properties!);
      for (const name of Object.keys(shape)) {
        if (omitted.includes(name)) expect(props, `${id}: ${name}`).not.toContain(name);
        else expect(props, `${id}: ${name}`).toContain(name);
      }
    };
    covered('WyslijSms', messageBodySchema.shape, CONNECTOR_OMITTED.WyslijSms!);
    covered('WyslijRozsylke', packageBodySchema.shape, CONNECTOR_OMITTED.WyslijRozsylke ?? []);
    covered('WyslijSmsDoGrupy', groupMessageBodySchema.shape, CONNECTOR_OMITTED.WyslijSmsDoGrupy!);
  });

  it('w akcji „Wyślij SMS” numer odbiorcy to jeden numer, a numer i treść są wymagane i na wierzchu', () => {
    const body = bodyOf('WyslijSms');
    expect(body.properties!.to).toMatchObject({ type: 'string', 'x-ms-summary': 'Numer odbiorcy', 'x-ms-visibility': 'important' });
    expect(body.properties!.text).toMatchObject({ 'x-ms-summary': 'Treść', 'x-ms-visibility': 'important' });
    expect(body.required).toEqual(['to', 'text']);
    expect(body.properties!.serviceId).toMatchObject({ type: 'string', 'x-ms-visibility': 'advanced' });
    expect(body.properties!.orig!['x-ms-visibility']).toBeUndefined();
  });

  it('kodowanie ma polskie nazwy wartości', () => {
    expect(bodyOf('WyslijSms').properties!.encoding!['x-ms-enum-values']).toEqual([
      { value: 'auto', displayName: 'Automatyczne' },
      { value: 'gsm', displayName: 'GSM, bez polskich znaków' },
      { value: 'unicode', displayName: 'Unicode' },
    ]);
  });

  it('nadawca, usługa i grupa to listy wyboru z operacji wewnętrznych', () => {
    for (const id of ['WyslijSms', 'WyslijRozsylke', 'WyslijSmsDoGrupy']) {
      expect(bodyOf(id).properties!.orig!['x-ms-dynamic-values'], id).toEqual({
        operationId: 'UprawnieniaKlucza', 'value-collection': 'origs', 'value-path': 'orig', 'value-title': 'orig',
      });
    }
    for (const id of ['WyslijSms', 'WyslijRozsylke']) {
      expect(bodyOf(id).properties!.serviceId!['x-ms-dynamic-values'], id).toEqual({
        operationId: 'UprawnieniaKlucza', 'value-collection': 'services', 'value-path': 'id', 'value-title': 'id',
      });
    }
    const group = op('WyslijSmsDoGrupy').parameters!.find((p) => p.in === 'path')!;
    expect(group).toMatchObject({ name: 'id', required: true, 'x-ms-summary': 'Grupa', 'x-ms-visibility': 'important' });
    expect(group['x-ms-dynamic-values']).toEqual({ operationId: 'ListaGrup', 'value-collection': 'data', 'value-path': 'id', 'value-title': 'name' });
    expect(op('UprawnieniaKlucza')['x-ms-visibility']).toBe('internal');
    expect(op('ListaGrup')['x-ms-visibility']).toBe('internal');
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
    for (const id of ['WyslijSms', 'WyslijSmsDoGrupy']) {
      const header = op(id).parameters!.find((p) => p.in === 'header')!;
      expect(header, id).toMatchObject({ name: 'Idempotency-Key', type: 'string', required: false, 'x-ms-visibility': 'advanced' });
    }
  });

  it('wysyłki odpowiadają 202 bez nagłówka Location, żeby akcja kończyła się od razu', () => {
    for (const id of ['WyslijSms', 'WyslijRozsylke', 'WyslijSmsDoGrupy']) {
      const accepted = op(id).responses['202']!;
      expect(accepted.schema, id).toBeDefined();
      expect(accepted.headers, id).toBeUndefined();
    }
    expect(resolve(op('WyslijSms').responses['202']!.schema!).properties!.id!['x-ms-summary']).toBeTruthy();
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

  it('adres z portem trafia do pola host', () => {
    expect(buildPowerAutomateConnector('https://sms.firma.pl:8443').host).toBe('sms.firma.pl:8443');
  });

  it('odmawia zbudowania pliku dla adresu, którego Power Automate nie użyje', () => {
    expect(() => buildPowerAutomateConnector('http://10.0.0.5:8080')).toThrow(/Adres dla Power Automate/);
  });
});
