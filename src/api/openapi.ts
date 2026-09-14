import { GATE_VERSION } from '../version.ts';
import { messageBodySchema } from './messages.ts';

/**
 * Opis API w formacie OpenAPI 3.0. Plik `docs/openapi.json` powstaje z tego modułu poleceniem
 * `npm run openapi`, które `npm test` wywołuje samo, a osobny krok w przepływach GitHuba pilnuje,
 * że zapisany plik nie odstaje od kodu. Pola ciała wysyłki biorą się z tego samego schematu zod,
 * którego używa trasa, więc nowe pole nie umknie opisowi: pole bez opisu przerywa budowanie
 * dokumentu. Wersja 3.0, a nie 3.1, bo konektory własne Power Platform czytają tylko 2.0 oraz 3.0.
 */

export interface JsonSchema {
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
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  oneOf?: JsonSchema[];
  /** Postać z OpenAPI 3.0; pola odczytu bywają puste, a `type: ['string', 'null']` należy do 3.1. */
  nullable?: boolean;
  example?: unknown;
}

export interface OpenApiMediaType {
  schema: JsonSchema;
  example?: unknown;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'header' | 'query';
  required: boolean;
  description: string;
  schema: JsonSchema;
  example?: string | number;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description: string;
  security: Array<Record<string, string[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: { required: boolean; content: Record<string, OpenApiMediaType> };
  responses: Record<string, OpenApiResponse>;
}

export type OpenApiPathItem = Partial<Record<'get' | 'post', OpenApiOperation>>;

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string; license: { name: string; url: string } };
  servers: Array<{
    url: string;
    description: string;
    variables: Record<string, { default: string; description: string }>;
  }>;
  security: Array<Record<string, string[]>>;
  paths: Record<string, OpenApiPathItem>;
  components: {
    securitySchemes: Record<string, { type: string; scheme: string; description: string }>;
    schemas: Record<string, JsonSchema>;
  };
}

/** Uwierzytelnienie kluczem API; `/healthz` jako jedyne go nie wymaga. */
const KLUCZ = [{ bearerAuth: [] }];

const BLAD = { $ref: '#/components/schemas/OdpowiedzBledu' };

/** Odpowiedź błędu ma wszędzie ten sam kształt, różni się tylko wartością `error.code`. */
function blad(description: string, code: string, message: string): OpenApiResponse {
  return { description, content: { 'application/json': { schema: BLAD, example: { error: { code, message } } } } };
}

/** Wspólne błędy uwierzytelniania: te same cztery kody przy każdym wywołaniu z kluczem. */
const BLAD_KLUCZA = blad(
  'Klucz API brakujący, nieznany, odwołany albo wygasły: missing_api_key, invalid_api_key, revoked_api_key, expired_api_key',
  'missing_api_key',
  'Brak nagłówka Authorization ze schematem Bearer.',
);

/**
 * Opisy pól ciała wysyłki. Kluczem jest nazwa pola ze schematu zod. Zod nie zna opisów,
 * a to one są wartością tego pliku dla czytelnika, więc stoją tutaj.
 */
const POLA_WIADOMOSCI: Record<string, JsonSchema> = {
  to: {
    description: 'Numer odbiorcy albo lista numerów, najwyżej 500. Numer bez kodu kraju dostaje kod domyślny konta,'
      + ' dla Polski 48. Lista jest przyjmowana w całości albo wcale.',
    oneOf: [
      { type: 'string', example: '48601000001' },
      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500 },
    ],
  },
  text: {
    type: 'string',
    minLength: 1,
    description: 'Treść wiadomości. Znaki spoza alfabetu GSM, w tym polskie, są dozwolone; wpływają na kodowanie'
      + ' i liczbę części.',
    example: 'Przypominamy o wizycie 26.08 o 10:00.',
  },
  orig: {
    type: 'string',
    description: 'Nadpis nadawcy. Musi należeć do nadpisów dozwolonych dla klucza. Pominięty oznacza nadpis domyślny'
      + ' klucza albo konta, a gdy żadnego nie ma, nadawcą jest numer przydzielony kontu w Multiinfo.',
    example: 'Firma Info',
  },
  serviceId: {
    description: 'Identyfikator usługi Multiinfo. Pominięty oznacza usługę domyślną klucza',
    oneOf: [{ type: 'string' }, { type: 'integer' }],
    example: '24138',
  },
  encoding: {
    type: 'string',
    enum: ['auto', 'gsm', 'unicode'],
    default: 'auto',
    description: 'Kodowanie treści. Wartość auto wybiera GSM-7, a przy znakach spoza GSM przechodzi na UCS-2.'
      + ' Wartość gsm wymusza GSM-7, przez co Multiinfo zastępuje polskie znaki łacińskimi odpowiednikami.'
      + ' Wartość unicode wymusza UCS-2.',
  },
  maxParts: {
    type: 'integer',
    minimum: 1,
    maximum: 9,
    description: 'Górna granica liczby części tej wiadomości. Nie może przekraczać limitu klucza',
  },
  deliveryReport: {
    type: 'boolean',
    default: true,
    description: 'Raport doręczenia. Wartość false oznacza rezygnację z raportu, przez co stan wiadomości kończy'
      + ' się na sent',
  },
  validTo: {
    type: 'string',
    format: 'date-time',
    description: 'Czas ważności w formacie ISO 8601, najwyżej 72 godziny od przyjęcia. Wiadomość niedoręczona do tego'
      + ' czasu dostaje stan expired.',
    example: '2026-08-26T12:00:00.000Z',
  },
  costCenter: {
    type: 'string',
    description: 'Dowolny znacznik na potrzeby rozliczeń aplikacji. Bramka zwraca go przy odczycie wiadomości',
  },
  inReplyTo: {
    type: 'string',
    pattern: '^in_[A-Za-z0-9_]{1,40}$',
    description: 'Identyfikator wiadomości przychodzącej, na którą to jest odpowiedź. Wolno go podać tylko przy jednym'
      + ' odbiorcy, którym jest nadawca tamtej wiadomości, i w tej samej usłudze, z której przyszła.',
    example: 'in_7b3d9f2a1c',
  },
};

/** Opis pola wysyłki po nazwie. Brak opisu przerywa budowanie, także przy ciele rozsyłki. */
function pole(nazwa: string): JsonSchema {
  const opis = POLA_WIADOMOSCI[nazwa];
  if (!opis) {
    throw new Error(`Pole ${nazwa} ze schematu wysyłki nie ma opisu w src/api/openapi.ts`);
  }
  return opis;
}

/**
 * Właściwości ciała wysyłki wprost ze schematu trasy: nazwy pól oraz wymagalność bierze się
 * z zod, opisy z tabeli wyżej. Pole dołożone do schematu bez opisu przerywa budowanie.
 */
function cialoWysylki(): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [nazwa, schemat] of Object.entries(messageBodySchema.shape)) {
    properties[nazwa] = pole(nazwa);
    if (!schemat.isOptional()) required.push(nazwa);
  }
  return { type: 'object', required, properties };
}

/** Odbiorca rozsyłki; osobny schemat, bo powtarza się w ciele i w opisie raportu. */
const ODBIORCA: JsonSchema = {
  type: 'object',
  required: ['to'],
  properties: {
    to: { type: 'string', description: 'Numer odbiorcy', example: '48601000001' },
    text: {
      type: 'string',
      minLength: 1,
      description: 'Treść dla tego odbiorcy. Pominięta oznacza treść domyślną rozsyłki',
    },
    clientId: {
      type: 'string',
      pattern: '^[A-Za-z0-9._-]{1,20}$',
      description: 'Własny identyfikator odbiorcy, od 1 do 20 znaków. Bramka zwraca go w raporcie, co ułatwia'
        + ' dopasowanie wyników do rekordów aplikacji.',
      example: 'faktura-114',
    },
  },
};

const CIALO_ROZSYLKI: JsonSchema = {
  type: 'object',
  required: ['recipients'],
  properties: {
    recipients: {
      type: 'array',
      minItems: 1,
      maxItems: 5000,
      items: ODBIORCA,
      description: 'Lista odbiorców, od 1 do 5000 pozycji',
    },
    defaultText: {
      type: 'string',
      minLength: 1,
      description: 'Treść dla odbiorców bez własnej treści. Jest wymagana, jeżeli którykolwiek odbiorca jej nie ma',
    },
    orig: pole('orig'),
    serviceId: pole('serviceId'),
    encoding: pole('encoding'),
    deliveryReport: pole('deliveryReport'),
    costCenter: pole('costCenter'),
    startAt: {
      type: 'string',
      format: 'date-time',
      description: 'Termin rozpoczęcia rozsyłki w formacie ISO 8601. Musi być w przyszłości; Multiinfo rusza'
        + ' o tej godzinie.',
      example: '2026-08-27T08:00:00.000Z',
    },
  },
};

const PRZYJETA_WIADOMOSC: JsonSchema = {
  type: 'object',
  description: 'Wiadomość przyjęta do kolejki',
  required: ['id', 'status', 'encoding', 'parts', 'characters', 'slots', 'slotsRemaining'],
  properties: {
    id: { type: 'string', description: 'Identyfikator wiadomości', example: 'msg_3f9c2a7b1e4d8c6a5b2f' },
    status: { type: 'string', description: 'Stan wiadomości zaraz po przyjęciu', example: 'queued' },
    encoding: { type: 'string', enum: ['gsm', 'ucs2'], description: 'Kodowanie wybrane dla treści' },
    parts: { type: 'integer', description: 'Liczba części, na które wiadomość została podzielona. Operator rozlicza'
      + ' każdą część osobno' },
    characters: { type: 'integer', description: 'Liczba znaków treści' },
    slots: { type: 'integer', description: 'Liczba zajętych miejsc. W kodowaniu GSM-7 znaki { } [ ] ~ ^ | \\ i euro'
      + ' zajmują po dwa miejsca' },
    slotsRemaining: { type: 'integer', description: 'Liczba wolnych miejsc w ostatniej części' },
  },
};

const PARAMETR_ID_WIADOMOSCI: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Identyfikator wiadomości zwrócony przy wysyłce',
  schema: { type: 'string', pattern: '^msg_[A-Za-z0-9]+$' },
  example: 'msg_3f9c2a7b1e4d8c6a5b2f',
};

const PARAMETR_ID_PRZYCHODZACEJ: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Identyfikator wiadomości przychodzącej',
  schema: { type: 'string', pattern: '^in_[A-Za-z0-9_]+$' },
  example: 'in_7b3d9f2a1c',
};

const PARAMETR_ID_ROZSYLKI: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Identyfikator rozsyłki zwrócony przy jej utworzeniu',
  schema: { type: 'string', pattern: '^pkg_[A-Za-z0-9]+$' },
  example: 'pkg_7c1e9a2b3d4f5a6b7c8d',
};

const STATUSY_WIADOMOSCI = ['queued', 'sent', 'delivered', 'failed', 'expired', 'cancelled', 'blocked', 'throttled', 'unknown'];
const STATUSY_ROZSYLKI = ['queued', 'open', 'sending', 'completed', 'cancelled', 'failed'];
const STATUSY_RAPORTU = ['none', 'pending', 'ready', 'failed'];

/** Stronicowanie obu list wygląda tak samo; wartości spoza zakresu wracają do domyślnych. */
const PARAMETRY_STRONICOWANIA: OpenApiParameter[] = [
  {
    name: 'limit',
    in: 'query',
    required: false,
    description: 'Liczba wyników na stronie',
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
    example: 50,
  },
  {
    name: 'offset',
    in: 'query',
    required: false,
    description: 'Liczba wyników pominiętych od początku listy',
    schema: { type: 'integer', minimum: 0, default: 0 },
  },
];

/** Koperta każdej listy: strona wyników oraz informacja, czy jest następna. */
function lista(pozycja: JsonSchema, opis: string): JsonSchema {
  return {
    type: 'object',
    description: opis,
    required: ['data', 'hasMore'],
    properties: {
      data: { type: 'array', items: pozycja, description: 'Strona wyników, od najnowszego' },
      hasMore: { type: 'boolean', description: 'Czy za tą stroną są dalsze wyniki' },
    },
  };
}

const WIADOMOSC: JsonSchema = {
  type: 'object',
  description: 'Wiadomość wysłana tym kluczem',
  required: ['id', 'status', 'to', 'encoding', 'parts', 'slots', 'orig', 'serviceId', 'inReplyTo', 'costCenter',
    'createdAt', 'sentAt', 'finalAt', 'providerCode', 'error'],
  properties: {
    id: { type: 'string', description: 'Identyfikator wiadomości', example: 'msg_3f9c2a7b1e4d8c6a5b2f' },
    status: {
      type: 'string',
      enum: STATUSY_WIADOMOSCI,
      description: 'Stan wiadomości. Stany delivered, failed, expired, cancelled oraz blocked są ostateczne',
    },
    to: { type: 'string', description: 'Numer odbiorcy po normalizacji', example: '48601000001' },
    text: {
      type: 'string',
      description: 'Treść wiadomości. Pole występuje tylko wtedy, gdy konto Multiinfo ma włączone przechowywanie treści',
    },
    encoding: { type: 'string', enum: ['gsm', 'ucs2'], description: 'Kodowanie wybrane dla treści' },
    parts: { type: 'integer', description: 'Liczba części, na które wiadomość została podzielona' },
    slots: { type: 'integer', description: 'Liczba zajętych miejsc' },
    orig: { type: 'string', nullable: true, description: 'Nadpis nadawcy użyty przy wysyłce' },
    serviceId: { type: 'string', description: 'Usługa Multiinfo, z której poszła wiadomość', example: '24138' },
    inReplyTo: {
      type: 'string',
      nullable: true,
      description: 'Wiadomość przychodząca, na którą to jest odpowiedź. Poza wątkiem null',
    },
    costCenter: { type: 'string', nullable: true, description: 'Znacznik rozliczeniowy podany przy wysyłce' },
    createdAt: { type: 'string', format: 'date-time', description: 'Chwila przyjęcia przez bramkę' },
    sentAt: { type: 'string', format: 'date-time', nullable: true, description: 'Chwila przekazania do sieci' },
    finalAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'Chwila osiągnięcia stanu ostatecznego',
    },
    providerCode: {
      type: 'integer',
      nullable: true,
      description: 'Kod odmowy albo błędu z Multiinfo; poza błędem null',
    },
    error: { type: 'string', nullable: true, description: 'Wyjaśnienie błędu po polsku; poza błędem null' },
  },
};

const WIADOMOSC_PRZYCHODZACA: JsonSchema = {
  type: 'object',
  description: 'Wiadomość odebrana od abonenta',
  required: ['id', 'serviceId', 'from', 'to', 'kind', 'receivedAt', 'relatedMessageId', 'protocolId',
    'codingScheme', 'createdAt'],
  properties: {
    id: { type: 'string', description: 'Identyfikator wiadomości przychodzącej', example: 'in_7b3d9f2a1c' },
    serviceId: { type: 'string', description: 'Usługa Multiinfo, na którą wiadomość przyszła', example: '24138' },
    from: { type: 'string', description: 'Numer nadawcy; numer krótki albo nietypowy przepisany bez zmian' },
    to: { type: 'string', description: 'Numer usługi, na który wiadomość przyszła', example: '7968' },
    kind: { type: 'string', enum: ['text', 'binary'], description: 'Rodzaj treści' },
    text: { type: 'string', description: 'Treść wiadomości tekstowej. Występuje zamiennie z hex oraz bodyHash' },
    hex: { type: 'string', description: 'Treść wiadomości binarnej, szesnastkowo, bez interpretacji' },
    bodyHash: {
      type: 'string',
      description: 'SHA-256 treści, szesnastkowo. Zastępuje text oraz hex, gdy konto ma wyłączone przechowywanie treści',
    },
    receivedAt: { type: 'string', format: 'date-time', description: 'Chwila odbioru przez Multiinfo' },
    relatedMessageId: {
      type: 'string',
      nullable: true,
      description: 'Ostatnia wiadomość wysłana z tej usługi na numer nadawcy w ciągu 48 godzin. To podpowiedź'
        + ' kontekstu, nie stwierdzenie: Multiinfo nie przekazuje, na co abonent odpowiada',
    },
    protocolId: { type: 'integer', description: 'Parametr protokołu SMS; dla zwykłego tekstu 0' },
    codingScheme: { type: 'integer', description: 'Alfabet: 0 dla GSM, 8 dla UCS-2' },
    createdAt: { type: 'string', format: 'date-time', description: 'Chwila zapisania wiadomości przez bramkę' },
  },
};

const STAN_RAPORTU: JsonSchema = {
  type: 'object',
  description: 'Stan raportu rozsyłki',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: STATUSY_RAPORTU, description: 'Stan raportu' },
    expiresAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'Do kiedy raport jest dostępny w Multiinfo',
    },
  },
};

const ROZSYLKA: JsonSchema = {
  type: 'object',
  description: 'Rozsyłka zlecona tym kluczem',
  required: ['id', 'status', 'recipients', 'remaining', 'encoding', 'multipart', 'serviceId', 'orig', 'startAt',
    'createdAt', 'completedAt', 'providerCode', 'error', 'report', 'summary'],
  properties: {
    id: { type: 'string', description: 'Identyfikator rozsyłki', example: 'pkg_7c1e9a2b3d4f5a6b7c8d' },
    status: { type: 'string', enum: STATUSY_ROZSYLKI, description: 'Stan rozsyłki' },
    recipients: { type: 'integer', description: 'Liczba przyjętych odbiorców' },
    remaining: { type: 'integer', nullable: true, description: 'Liczba odbiorców, do których wysyłka jeszcze nie doszła' },
    encoding: { type: 'string', enum: ['gsm', 'ucs2'], description: 'Kodowanie całej rozsyłki' },
    multipart: { type: 'boolean', description: 'Czy którakolwiek treść jest dzielona na części' },
    serviceId: { type: 'string', description: 'Usługa Multiinfo, z której idzie rozsyłka', example: '24138' },
    orig: { type: 'string', nullable: true, description: 'Nadpis nadawcy użyty w rozsyłce' },
    startAt: { type: 'string', format: 'date-time', nullable: true, description: 'Zamówiony termin rozpoczęcia' },
    createdAt: { type: 'string', format: 'date-time', description: 'Chwila przyjęcia przez bramkę' },
    completedAt: { type: 'string', format: 'date-time', nullable: true, description: 'Chwila zakończenia wysyłki' },
    providerCode: { type: 'integer', nullable: true, description: 'Kod odmowy albo błędu z Multiinfo' },
    error: { type: 'string', nullable: true, description: 'Wyjaśnienie błędu po polsku' },
    report: STAN_RAPORTU,
    summary: {
      type: 'object',
      nullable: true,
      description: 'Podsumowanie doręczeń. Pojawia się dopiero po wczytaniu raportu, wcześniej null',
      required: ['delivered', 'failed', 'other'],
      properties: {
        delivered: { type: 'integer', description: 'Liczba doręczonych' },
        failed: { type: 'integer', description: 'Liczba niedoręczonych' },
        other: { type: 'integer', description: 'Liczba pozostałych, na przykład wciąż w drodze' },
      },
    },
  },
};

const WIERSZ_RAPORTU: JsonSchema = {
  type: 'object',
  description: 'Jeden odbiorca rozsyłki w raporcie',
  required: ['to', 'clientId', 'miId', 'status', 'miStatus', 'changedAt'],
  properties: {
    to: { type: 'string', description: 'Numer odbiorcy po normalizacji', example: '48601000001' },
    clientId: { type: 'string', nullable: true, description: 'Własny identyfikator odbiorcy podany przy zleceniu' },
    miId: { type: 'string', nullable: true, description: 'Identyfikator wiadomości w Multiinfo' },
    status: {
      type: 'string',
      enum: STATUSY_WIADOMOSCI,
      nullable: true,
      description: 'Stan wiadomości do tego odbiorcy',
    },
    miStatus: { type: 'integer', nullable: true, description: 'Surowy kod stanu z Multiinfo' },
    changedAt: {
      type: 'string',
      nullable: true,
      description: 'Chwila ostatniej zmiany stanu, tak jak podaje ją Multiinfo, czyli w postaci RRRR-MM-DD GG:MM:SS',
      example: '2026-08-26 12:00:00',
    },
  },
};

export function buildOpenApiDocument(): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Multiinfo Gate',
      version: GATE_VERSION,
      description: 'Bramka SMS między aplikacjami a platformą Multiinfo operatora Plus. Opis obejmuje każde'
        + ' wywołanie API bramki: wysyłkę, odczyt wysłanych wiadomości, anulowanie, rozsyłkę wraz z raportem,'
        + ' odczyt wiadomości przychodzących oraz stan bramki. Powiadomienia webhook idą w drugą stronę, więc'
        + ' opisuje je dokumentacja bramki. Przyjęcie wiadomości i rozsyłki jest asynchroniczne: bramka odpowiada'
        + ' kodem 202 po zapisaniu żądania w kolejce, a wysyłka do Multiinfo następuje później.',
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    },
    servers: [{
      url: 'https://{domena}',
      description: 'Adres bramki. W trakcie testów przez tunel SSH jest to http://127.0.0.1:8080',
      variables: {
        domena: { default: 'bramka.example.com', description: 'Domena, pod którą wystawione jest API bramki' },
      },
    }],
    security: KLUCZ,
    paths: {
      '/v1/messages': {
        post: {
          operationId: 'wyslijWiadomosc',
          summary: 'Wysyłka wiadomości',
          description: 'Wysyła jedną wiadomość do jednego numeru albo tę samą treść do kilku numerów, najwyżej 500.'
            + ' Bramka zapisuje wiadomość w kolejce i odpowiada natychmiast. Błędny numer na dowolnej pozycji'
            + ' odrzuca całe żądanie, więc żadna wiadomość nie trafia wtedy do kolejki.',
          security: KLUCZ,
          parameters: [{
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description: 'Własny klucz powtórzenia. Powtórzone żądanie z tym samym kluczem i tą samą treścią'
              + ' zwraca pierwotną odpowiedź zamiast wysyłać wiadomość drugi raz.',
            schema: { type: 'string' },
            example: 'zamowienie-2026-08-26-114',
          }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: cialoWysylki(),
                example: { to: '48601000001', text: 'Przypominamy o wizycie 26.08 o 10:00.', orig: 'Firma Info' },
              },
            },
          },
          responses: {
            '202': {
              description: 'Wiadomość przyjęta do kolejki. Przy liście numerów odpowiedź jest tablicą takich'
                + ' obiektów, w kolejności numerów',
              content: {
                'application/json': {
                  schema: { oneOf: [PRZYJETA_WIADOMOSC, { type: 'array', items: PRZYJETA_WIADOMOSC }] },
                  example: {
                    id: 'msg_3f9c2a7b1e4d8c6a5b2f',
                    status: 'queued',
                    encoding: 'gsm',
                    parts: 1,
                    characters: 39,
                    slots: 39,
                    slotsRemaining: 121,
                  },
                },
              },
            },
            '400': blad(
              'Błąd w ciele żądania: invalid_body, invalid_phone, invalid_orig, too_many_parts, service_required,'
                + ' valid_to_in_past, valid_to_too_far, a przy polu inReplyTo także in_reply_to_single,'
                + ' in_reply_to_unknown oraz in_reply_to_recipient',
              'invalid_phone',
              'Numer odbiorcy jest nieprawidłowy: 4860100000 (numer z kodem 48 ma 11 cyfr)',
            ),
            '401': BLAD_KLUCZA,
            '403': blad(
              'Usługa albo nadpis spoza uprawnień klucza: service_not_allowed, orig_not_allowed',
              'orig_not_allowed',
              'Ten klucz może użyć nadpisu: Firma Sklep.',
            ),
            '409': blad(
              'Ten sam Idempotency-Key użyty z inną treścią albo innym numerem',
              'idempotency_conflict',
              'Ten klucz idempotencji został już użyty z inną treścią lub innym odbiorcą.',
            ),
            '429': blad(
              'Przekroczony limit żądań klucza na minutę',
              'rate_limited',
              'Przekroczono limit 60 żądań na minutę.',
            ),
          },
        },
        get: {
          operationId: 'listaWiadomosci',
          summary: 'Lista wysłanych wiadomości',
          description: 'Zwraca wiadomości wysłane tym kluczem, od najnowszej. Filtry można łączyć. Strona ma'
            + ' domyślnie 25 pozycji, najwyżej 200; następną stronę pobiera się przez offset, dopóki hasMore'
            + ' jest prawdziwe.',
          security: KLUCZ,
          parameters: [
            {
              name: 'status',
              in: 'query',
              required: false,
              description: 'Tylko wiadomości w tym stanie',
              schema: { type: 'string', enum: STATUSY_WIADOMOSCI },
              example: 'failed',
            },
            {
              name: 'to',
              in: 'query',
              required: false,
              description: 'Tylko wiadomości do tego numeru, w postaci po normalizacji',
              schema: { type: 'string' },
              example: '48601000001',
            },
            {
              name: 'from',
              in: 'query',
              required: false,
              description: 'Początek zakresu czasu przyjęcia, ISO 8601',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'until',
              in: 'query',
              required: false,
              description: 'Koniec zakresu czasu przyjęcia, ISO 8601',
              schema: { type: 'string', format: 'date-time' },
            },
            ...PARAMETRY_STRONICOWANIA,
          ],
          responses: {
            '200': {
              description: 'Strona wyników',
              content: {
                'application/json': {
                  schema: lista({ $ref: '#/components/schemas/Wiadomosc' }, 'Strona wysłanych wiadomości'),
                },
              },
            },
            '401': BLAD_KLUCZA,
          },
        },
      },
      '/v1/messages/{id}': {
        get: {
          operationId: 'odczytajWiadomosc',
          summary: 'Stan wiadomości',
          description: 'Zwraca bieżący stan wiadomości: czy została przekazana do sieci, czy została doręczona,'
            + ' a jeżeli nie, to z jakiego powodu. Bramka odpytuje Multiinfo sama, więc wystarczy odczytywać ten'
            + ' adres do chwili, w której stan stanie się ostateczny.',
          security: KLUCZ,
          parameters: [PARAMETR_ID_WIADOMOSCI],
          responses: {
            '200': {
              description: 'Stan wiadomości',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Wiadomosc' } } },
            },
            '401': BLAD_KLUCZA,
            '404': blad(
              'Brak wiadomości albo wiadomość innego klucza; bramka nie rozróżnia tych dwóch sytuacji',
              'message_not_found',
              'Nie ma wiadomości o tym identyfikatorze.',
            ),
          },
        },
      },
      '/v1/messages/{id}/cancel': {
        post: {
          operationId: 'anulujWiadomosc',
          summary: 'Anulowanie wiadomości',
          description: 'Zatrzymuje wiadomość, która nie dotarła jeszcze do odbiorcy. Wiadomość czekającą w kolejce'
            + ' bramka anuluje natychmiast. Wiadomość przekazaną do Multiinfo anuluje operator, o ile nie poszła'
            + ' jeszcze do sieci. Wiadomość wieloczęściowa jest anulowana część po części.',
          security: KLUCZ,
          parameters: [PARAMETR_ID_WIADOMOSCI],
          responses: {
            '200': {
              description: 'Wiadomość anulowana',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'status'],
                    properties: {
                      id: { type: 'string', description: 'Identyfikator wiadomości' },
                      status: { type: 'string', enum: ['cancelled'], description: 'Stan po anulowaniu' },
                    },
                  },
                  example: { id: 'msg_3f9c2a7b1e4d8c6a5b2f', status: 'cancelled' },
                },
              },
            },
            '401': BLAD_KLUCZA,
            '404': blad(
              'Brak wiadomości albo wiadomość innego klucza; bramka nie rozróżnia tych dwóch sytuacji',
              'message_not_found',
              'Nie ma wiadomości o tym identyfikatorze.',
            ),
            '409': blad(
              'Anulowanie nie jest już możliwe: already_final, gdy wiadomość ma stan ostateczny, albo already_passed,'
                + ' gdy Multiinfo przekazało ją do abonenta',
              'already_final',
              'Wiadomość ma już stan ostateczny: delivered.',
            ),
            '502': blad(
              'Błąd po stronie Multiinfo; body zawiera providerCode',
              'provider_error',
              'Multiinfo odrzuciło żądanie anulowania.',
            ),
            '503': blad(
              'Multiinfo odrzuciło certyfikat bramki; naprawa należy do administratora bramki',
              'account_certificate',
              'Multiinfo odrzuciło certyfikat bramki.',
            ),
          },
        },
      },
      '/v1/packages': {
        post: {
          operationId: 'utworzRozsylke',
          summary: 'Utworzenie rozsyłki',
          description: 'Zleca rozsyłkę do listy odbiorców, najwyżej 5000 pozycji. Każdy odbiorca może mieć własną'
            + ' treść oraz własny identyfikator zwracany w raporcie. Kodowanie jest wspólne dla całej rozsyłki:'
            + ' jeżeli którakolwiek treść wymaga UCS-2, wszystkie wiadomości idą w UCS-2.',
          security: KLUCZ,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: CIALO_ROZSYLKI,
                example: {
                  defaultText: 'Przypominamy o wizycie.',
                  recipients: [
                    { to: '48601000001' },
                    { to: '48605000001', text: 'Faktura 114 oczekuje na oplacenie.', clientId: 'faktura-114' },
                  ],
                  orig: 'Firma Info',
                },
              },
            },
          },
          responses: {
            '202': {
              description: 'Rozsyłka przyjęta do kolejki',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'status', 'recipients', 'encoding', 'multipart'],
                    properties: {
                      id: { type: 'string', description: 'Identyfikator rozsyłki' },
                      status: { type: 'string', description: 'Stan rozsyłki zaraz po przyjęciu', example: 'queued' },
                      recipients: { type: 'integer', description: 'Liczba przyjętych odbiorców' },
                      encoding: { type: 'string', enum: ['gsm', 'ucs2'], description: 'Kodowanie całej rozsyłki' },
                      multipart: {
                        type: 'boolean',
                        description: 'Czy którakolwiek treść jest dzielona na części',
                      },
                    },
                  },
                  example: {
                    id: 'pkg_7c1e9a2b3d4f5a6b7c8d',
                    status: 'queued',
                    recipients: 2,
                    encoding: 'gsm',
                    multipart: false,
                  },
                },
              },
            },
            '400': blad(
              'Błąd w ciele żądania: invalid_body, invalid_phone, text_required, invalid_client_id, too_many_parts,'
                + ' invalid_orig, service_required, start_at_in_past',
              'text_required',
              'recipients.3: brak treści i brak treści domyślnej.',
            ),
            '401': BLAD_KLUCZA,
            '403': blad(
              'Usługa albo nadpis spoza uprawnień klucza: service_not_allowed, orig_not_allowed',
              'service_not_allowed',
              'Klucz nie ma dostępu do usługi 24139.',
            ),
            '429': blad(
              'Przekroczony limit żądań klucza na minutę',
              'rate_limited',
              'Przekroczono limit 60 żądań na minutę.',
            ),
          },
        },
      },
      '/v1/packages/{id}': {
        get: {
          operationId: 'odczytajRozsylke',
          summary: 'Stan rozsyłki',
          description: 'Zwraca bieżący stan rozsyłki wraz ze stanem raportu. Pole remaining maleje w trakcie'
            + ' wysyłki. Podsumowanie doręczeń pojawia się dopiero wtedy, gdy raport ma stan ready.',
          security: KLUCZ,
          parameters: [PARAMETR_ID_ROZSYLKI],
          responses: {
            '200': {
              description: 'Stan rozsyłki',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Rozsylka' } } },
            },
            '401': BLAD_KLUCZA,
            '404': blad(
              'Brak rozsyłki albo rozsyłka innego klucza; bramka nie rozróżnia tych dwóch sytuacji',
              'package_not_found',
              'Nie ma rozsyłki o tym identyfikatorze.',
            ),
          },
        },
      },
      '/v1/packages/{id}/report': {
        post: {
          operationId: 'zamowRaportRozsylki',
          summary: 'Zamówienie raportu rozsyłki',
          description: 'Zamawia raport rozsyłki jeszcze raz. Bramka zamawia go sama po zakończeniu rozsyłki, więc to'
            + ' wywołanie przydaje się, gdy poprzedni raport ma stan failed. Gotowy raport odczytuje się wywołaniem'
            + ' GET pod tym samym adresem.',
          security: KLUCZ,
          parameters: [PARAMETR_ID_ROZSYLKI],
          responses: {
            '202': {
              description: 'Raport zamówiony; bramka pobierze go z Multiinfo w tle',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'report'],
                    properties: {
                      id: { type: 'string', description: 'Identyfikator rozsyłki' },
                      report: STAN_RAPORTU,
                    },
                  },
                  example: { id: 'pkg_7c1e9a2b3d4f5a6b7c8d', report: { status: 'pending' } },
                },
              },
            },
            '401': BLAD_KLUCZA,
            '404': blad(
              'Brak rozsyłki albo rozsyłka innego klucza; bramka nie rozróżnia tych dwóch sytuacji',
              'package_not_found',
              'Nie ma rozsyłki o tym identyfikatorze.',
            ),
            '409': blad(
              'Rozsyłka jeszcze trwa, więc raportu nie ma czego zamówić',
              'package_not_completed',
              'Raport jest dostępny po zakończeniu rozsyłki; stan: sending.',
            ),
          },
        },
        get: {
          operationId: 'pobierzRaportRozsylki',
          summary: 'Pobranie raportu rozsyłki',
          description: 'Zwraca raport rozsyłki: stan doręczenia dla każdego odbiorcy. Raport jest dostępny'
            + ' dopiero wtedy, gdy jego stan to ready. Parametr format ustawiony na csv albo nagłówek Accept'
            + ' z wartością text/csv daje ten sam raport jako plik CSV.',
          security: KLUCZ,
          parameters: [
            PARAMETR_ID_ROZSYLKI,
            {
              name: 'format',
              in: 'query',
              required: false,
              description: 'Postać raportu; domyślnie JSON',
              schema: { type: 'string', enum: ['csv'] },
            },
          ],
          responses: {
            '200': {
              description: 'Gotowy raport',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'report', 'rows'],
                    properties: {
                      id: { type: 'string', description: 'Identyfikator rozsyłki' },
                      report: STAN_RAPORTU,
                      rows: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/WierszRaportu' },
                        description: 'Odbiorcy rozsyłki wraz ze stanem doręczenia',
                      },
                    },
                  },
                  example: {
                    id: 'pkg_7c1e9a2b3d4f5a6b7c8d',
                    report: { status: 'ready', expiresAt: '2026-08-26T10:35:00.000Z' },
                    rows: [{
                      to: '48601000001',
                      clientId: null,
                      miId: '9001',
                      status: 'delivered',
                      miStatus: 21,
                      changedAt: '2026-08-26 12:00:00',
                    }],
                  },
                },
                'text/csv': {
                  schema: { type: 'string', description: 'Raport jako plik CSV z wierszem nagłówka' },
                },
              },
            },
            '401': BLAD_KLUCZA,
            '404': blad(
              'Brak rozsyłki albo rozsyłka innego klucza; bramka nie rozróżnia tych dwóch sytuacji',
              'package_not_found',
              'Nie ma rozsyłki o tym identyfikatorze.',
            ),
            '409': {
              description: 'Raport nie jest jeszcze gotowy. Poza opisem błędu odpowiedź niesie bieżący stan'
                + ' raportu, więc widać, czy warto czekać, czy zamówić go jeszcze raz',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OdpowiedzBleduRaportu' },
                  example: {
                    error: { code: 'report_not_ready', message: 'Raport nie jest gotowy; stan: pending.' },
                    report: { status: 'pending' },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/inbound': {
        get: {
          operationId: 'listaWiadomosciPrzychodzacych',
          summary: 'Lista wiadomości przychodzących',
          description: 'Zwraca wiadomości odebrane od abonentów w usługach, do których klucz ma dostęp, od'
            + ' najnowszej. Odczyt nie wymaga subskrypcji powiadomień. Strona ma domyślnie 25 pozycji,'
            + ' najwyżej 200.',
          security: KLUCZ,
          parameters: [
            {
              name: 'serviceId',
              in: 'query',
              required: false,
              description: 'Tylko wiadomości z tej usługi. Usługa spoza uprawnień klucza kończy się kodem 403',
              schema: { type: 'string' },
              example: '24138',
            },
            {
              name: 'from',
              in: 'query',
              required: false,
              description: 'Tylko wiadomości od tego nadawcy. Numer wolno podać w dowolnym zapisie',
              schema: { type: 'string' },
              example: '+48 601 000 001',
            },
            {
              name: 'since',
              in: 'query',
              required: false,
              description: 'Początek zakresu czasu odbioru, ISO 8601',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'until',
              in: 'query',
              required: false,
              description: 'Koniec zakresu czasu odbioru, ISO 8601',
              schema: { type: 'string', format: 'date-time' },
            },
            ...PARAMETRY_STRONICOWANIA,
          ],
          responses: {
            '200': {
              description: 'Strona wyników',
              content: {
                'application/json': {
                  schema: lista(
                    { $ref: '#/components/schemas/WiadomoscPrzychodzaca' },
                    'Strona wiadomości przychodzących',
                  ),
                },
              },
            },
            '400': blad(
              'Zła wartość parametru adresu: invalid_query',
              'invalid_query',
              'since musi być datą ISO 8601.',
            ),
            '401': BLAD_KLUCZA,
            '403': blad(
              'Usługa spoza uprawnień klucza',
              'service_not_allowed',
              'Klucz nie ma dostępu do usługi 24139.',
            ),
          },
        },
      },
      '/v1/inbound/{id}': {
        get: {
          operationId: 'odczytajWiadomoscPrzychodzaca',
          summary: 'Jedna wiadomość przychodząca',
          description: 'Zwraca jedną odebraną wiadomość. Przydaje się po powiadomieniu message.received, gdy'
            + ' aplikacja chce potwierdzić treść u źródła.',
          security: KLUCZ,
          parameters: [PARAMETR_ID_PRZYCHODZACEJ],
          responses: {
            '200': {
              description: 'Wiadomość przychodząca',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/WiadomoscPrzychodzaca' } } },
            },
            '401': BLAD_KLUCZA,
            '404': blad(
              'Brak wiadomości, wiadomość innego konta albo z usługi spoza uprawnień klucza; bramka nie rozróżnia'
                + ' tych sytuacji',
              'inbound_not_found',
              'Nie ma wiadomości przychodzącej o tym identyfikatorze.',
            ),
          },
        },
      },
      '/healthz': {
        get: {
          operationId: 'stanBramki',
          summary: 'Stan bramki',
          description: 'Zwraca stan bramki bez klucza API. Stan degraded oznacza jedną z trzech sytuacji: konto'
            + ' Multiinfo jest wstrzymane, jego certyfikat wygasa w ciągu siedmiu dni albo odbiór wiadomości'
            + ' przychodzących zatrzymał się na błędzie Multiinfo. Wywołanie nadaje się do monitoringu zewnętrznego.'
            + ' Ten sam adres na porcie panelu odpowiada szczegółami.',
          security: [],
          responses: {
            '200': {
              description: 'Stan bramki',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['status'],
                    properties: {
                      status: {
                        type: 'string',
                        enum: ['ok', 'degraded'],
                        description: 'Stan bramki',
                      },
                    },
                  },
                  example: { status: 'ok' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Klucz API bramki w nagłówku Authorization, w postaci Bearer mig_live_... Klucz generuje'
            + ' administrator bramki w panelu.',
        },
      },
      schemas: {
        Wiadomosc: WIADOMOSC,
        WiadomoscPrzychodzaca: WIADOMOSC_PRZYCHODZACA,
        Rozsylka: ROZSYLKA,
        WierszRaportu: WIERSZ_RAPORTU,
        Blad: {
          type: 'object',
          description: 'Opis błędu',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', description: 'Stała wartość do rozpoznania błędu w kodzie', example: 'invalid_phone' },
            message: { type: 'string', description: 'Wyjaśnienie po polsku, z wartościami z żądania' },
            providerCode: {
              type: 'integer',
              description: 'Kod błędu Multiinfo. Występuje tylko przy błędach pochodzących od operatora',
              example: -41,
            },
          },
        },
        OdpowiedzBledu: {
          type: 'object',
          description: 'Kształt każdej odpowiedzi błędu',
          required: ['error'],
          properties: { error: { $ref: '#/components/schemas/Blad' } },
        },
        OdpowiedzBleduRaportu: {
          type: 'object',
          description: 'Odmowa wydania raportu wraz z jego bieżącym stanem',
          required: ['error', 'report'],
          properties: { error: { $ref: '#/components/schemas/Blad' }, report: STAN_RAPORTU },
        },
      },
    },
  };
}
