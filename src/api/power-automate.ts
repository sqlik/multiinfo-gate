import { isIP } from 'node:net';
import { GATE_VERSION } from '../version.ts';
import { buildOpenApiDocument, type JsonSchema, type OpenApiDocument } from './openapi.ts';

/**
 * Plik konektora Power Automate dla jednej bramki. Power Automate czyta wyłącznie Swaggera 2.0,
 * a adres serwera ma w pliku na stałe, więc panel buduje plik z adresem podanym przez
 * administratora. Opisy pól i odpowiedzi pochodzą z opisu API (`openapi.ts`), żeby konektor
 * i dokumentacja mówiły to samo. Tu dochodzą tylko rzeczy właściwe dla Power Automate: krótkie
 * etykiety pól (`x-ms-summary`), widoczność, listy wyboru i polskie nazwy wartości.
 *
 * Każda akcja wysyłająca przechodzi przez integrację z Power Automate (`/v1/integrations/{id}/...`),
 * więc z przepływu nie ma drogi do wysyłki bez dziennika, limitu części i ochrony przed burzą.
 * Jeden plik obsługuje wszystkie integracje: integrację wybiera się w akcji.
 */

/** Nazwa konektora: bez nazw produktów Power Platform, najwyżej 30 znaków (wymóg certyfikacji). */
export const CONNECTOR_TITLE = 'Multiinfo Gate';

/** Adres artykułu, do którego odsyłają plik, panel i komunikaty. */
export const CONNECTOR_ARTICLE = 'https://sqlik.github.io/multiinfo-gate/power-automate/';

/**
 * Stałe nazwy operacji. Zapisane przepływy odwołują się do nich, więc nie zależą od wersji
 * bramki: nowszy plik konektora nie psuje istniejących przepływów.
 */
export const CONNECTOR_OPERATIONS = [
  'WyslijSms', 'WyslijRozsylke', 'WyslijSmsDoGrupy', 'StanWiadomosci', 'StanRozsylki', 'RaportRozsylki', 'ListaIntegracji',
] as const;

/**
 * Pola schematów wywołań integracji świadomie pominięte w konektorze. Dziś żadne: usługę, nadpis
 * i limit części wyznacza integracja, więc schematy wywołań już ich nie zawierają.
 */
export const CONNECTOR_OMITTED: Record<string, string[]> = {
  WyslijSms: [],
  WyslijRozsylke: [],
  WyslijSmsDoGrupy: [],
};

export interface SwaggerSchema {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: SwaggerSchema;
  properties?: Record<string, SwaggerSchema>;
  required?: string[];
  /** Pole bywa null. Opis dla narzędzi Swaggera; Power Automate tę flagę pomija, dlatego takie pole nie ma typu. */
  'x-nullable'?: boolean;
  'x-ms-summary'?: string;
  'x-ms-visibility'?: Visibility;
  'x-ms-dynamic-values'?: DynamicValues;
  'x-ms-enum-values'?: Array<{ value: string; displayName: string }>;
}

type Visibility = 'important' | 'advanced' | 'internal';

interface DynamicValues {
  operationId: (typeof CONNECTOR_OPERATIONS)[number];
  'value-collection': string;
  'value-path': string;
  'value-title': string;
}

export interface SwaggerParameter {
  name: string;
  in: 'body' | 'path' | 'header';
  required: boolean;
  description: string;
  'x-ms-summary': string;
  'x-ms-visibility'?: Visibility;
  'x-ms-dynamic-values'?: DynamicValues;
  type?: string;
  schema?: SwaggerSchema;
}

export interface SwaggerResponse {
  description: string;
  schema?: SwaggerSchema;
  headers?: Record<string, unknown>;
}

export interface SwaggerOperation {
  operationId: (typeof CONNECTOR_OPERATIONS)[number];
  summary: string;
  description: string;
  'x-ms-visibility'?: Visibility;
  parameters?: SwaggerParameter[];
  responses: Record<string, SwaggerResponse>;
}

export interface SwaggerDocument {
  swagger: '2.0';
  info: { title: string; version: string; description: string };
  host: string;
  basePath: '/';
  schemes: ['https'];
  consumes: ['application/json'];
  produces: ['application/json'];
  paths: Record<string, Partial<Record<'get' | 'post', SwaggerOperation>>>;
  definitions: Record<string, SwaggerSchema>;
  securityDefinitions: Record<string, { type: 'apiKey'; in: 'header'; name: string; description: string }>;
  security: Array<Record<string, string[]>>;
  'x-ms-connector-metadata': Array<{ propertyName: string; propertyValue: string }>;
}

export type ConnectorAddress =
  | { ok: true; url: string; host: string }
  | { ok: false; error: string };

const ADDRESS_HELP = 'Wymagania opisuje artykuł „Power Automate” w dokumentacji bramki.';

/**
 * Publiczny adres bramki dla pliku konektora. Power Automate łączy się z chmury Microsoftu, więc
 * adres musi być `https://` z domeną: certyfikat publiczny wystawia się na domenę, a adres IP albo
 * nazwa bez kropki z internetu nie działa. Ścieżka nie wchodzi w grę, bo plik ma `basePath: /`.
 */
export function connectorAddress(raw: string): ConnectorAddress {
  const fail = (reason: string): ConnectorAddress => ({ ok: false, error: `Adres dla Power Automate ${reason} ${ADDRESS_HELP}` });
  const text = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('jest nieprawidłowy. Wpisz go w postaci https://sms.firma.pl.');
  }
  if (url.protocol !== 'https:') {
    return fail('musi zaczynać się od https://. Power Automate łączy się z bramką z chmury Microsoftu i wymaga'
      + ' połączenia szyfrowanego z certyfikatem wystawionym przez publiczny urząd.');
  }
  if (url.username !== '' || url.password !== '') return fail('nie może zawierać nazwy użytkownika ani hasła.');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return fail('to sam adres bramki, bez ścieżki i parametrów, na przykład https://sms.firma.pl.');
  }
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname.replace(/^\[|\]$/g, '')) !== 0) {
    return fail('musi zawierać domenę dostępną z internetu, a nie adres IP. Certyfikat publiczny wystawia się na domenę.');
  }
  if (!hostname.includes('.')) {
    return fail('musi zawierać pełną domenę dostępną z internetu, na przykład sms.firma.pl.');
  }
  // URL pomija port domyślny 443, więc pusty port znaczy 443. Konektor sprawdzono na żywo tylko z tym portem.
  if (url.port !== '') {
    return fail('nie może zawierać portu innego niż 443. Udostępnij bramkę z internetu na porcie 443, na przykład'
      + ' przez serwer pośredniczący Traefik.');
  }
  return { ok: true, url: `https://${hostname}`, host: hostname };
}

/** Etykiety według ścieżki pola; gdy ścieżki nie ma, etykieta według nazwy pola. */
const LABELS_BY_PATH: Record<string, string> = {
  'WyslijRozsylke.recipients': 'Odbiorcy',
  'WyslijRozsylke.recipients[].to': 'Numer',
  'WyslijRozsylke.recipients[].text': 'Treść dla tego odbiorcy',
  'WyslijRozsylke.recipients[].clientId': 'Identyfikator',
  'PrzyjetaWiadomosc.id': 'Identyfikator wiadomości',
  'PrzyjetaWiadomosc.status': 'Stan wiadomości',
  'Wiadomosc.id': 'Identyfikator wiadomości',
  'Wiadomosc.status': 'Stan wiadomości',
  'PrzyjetaRozsylka.id': 'Identyfikator rozsyłki',
  'PrzyjetaRozsylka.status': 'Stan rozsyłki',
  'Rozsylka.id': 'Identyfikator rozsyłki',
  'Rozsylka.status': 'Stan rozsyłki',
  'Rozsylka.report.status': 'Stan raportu',
  'RaportRozsylki.id': 'Identyfikator rozsyłki',
  'RaportRozsylki.report.status': 'Stan raportu',
  'BladRaportu.report.status': 'Stan raportu',
  'WierszRaportu.status': 'Stan wiadomości',
  'WysylkaDoGrupy.integration.id': 'Identyfikator integracji',
  'WysylkaDoGrupy.integration.name': 'Nazwa integracji',
  'WysylkaDoGrupy.messages[].id': 'Identyfikator wiadomości',
  'WysylkaDoGrupy.messages[].status': 'Stan wiadomości',
  'IntegracjaPowerAutomate.id': 'Identyfikator integracji',
  'IntegracjaPowerAutomate.name': 'Nazwa integracji',
  'IntegracjaPowerAutomate.recipients': 'Liczba odbiorców grupy',
};

const LABELS_BY_NAME: Record<string, string> = {
  to: 'Numer odbiorcy',
  text: 'Treść',
  orig: 'Nadawca',
  serviceId: 'Usługa Multiinfo',
  encoding: 'Kodowanie',
  maxParts: 'Najwyżej części',
  deliveryReport: 'Raport doręczenia',
  validTo: 'Ważna do',
  costCenter: 'Znacznik rozliczeń',
  defaultText: 'Treść wspólna',
  startAt: 'Początek wysyłki',
  id: 'Identyfikator',
  status: 'Stan',
  parts: 'Liczba części',
  characters: 'Liczba znaków',
  slots: 'Zajęte miejsca',
  slotsRemaining: 'Wolne miejsca w ostatniej części',
  inReplyTo: 'Odpowiedź na wiadomość',
  createdAt: 'Czas przyjęcia',
  sentAt: 'Czas wysłania',
  finalAt: 'Czas stanu ostatecznego',
  providerCode: 'Kod Multiinfo',
  error: 'Błąd',
  recipients: 'Liczba odbiorców',
  remaining: 'Pozostało do wysłania',
  multipart: 'Wieloczęściowa',
  completedAt: 'Czas zakończenia',
  report: 'Raport',
  expiresAt: 'Raport dostępny do',
  summary: 'Podsumowanie doręczeń',
  delivered: 'Doręczone',
  failed: 'Niedoręczone',
  other: 'Pozostałe',
  clientId: 'Identyfikator odbiorcy',
  miId: 'Identyfikator w Multiinfo',
  miStatus: 'Kod stanu Multiinfo',
  changedAt: 'Czas zmiany stanu',
  rows: 'Odbiorcy',
  name: 'Nazwa',
  data: 'Integracje',
  integration: 'Integracja',
  requestedBy: 'Zlecający',
  messages: 'Wiadomości',
  code: 'Kod błędu',
  message: 'Komunikat',
};

/**
 * Opisy pisane dla użytkownika przepływu tam, gdzie opis dla programisty mówi o wartościach
 * JSON-a albo o polu pominiętym, a Power Automate pokazuje listę albo puste pole.
 */
const DESCRIPTIONS_BY_PATH: Record<string, string> = {
  'WyslijSms.to': 'Jeden numer telefonu, na przykład 48601000001. Numer bez kodu kraju otrzymuje kod domyślny konta,'
    + ' dla Polski 48. Spacje i łączniki są pomijane. Pusty numer kończy akcję błędem. Akcja nie wysyła wtedy SMS-a'
    + ' do listy odbiorców integracji',
  text: 'Treść SMS-a. Polskie znaki są dozwolone, ale skracają jedną część do 70 znaków. Treść dłuższą niż limit części'
    + ' integracja skraca albo odrzuca, zależnie od ustawienia w panelu bramki. Puste pole kończy akcję błędem',
  validTo: 'Czas ważności w formacie ISO 8601, na przykład 2026-11-04T18:00:00Z, najwyżej 72 godziny od przyjęcia.'
    + ' Wiadomość niedoręczona do tego czasu otrzymuje stan expired. Puste pole oznacza, że bramka nie ustawia czasu'
    + ' ważności',
  startAt: 'Termin rozpoczęcia rozsyłki w formacie ISO 8601, na przykład 2026-11-04T07:00:00Z. Termin musi przypadać'
    + ' w przyszłości. Puste pole oznacza wysyłkę od razu',
  requestedBy: 'Kto zlecił wysyłkę, na przykład adres e-mail osoby z formularza albo autora wpisu na liście SharePoint.'
    + ' Bramka zapisuje go w dzienniku integracji oraz przy wiadomości albo rozsyłce. Nie trafia do treści SMS-a',
  encoding: 'Automatyczne wybiera GSM-7, a przy polskich znakach Unicode. Przy GSM Multiinfo zastępuje polskie znaki'
    + ' łacińskimi odpowiednikami. Unicode zawsze koduje treść w UCS-2',
  deliveryReport: 'Wartość „Nie” oznacza rezygnację z raportu doręczenia. Stan wiadomości kończy się wtedy na sent',
  'WyslijRozsylke.recipients': 'Lista odbiorców, od 1 do 5000 pozycji. Pozycje wpisuje się po kolei albo podaje całą'
    + ' listę z akcji „Wybierz”',
  'WyslijRozsylke.recipients[].to': 'Numer telefonu odbiorcy, na przykład 48601000001. Numer bez kodu kraju otrzymuje'
    + ' kod domyślny konta, dla Polski 48. Pusty albo nieprawidłowy numer na dowolnej pozycji odrzuca całą rozsyłkę',
  'WyslijRozsylke.recipients[].text': 'Treść dla tego odbiorcy. Puste pole oznacza treść wspólną rozsyłki',
  'WyslijRozsylke.recipients[].clientId': 'Własny identyfikator odbiorcy, na przykład numer zlecenia. Od 1 do 20'
    + ' znaków: litery bez polskich znaków, cyfry, kropka, podkreślenie i łącznik. Wraca w raporcie rozsyłki',
  'Wiadomosc.status': 'Stan wiadomości: queued - w kolejce, sent - przekazana do sieci, delivered - doręczona,'
    + ' failed - niedoręczona, przyczynę podaje opis błędu, expired - upłynęła ważność bez doręczenia, cancelled -'
    + ' anulowana, blocked - numer na liście blokad operatora, throttled - wstrzymana limitem operatora, unknown -'
    + ' stan spoza dokumentacji Multiinfo. Stany delivered, failed, expired, cancelled i blocked są ostateczne',
};

/** Widoczność pól wysyłek: na wierzchu, pod „Pokaż opcje zaawansowane” albo domyślna. */
const VISIBILITY: Record<string, Visibility> = {
  to: 'important',
  text: 'important',
  recipients: 'important',
  defaultText: 'important',
  requestedBy: 'important',
  encoding: 'advanced',
  deliveryReport: 'advanced',
  validTo: 'advanced',
  costCenter: 'advanced',
  startAt: 'advanced',
};

const ENCODING_NAMES = [
  { value: 'auto', displayName: 'Automatyczne' },
  { value: 'gsm', displayName: 'GSM, bez polskich znaków' },
  { value: 'unicode', displayName: 'Unicode' },
];

const INTEGRATION_LIST: DynamicValues = {
  operationId: 'ListaIntegracji', 'value-collection': 'data', 'value-path': 'id', 'value-title': 'name',
};

const SIMPLE_KEYS = ['type', 'format', 'enum', 'default', 'pattern', 'minimum', 'maximum', 'minLength', 'minItems', 'maxItems'] as const;

/**
 * Schemat OpenAPI 3.0 w postaci Swaggera 2.0. Wariant `oneOf` sprowadza się do pierwszego (napis),
 * bo konektor podaje jeden numer i jedną usługę. Swagger 2.0 nie zna `nullable`. Power Automate sprawdza każdą
 * odpowiedź ze schematem, odrzuca null przy podanym typie i pomija `x-nullable`. Pole odpowiedzi, które bywa null,
 * nie ma więc typu ani ograniczeń; `x-nullable` zostaje jako opis dla innych narzędzi.
 * Każde pole otrzymuje etykietę i opis. Brak któregoś przerywa budowanie, tak jak w `openapi.ts`.
 */
function convert(schema: JsonSchema, path: string, request: boolean): SwaggerSchema {
  if (schema.$ref) return { $ref: schema.$ref.replace('#/components/schemas/', '#/definitions/') };
  const { oneOf, ...rest } = schema;
  const source: JsonSchema = oneOf ? { ...oneOf[0], ...rest } : rest;
  const out: SwaggerSchema = {};
  const untyped = Boolean(source.nullable) && !request;
  for (const key of untyped ? [] : SIMPLE_KEYS) {
    if (source[key] !== undefined) (out as Record<string, unknown>)[key] = source[key];
  }
  if (source.nullable) out['x-nullable'] = true;
  if (source.items) out.items = convert(source.items, `${path}[]`, request);
  if (source.properties) {
    out.properties = {};
    for (const [name, prop] of Object.entries(source.properties)) {
      out.properties[name] = decorate(convert(prop, `${path}.${name}`, request), `${path}.${name}`, name, prop, request);
    }
    const required = (source.required ?? []).filter((name) => name in source.properties!);
    if (required.length > 0) out.required = required;
  }
  return out;
}

function decorate(converted: SwaggerSchema, path: string, name: string, source: JsonSchema, request: boolean): SwaggerSchema {
  if (converted.$ref) return converted;
  const label = LABELS_BY_PATH[path] ?? LABELS_BY_NAME[name];
  const description = DESCRIPTIONS_BY_PATH[path] ?? (request ? DESCRIPTIONS_BY_PATH[name] : undefined) ?? source.description;
  if (!label) throw new Error(`Pole ${path} nie ma etykiety w src/api/power-automate.ts`);
  if (!description) throw new Error(`Pole ${path} nie ma opisu`);
  const out: SwaggerSchema = { ...converted, 'x-ms-summary': label, description };
  if (request) {
    const nested = path.includes('[]');
    const visibility = nested ? undefined : VISIBILITY[name];
    if (visibility) out['x-ms-visibility'] = visibility;
    if (name === 'encoding') out['x-ms-enum-values'] = ENCODING_NAMES;
  }
  return out;
}

/** Schemat body żądania bez pól pominiętych w konektorze. */
function requestBody(schema: JsonSchema, operationId: string): SwaggerSchema {
  const omitted = CONNECTOR_OMITTED[operationId] ?? [];
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([name]) => !omitted.includes(name)));
  return convert({ ...schema, properties }, operationId, true);
}

function jsonSchemaOf(content: Record<string, { schema: JsonSchema }> | undefined): JsonSchema {
  const schema = content?.['application/json']?.schema;
  if (!schema) throw new Error('Opis API nie ma schematu JSON tam, gdzie konektor go potrzebuje');
  return schema;
}

/** Fragmenty opisu API, z których powstaje plik: body żądań i schematy odpowiedzi. */
function apiParts(api: OpenApiDocument) {
  const op = (path: string, method: 'get' | 'post') => {
    const found = api.paths[path]?.[method];
    if (!found) throw new Error(`Opis API nie zna ${method.toUpperCase()} ${path}`);
    return found;
  };
  const report409 = jsonSchemaOf(op('/v1/packages/{id}/report', 'get').responses['409']?.content);
  const schemas = api.components.schemas;
  return {
    messageBody: jsonSchemaOf(op('/v1/integrations/{id}/messages', 'post').requestBody?.content),
    packageBody: jsonSchemaOf(op('/v1/integrations/{id}/packages', 'post').requestBody?.content),
    groupBody: jsonSchemaOf(op('/v1/integrations/{id}/group', 'post').requestBody?.content),
    definitions: {
      PrzyjetaWiadomosc: jsonSchemaOf(op('/v1/integrations/{id}/messages', 'post').responses['202']?.content),
      Wiadomosc: schemas.Wiadomosc!,
      PrzyjetaRozsylka: jsonSchemaOf(op('/v1/integrations/{id}/packages', 'post').responses['202']?.content),
      Rozsylka: schemas.Rozsylka!,
      RaportRozsylki: jsonSchemaOf(op('/v1/packages/{id}/report', 'get').responses['200']?.content),
      WierszRaportu: schemas.WierszRaportu!,
      WysylkaDoGrupy: schemas.WysylkaDoGrupy!,
      ListaIntegracji: jsonSchemaOf(op('/v1/integrations', 'get').responses['200']?.content),
      IntegracjaPowerAutomate: schemas.IntegracjaPowerAutomate!,
      Blad: schemas.Blad!,
      OdpowiedzBledu: schemas.OdpowiedzBledu!,
      BladRaportu: report409.$ref ? schemas[report409.$ref.replace('#/components/schemas/', '')]! : report409,
    } satisfies Record<string, JsonSchema>,
  };
}

const ref = (name: string): SwaggerSchema => ({ $ref: `#/definitions/${name}` });

const ERROR: SwaggerResponse = {
  description: 'Błąd bramki. Kod błędu i komunikat po polsku są w polach error.code i error.message',
  schema: ref('OdpowiedzBledu'),
};

const IDEMPOTENCY: SwaggerParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  type: 'string',
  'x-ms-summary': 'Klucz idempotencji',
  'x-ms-visibility': 'advanced',
  description: 'Własny klucz powtórzenia, na przykład numer zlecenia. Ponowione wywołanie z tym samym kluczem i tymi'
    + ' samymi danymi zwraca pierwotną odpowiedź zamiast wysyłać SMS albo rozsyłkę drugi raz. Przydaje się, gdy'
    + ' przepływ ponawia akcję',
};

const pathId = (summary: string, description: string, extra: Partial<SwaggerParameter> = {}): SwaggerParameter => ({
  name: 'id', in: 'path', required: true, type: 'string', 'x-ms-summary': summary, description, ...extra,
});

const body = (summary: string, description: string, schema: SwaggerSchema): SwaggerParameter => ({
  name: 'body', in: 'body', required: true, 'x-ms-summary': summary, description, schema,
});

/** Pole „Integracja”: pierwsze w każdej akcji wysyłającej, z listą integracji klucza. */
const integrationParam = (description: string): SwaggerParameter =>
  pathId('Integracja', description, { 'x-ms-visibility': 'important', 'x-ms-dynamic-values': INTEGRATION_LIST });

const INTEGRATION_FOR_SENDING = 'Integracja z Power Automate skonfigurowana w panelu bramki Multiinfo Gate. Wyznacza nadawcę SMS-a,'
  + ' usługę Multiinfo, limit długości wiadomości i ochronę przed nadmiarem wysyłek. Integracje zakłada administrator bramki';

const INTEGRATION_FOR_GROUP = 'Integracja z Power Automate skonfigurowana w panelu bramki Multiinfo Gate. SMS trafi do każdego numeru'
  + ' z listy odbiorców tej integracji. Listę prowadzi administrator bramki w szczegółach integracji, więc zmiana składu'
  + ' ekipy nie wymaga zmiany przepływu. Gdy lista jest pusta, akcja kończy się błędem';

/**
 * Odpowiedzi błędów wspólne dla akcji wysyłających: integracja, wyłączenie, ochrona przed burzą.
 *
 * Przyjęcie wysyłki plik konektora opisuje jako 200, choć bramka odpowiada 202. Projektant Power Automate
 * odczytuje pola akcji tylko z odpowiedzi 200 albo default, więc przy 202 nie podsuwał identyfikatora.
 * Odpowiedź bez nagłówka Location kończy akcję od razu niezależnie od kodu.
 */
const SENDING_ERRORS: Record<string, SwaggerResponse> = {
  '404': {
    description: 'Nie ma takiej integracji z Power Automate dla tego klucza: integration_not_found',
    schema: ref('OdpowiedzBledu'),
  },
  '429': {
    description: 'Integracja przekroczyła limit wysyłek (ochrona przed burzą): integration_throttled. Limit zmienia'
      + ' administrator bramki w ustawieniach integracji',
    schema: ref('OdpowiedzBledu'),
  },
  default: ERROR,
};

/** Plik konektora dla adresu bramki; adres, którego Power Automate nie użyje, przerywa budowanie. */
export function buildPowerAutomateConnector(address: string): SwaggerDocument {
  const checked = connectorAddress(address);
  if (!checked.ok) throw new Error(checked.error);
  const parts = apiParts(buildOpenApiDocument());
  const definitions = Object.fromEntries(
    Object.entries(parts.definitions).map(([name, schema]) => [name, convert(schema, name, false)]),
  );

  return {
    swagger: '2.0',
    info: {
      title: CONNECTOR_TITLE,
      version: GATE_VERSION,
      description: 'Wysyłka SMS-ów przez bramkę Multiinfo Gate do platformy Multiinfo operatora Plus: do jednego'
        + ' numeru, w formie rozsyłki albo do listy odbiorców zapisanej w integracji, wraz ze sprawdzaniem stanu'
        + ' i raportu doręczeń. Każda wysyłka przechodzi przez integrację z Power Automate skonfigurowaną w panelu bramki.'
        + ` Instrukcja: ${CONNECTOR_ARTICLE}`,
    },
    host: checked.host,
    basePath: '/',
    schemes: ['https'],
    consumes: ['application/json'],
    produces: ['application/json'],
    paths: {
      '/v1/integrations/{id}/messages': {
        post: {
          operationId: 'WyslijSms',
          summary: 'Wyślij SMS',
          description: 'Wysyła jedną wiadomość do jednego numeru przez integrację z Power Automate. Integracja wyznacza'
            + ' nadawcę, usługę, limit długości i ochronę przed nadmiarem wysyłek. Bramka przyjmuje wiadomość do kolejki'
            + ' i odpowiada od razu. Stan doręczenia sprawdza akcja „Sprawdź stan wiadomości”.',
          parameters: [
            integrationParam(INTEGRATION_FOR_SENDING),
            IDEMPOTENCY,
            body('Wiadomość', 'Numer, treść i ustawienia wiadomości', requestBody(parts.messageBody, 'WyslijSms')),
          ],
          responses: {
            '200': { description: 'Wiadomość przyjęta do kolejki', schema: ref('PrzyjetaWiadomosc') },
            '409': {
              description: 'Integracja wyłączona w panelu bramki albo ten sam klucz idempotencji z inną treścią:'
                + ' integration_disabled, idempotency_conflict',
              schema: ref('OdpowiedzBledu'),
            },
            ...SENDING_ERRORS,
          },
        },
      },
      '/v1/messages/{id}': {
        get: {
          operationId: 'StanWiadomosci',
          summary: 'Sprawdź stan wiadomości',
          description: 'Zwraca bieżący stan wiadomości wysłanej tym kluczem: czy została przekazana do sieci, czy'
            + ' została doręczona, a jeżeli nie, to z jakiego powodu.',
          parameters: [pathId('Identyfikator wiadomości', 'Identyfikator z akcji „Wyślij SMS” albo „Wyślij SMS do grupy”')],
          responses: {
            '200': { description: 'Stan wiadomości', schema: ref('Wiadomosc') },
            '404': { description: 'Nie ma wiadomości o tym identyfikatorze: message_not_found', schema: ref('OdpowiedzBledu') },
            default: ERROR,
          },
        },
      },
      '/v1/integrations/{id}/packages': {
        post: {
          operationId: 'WyslijRozsylke',
          summary: 'Wyślij rozsyłkę',
          description: 'Wysyła rozsyłkę do listy do 5000 odbiorców jednym wywołaniem, bez pętli w przepływie, przez'
            + ' integrację z Power Automate. Każdy odbiorca może otrzymać własną treść i własny identyfikator, który wraca'
            + ' w raporcie.',
          parameters: [
            integrationParam(INTEGRATION_FOR_SENDING),
            IDEMPOTENCY,
            body('Rozsyłka', 'Odbiorcy, treść i ustawienia rozsyłki', requestBody(parts.packageBody, 'WyslijRozsylke')),
          ],
          responses: {
            '200': { description: 'Rozsyłka przyjęta do kolejki', schema: ref('PrzyjetaRozsylka') },
            '409': {
              description: 'Integracja wyłączona w panelu bramki albo ten sam klucz idempotencji użyty z inną rozsyłką:'
                + ' integration_disabled, idempotency_conflict',
              schema: ref('OdpowiedzBledu'),
            },
            ...SENDING_ERRORS,
          },
        },
      },
      '/v1/packages/{id}': {
        get: {
          operationId: 'StanRozsylki',
          summary: 'Sprawdź stan rozsyłki',
          description: 'Zwraca bieżący stan rozsyłki i stan jej raportu. Podsumowanie doręczeń pojawia się, gdy raport'
            + ' ma stan ready.',
          parameters: [pathId('Identyfikator rozsyłki', 'Identyfikator z akcji „Wyślij rozsyłkę”')],
          responses: {
            '200': { description: 'Stan rozsyłki', schema: ref('Rozsylka') },
            '404': { description: 'Nie ma rozsyłki o tym identyfikatorze: package_not_found', schema: ref('OdpowiedzBledu') },
            default: ERROR,
          },
        },
      },
      '/v1/packages/{id}/report': {
        get: {
          operationId: 'RaportRozsylki',
          summary: 'Pobierz raport rozsyłki',
          description: 'Zwraca stan doręczenia każdego odbiorcy rozsyłki wraz z jego identyfikatorem. Raport jest'
            + ' dostępny, gdy akcja „Sprawdź stan rozsyłki” podaje stan raportu ready. Wcześniej akcja kończy się'
            + ' błędem 409 report_not_ready.',
          parameters: [pathId('Identyfikator rozsyłki', 'Identyfikator z akcji „Wyślij rozsyłkę”')],
          responses: {
            '200': { description: 'Raport rozsyłki', schema: ref('RaportRozsylki') },
            '404': { description: 'Nie ma rozsyłki o tym identyfikatorze: package_not_found', schema: ref('OdpowiedzBledu') },
            '409': {
              description: 'Raport nie jest jeszcze gotowy: report_not_ready. Odpowiedź podaje bieżący stan raportu',
              schema: ref('BladRaportu'),
            },
            default: ERROR,
          },
        },
      },
      '/v1/integrations/{id}/group': {
        post: {
          operationId: 'WyslijSmsDoGrupy',
          summary: 'Wyślij SMS do grupy',
          description: 'Wysyła treść do każdego numeru z listy odbiorców integracji z Power Automate, osobną wiadomością'
            + ' na numer. Listę prowadzi administrator w panelu bramki. Wysyłka jest przyjmowana w całości albo wcale.',
          parameters: [
            integrationParam(INTEGRATION_FOR_GROUP),
            IDEMPOTENCY,
            body('Wiadomość', 'Treść i ustawienia wiadomości', requestBody(parts.groupBody, 'WyslijSmsDoGrupy')),
          ],
          responses: {
            '200': { description: 'Wysyłka przyjęta do kolejki', schema: ref('WysylkaDoGrupy') },
            '409': {
              description: 'Integracja wyłączona w panelu bramki, pusta lista odbiorców albo ten sam klucz idempotencji'
                + ' z inną treścią: integration_disabled, group_empty, idempotency_conflict',
              schema: ref('OdpowiedzBledu'),
            },
            ...SENDING_ERRORS,
          },
        },
      },
      '/v1/integrations': {
        get: {
          operationId: 'ListaIntegracji',
          summary: 'Lista integracji',
          description: 'Czynne integracje z Power Automate klucza. Źródło listy „Integracja”.',
          'x-ms-visibility': 'internal',
          responses: { '200': { description: 'Integracje klucza', schema: ref('ListaIntegracji') }, default: ERROR },
        },
      },
    },
    definitions,
    securityDefinitions: {
      kluczApi: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'Klucz API wygenerowany w panelu bramki, wklejony bez żadnego przedrostka',
      },
    },
    security: [{ kluczApi: [] }],
    'x-ms-connector-metadata': [{ propertyName: 'Website', propertyValue: 'https://sqlik.github.io/multiinfo-gate/' }],
  };
}
