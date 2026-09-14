import { GATE_VERSION } from '../version.ts';
import { messageBodySchema } from './messages.ts';

/**
 * Opis API w formacie OpenAPI 3.1. Plik `docs/openapi.json` powstaje z tego modułu poleceniem
 * `npm run openapi`, a test pilnuje, że zapisany plik zgadza się z modułem. Pola ciała wysyłki
 * biorą się z tego samego schematu zod, którego używa trasa, więc nowe pole nie umknie opisowi:
 * pole bez opisu przerywa budowanie dokumentu.
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
  in: 'path' | 'header';
  required: boolean;
  description: string;
  schema: JsonSchema;
  example?: string;
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
  info: { title: string; version: string; description: string; license: { name: string; identifier: string } };
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

/**
 * Właściwości ciała wysyłki wprost ze schematu trasy: nazwy pól oraz wymagalność bierze się
 * z zod, opisy z tabeli wyżej. Pole dołożone do schematu bez opisu przerywa budowanie.
 */
function cialoWysylki(): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [nazwa, pole] of Object.entries(messageBodySchema.shape)) {
    const opis = POLA_WIADOMOSCI[nazwa];
    if (!opis) {
      throw new Error(`Pole ${nazwa} ze schematu wysyłki nie ma opisu w src/api/openapi.ts`);
    }
    properties[nazwa] = opis;
    if (!pole.isOptional()) required.push(nazwa);
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
    orig: POLA_WIADOMOSCI['orig'] as JsonSchema,
    serviceId: POLA_WIADOMOSCI['serviceId'] as JsonSchema,
    encoding: POLA_WIADOMOSCI['encoding'] as JsonSchema,
    deliveryReport: POLA_WIADOMOSCI['deliveryReport'] as JsonSchema,
    costCenter: POLA_WIADOMOSCI['costCenter'] as JsonSchema,
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

const PARAMETR_ID_ROZSYLKI: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Identyfikator rozsyłki zwrócony przy jej utworzeniu',
  schema: { type: 'string', pattern: '^pkg_[A-Za-z0-9]+$' },
  example: 'pkg_7c1e9a2b3d4f5a6b7c8d',
};

export function buildOpenApiDocument(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Multiinfo Gate',
      version: GATE_VERSION,
      description: 'Bramka SMS między aplikacjami a platformą Multiinfo operatora Plus. Opis obejmuje wysyłkę'
        + ' pojedynczej wiadomości, rozsyłkę, anulowanie, zamówienie raportu rozsyłki oraz stan bramki.'
        + ' Odczyt wiadomości, wiadomości przychodzące i powiadomienia webhook opisuje dokumentacja bramki.'
        + ' Przyjęcie wiadomości i rozsyłki jest asynchroniczne: bramka odpowiada kodem 202 po zapisaniu żądania'
        + ' w kolejce, a wysyłka do Multiinfo następuje później.',
      license: { name: 'MIT', identifier: 'MIT' },
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
            description: 'Własny klucz powtórzenia, najwyżej 128 znaków. Powtórzone żądanie z tym samym kluczem'
              + ' i tą samą treścią zwraca pierwotną odpowiedź zamiast wysyłać wiadomość drugi raz.',
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
                + ' valid_to_in_past, valid_to_too_far',
              'invalid_phone',
              'Numer 4860100000 ma 10 cyfr; numer z kodem kraju 48 ma ich 11.',
            ),
            '401': BLAD_KLUCZA,
            '403': blad(
              'Usługa albo nadpis spoza uprawnień klucza: service_not_allowed, orig_not_allowed',
              'orig_not_allowed',
              'Klucz nie ma dostępu do nadpisu Firma Info. Dozwolone nadpisy: Firma Sklep.',
            ),
            '409': blad(
              'Ten sam Idempotency-Key użyty z inną treścią albo innym numerem',
              'idempotency_conflict',
              'Klucz idempotencji został już użyty z inną treścią wiadomości.',
            ),
            '429': blad(
              'Przekroczony limit żądań klucza na minutę',
              'rate_limited',
              'Przekroczono limit 60 żądań na minutę.',
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
                      report: {
                        type: 'object',
                        required: ['status'],
                        description: 'Stan raportu',
                        properties: {
                          status: {
                            type: 'string',
                            enum: ['pending', 'ready', 'failed', 'expired', 'none'],
                            description: 'Stan raportu; zaraz po zamówieniu pending',
                          },
                        },
                      },
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
      },
    },
  };
}
