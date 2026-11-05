import { GATE_VERSION } from '../version.ts';
import { MISSING_API_KEY } from './auth.ts';
import { messageBodySchema } from './messages.ts';
import { paGroupBodySchema, paMessageBodySchema } from './pa-integrations.ts';

/**
 * Opis API w formacie OpenAPI 3.0. Plik `docs/openapi.json` powstaje z tego modułu poleceniem
 * `npm run openapi`, które `npm test` wywołuje samo, a osobny krok w przepływach GitHuba pilnuje,
 * że zapisany plik nie odstaje od kodu. Pola body wysyłki pochodzą z tego samego schematu zod,
 * którego używa trasa, więc nowe pole nie umknie opisowi: pole bez opisu przerywa budowanie
 * dokumentu. Wersja 3.0, a nie 3.1, bo 3.0 czyta więcej narzędzi. Power Automate nie przyjmuje żadnej
 * z nich: plik konektora w Swaggerze 2.0 buduje z tego dokumentu `power-automate.ts`.
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
  maxLength?: number;
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
  MISSING_API_KEY,
);

/**
 * Opisy pól body wysyłki. Kluczem jest nazwa pola ze schematu zod. Zod nie zna opisów,
 * a to one są wartością tego pliku dla czytelnika, więc stoją tutaj.
 */
const POLA_WIADOMOSCI: Record<string, JsonSchema> = {
  to: {
    description: 'Numer odbiorcy albo lista numerów, najwyżej 500. Numer bez kodu kraju otrzymuje kod domyślny konta,'
      + ' dla Polski 48. Lista jest przyjmowana w całości albo wcale.',
    oneOf: [
      { type: 'string', example: '48601000001' },
      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500 },
    ],
  },
  text: {
    type: 'string',
    minLength: 1,
    description: 'Treść wiadomości. Znaki spoza alfabetu GSM, w tym polskie, są dozwolone, ale wpływają na kodowanie'
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
      + ' czasu otrzymuje stan expired.',
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
  requestedBy: {
    type: 'string',
    maxLength: 100,
    description: 'Kto zlecił wysyłkę, na przykład adres e-mail osoby z formularza albo autora wpisu na liście.'
      + ' Bramka zapisuje go w dzienniku integracji oraz przy wiadomości i rozsyłce. Nie trafia do treści SMS-a.'
      + ' Najwyżej 100 znaków, bez znaków sterujących.',
    example: 'jan.nowak@firma.pl',
  },
  shortenLinks: {
    type: 'boolean',
    description: 'Skracanie linków w treści. Wartość true zamienia linki do dozwolonych domen docelowych klucza na krótkie'
      + ' linki domeny skracacza, a wartość false pozostawia je bez zmian. Pominięte pole oznacza skracanie przy kluczu'
      + ' w trybie Decyduje wysyłający. Ustawienie klucza ma pierwszeństwo, a blok links w odpowiedzi zgłasza,'
      + ' że zostało zastosowane.',
  },
  campaign: {
    type: 'string',
    minLength: 1,
    maxLength: 100,
    description: 'Nazwa kampanii, od 1 do 100 znaków. Grupuje wysyłki w wynikach kampanii i trafia do parametru'
      + ' utm_campaign. Bez nazwy bramka nadaje nazwę domyślną: identyfikator rozsyłki, nazwę integracji albo nazwę'
      + ' klucza. Kampania powstaje wyłącznie wtedy, gdy treść zawiera co najmniej jeden skrócony link.',
    example: 'przeglad-klimatyzacji-wiosna',
  },
  linkDomain: {
    type: 'string',
    description: 'Domena skracacza spośród domen przypisanych do klucza. Pominięta oznacza domenę domyślną klucza.'
      + ' Domena spoza klucza kończy wywołanie błędem link_domain_not_allowed.',
    example: 'l.firma.pl',
  },
  linkValidityDays: {
    type: 'integer',
    minimum: 1,
    maximum: 365,
    description: 'Ważność krótkich linków w dniach, od 1 do 365. Bramka liczy ją od terminu rozpoczęcia rozsyłki albo'
      + ' od przyjęcia żądania. Pominięte pole oznacza ważność ustawioną przy kluczu, domyślnie 90 dni.',
  },
};

/** Wynik skracania w odpowiedzi na wysyłkę i rozsyłkę. */
const BLOK_LINKOW: JsonSchema = {
  type: 'object',
  description: 'Wynik skracania linków. Bramka dołącza ten blok, gdy skraca albo pomija link oraz gdy wynik różni się'
    + ' od wyboru wysyłającego',
  required: ['shortened', 'domain', 'campaign', 'expiresAt', 'notice', 'skipped'],
  properties: {
    shortened: { type: 'integer', description: 'Liczba skróconych linków. W rozsyłce obejmuje krótkie linki wszystkich'
      + ' odbiorców' },
    domain: { type: 'string', nullable: true, description: 'Domena skracacza użyta w krótkich linkach', example: 'l.firma.pl' },
    campaign: { type: 'string', nullable: true, description: 'Kampania, do której należą krótkie linki',
      example: 'przeglad-klimatyzacji-wiosna' },
    expiresAt: { type: 'string', format: 'date-time', nullable: true, description: 'Chwila wygaśnięcia krótkich linków' },
    notice: {
      type: 'string',
      nullable: true,
      enum: ['disabled_by_key', 'forced_by_key', 'domain_unavailable'],
      description: 'Ustawienie zastosowane zamiast wyboru wysyłającego. Wartość disabled_by_key oznacza skracanie'
        + ' wyłączone przy kluczu, forced_by_key oznacza skracanie wymuszone przy kluczu, a domain_unavailable oznacza'
        + ' wyłączoną domenę skracacza, przez co linki zostały wysłane bez zmian',
    },
    skipped: {
      type: 'array',
      description: 'Linki wysłane bez zmian, ponieważ ich domena nie należy do dozwolonych domen docelowych klucza',
      items: {
        type: 'object',
        required: ['url', 'reason'],
        properties: {
          url: { type: 'string', description: 'Adres wysłany bez zmian', example: 'https://inna-firma.pl/cennik' },
          reason: {
            type: 'string',
            enum: ['domain_not_allowed'],
            description: 'Powód pominięcia. Wartość domain_not_allowed oznacza domenę spoza dozwolonych domen docelowych klucza',
          },
        },
      },
    },
  },
};

/** Opis pola wysyłki po nazwie. Brak opisu przerywa budowanie, także przy body rozsyłki. */
function pole(nazwa: string): JsonSchema {
  const opis = POLA_WIADOMOSCI[nazwa];
  if (!opis) {
    throw new Error(`Pole ${nazwa} ze schematu wysyłki nie ma opisu w src/api/openapi.ts`);
  }
  return opis;
}

/**
 * Właściwości body wysyłki wprost ze schematu trasy: nazwy pól oraz wymagalność pochodzą
 * z zod, opisy z tabeli wyżej. Pole dodane do schematu bez opisu przerywa budowanie.
 */
function cialoZSchematu(shape: Record<string, { isOptional(): boolean }>, inne: Record<string, JsonSchema> = {}): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [nazwa, schemat] of Object.entries(shape)) {
    properties[nazwa] = inne[nazwa] ?? pole(nazwa);
    if (!schemat.isOptional()) required.push(nazwa);
  }
  return { type: 'object', required, properties };
}

const cialoWysylki = (): JsonSchema => cialoZSchematu(messageBodySchema.shape);

/** Numer w „Wyślij SMS” integracji: jeden numer, bez listy. */
const NUMER_INTEGRACJI: JsonSchema = {
  type: 'string',
  minLength: 1,
  description: 'Jeden numer odbiorcy. Numer bez kodu kraju otrzymuje kod domyślny konta, dla Polski 48. Pusty numer'
    + ' kończy wywołanie błędem invalid_body i nigdy nie oznacza wysyłki do listy odbiorców integracji.',
  example: '48601000001',
};

/** Body wywołań integracji z Power Automate: bez usługi, nadpisu i limitu części, które wyznacza integracja. */
const cialoWysylkiIntegracji = (): JsonSchema => cialoZSchematu(paMessageBodySchema.shape, { to: NUMER_INTEGRACJI });
const cialoGrupyIntegracji = (): JsonSchema => cialoZSchematu(paGroupBodySchema.shape);

/** Klucz powtórzenia; ten sam przy wysyłce do numerów, do grupy i przy rozsyłce. */
const PARAMETR_IDEMPOTENCJI: OpenApiParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description: 'Własny klucz powtórzenia. Powtórzone żądanie z tym samym kluczem i tymi samymi danymi'
    + ' zwraca pierwotną odpowiedź zamiast wysyłać wiadomość albo rozsyłkę drugi raz.',
  schema: { type: 'string' },
  example: 'zamowienie-2026-08-26-114',
};

/** Odbiorca rozsyłki; osobny schemat, bo powtarza się w body i w opisie raportu. */
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
    shortenLinks: pole('shortenLinks'),
    campaign: pole('campaign'),
    linkDomain: pole('linkDomain'),
    linkValidityDays: pole('linkValidityDays'),
    startAt: {
      type: 'string',
      format: 'date-time',
      description: 'Termin rozpoczęcia rozsyłki w formacie ISO 8601. Termin musi przypadać w przyszłości, a Multiinfo'
        + ' rozpoczyna wysyłkę o tej godzinie. Pominięty oznacza wysyłkę od razu.',
      example: '2026-08-27T08:00:00.000Z',
    },
  },
};

/** Rozsyłka przez integrację: pola jak w zwykłej rozsyłce bez usługi i nadpisu, ze zlecającym. */
function cialoRozsylkiIntegracji(): JsonSchema {
  const { orig: _orig, serviceId: _serviceId, ...pola } = CIALO_ROZSYLKI.properties!;
  return { ...CIALO_ROZSYLKI, properties: { ...pola, requestedBy: pole('requestedBy') } };
}

const PRZYJETA_ROZSYLKA: JsonSchema = {
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
    links: BLOK_LINKOW,
  },
};

const PRZYKLAD_ROZSYLKI = { id: 'pkg_7c1e9a2b3d4f5a6b7c8d', status: 'queued', recipients: 2, encoding: 'gsm', multipart: false };

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
    links: BLOK_LINKOW,
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

const PARAMETR_ID_INTEGRACJI: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Identyfikator integracji z Power Automate, wybranej z listy integracji klucza. Zmiana nazwy integracji w panelu'
    + ' go nie zmienia.',
  schema: { type: 'string', pattern: '^int_[1-9][0-9]{0,9}$' },
  example: 'int_12',
};

/** Integracja na liście: bez numerów i nazwisk, które zostają w panelu bramki. */
const INTEGRACJA_POWER_AUTOMATE: JsonSchema = {
  type: 'object',
  required: ['id', 'name', 'recipients'],
  properties: {
    id: {
      type: 'string',
      description: 'Stały identyfikator integracji. Zmiana nazwy integracji w panelu go nie zmienia',
      example: 'int_12',
    },
    name: { type: 'string', description: 'Nazwa integracji nadana w panelu bramki', example: 'Ekipa serwisowa' },
    recipients: {
      type: 'integer',
      description: 'Liczba numerów na liście odbiorców integracji, do których wysyła „Wyślij SMS do grupy”',
      example: 3,
    },
  },
};

/** Odpowiedź wysyłki do listy odbiorców integracji: jedna wiadomość na numer, w kolejności listy. */
const WYSYLKA_DO_GRUPY_INTEGRACJI: JsonSchema = {
  type: 'object',
  required: ['integration', 'recipients', 'messages'],
  properties: {
    integration: {
      type: 'object',
      description: 'Integracja, której lista odbiorców posłużyła do wysyłki',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string', description: 'Identyfikator integracji', example: 'int_12' },
        name: { type: 'string', description: 'Nazwa integracji', example: 'Ekipa serwisowa' },
      },
    },
    recipients: { type: 'integer', description: 'Liczba przyjętych wiadomości, po jednej na numer', example: 3 },
    messages: {
      type: 'array',
      description: 'Przyjęte wiadomości. Stan każdej z nich zwraca odczyt wiadomości',
      items: {
        type: 'object',
        // Bez numeru odbiorcy: lista grupy zostaje w panelu bramki.
        required: ['id', 'status', 'parts'],
        properties: {
          id: { type: 'string', description: 'Identyfikator wiadomości', example: 'msg_3f9c2a7b1e4d8c6a5b2f' },
          status: { type: 'string', description: 'Stan wiadomości, zaraz po przyjęciu queued', example: 'queued' },
          parts: { type: 'integer', description: 'Liczba części wiadomości', example: 1 },
        },
      },
    },
  },
};

/** Błędy wspólne trzech wysyłek przez integrację: integracja, ochrona przed burzą, konto. */
const BLEDY_INTEGRACJI: Record<string, OpenApiResponse> = {
  '401': BLAD_KLUCZA,
  '403': blad(
    'Usługa albo nadpis integracji spoza uprawnień klucza: service_not_allowed, orig_not_allowed. Poprawia je'
      + ' administrator w ustawieniach integracji',
    'service_not_allowed',
    'Klucz nie ma dostępu do usługi 24139.',
  ),
  '404': blad(
    'Brak integracji, integracja innego klucza albo innego rodzaju; bramka nie rozróżnia tych sytuacji',
    'integration_not_found',
    'Nie ma integracji z Power Automate o tym identyfikatorze.',
  ),
  '429': blad(
    'Przekroczony limit żądań klucza na minutę albo limit wysyłek integracji (ochrona przed burzą):'
      + ' rate_limited, integration_throttled',
    'integration_throttled',
    'Integracja Ekipa serwisowa przekroczyła limit 30 wysyłek w 10 min. Spróbuj później albo poproś administratora'
      + ' o zmianę limitu.',
  ),
  '503': blad(
    'Integracja nie może teraz wysyłać, bo konto Multiinfo jest wstrzymane albo nie istnieje: integration_unavailable',
    'integration_unavailable',
    'Integracja Ekipa serwisowa nie może teraz wysyłać: konto wstrzymane: certyfikat wygasł.',
  ),
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
    serviceId: { type: 'string', description: 'Usługa Multiinfo, z której wysłano wiadomość', example: '24138' },
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
      description: 'Kod odmowy albo błędu z Multiinfo. Poza błędem pole jest puste',
    },
    error: { type: 'string', nullable: true, description: 'Wyjaśnienie błędu po polsku. Poza błędem pole jest puste' },
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
    serviceId: { type: 'string', description: 'Usługa Multiinfo, z której wysyłana jest rozsyłka', example: '24138' },
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

/** Uprawnienia klucza; listy obiektów, bo listy wyboru w aplikacjach czytają pola obiektów. */
const UPRAWNIENIA_KLUCZA: JsonSchema = {
  type: 'object',
  required: ['name', 'services', 'origs', 'maxParts', 'ratePerMin', 'links'],
  properties: {
    name: { type: 'string', description: 'Nazwa klucza nadana w panelu', example: 'Powiadomienia CRM' },
    services: {
      type: 'array',
      description: 'Usługi Multiinfo, z których klucz może wysyłać',
      items: {
        type: 'object',
        required: ['id', 'default'],
        properties: {
          id: { type: 'string', description: 'Identyfikator usługi Multiinfo', example: '24138' },
          default: { type: 'boolean', description: 'Usługa używana, gdy wysyłka nie podaje pola serviceId' },
        },
      },
    },
    origs: {
      type: 'array',
      description: 'Nadpisy nadawcy, których klucz może użyć w polu orig, w kolejności alfabetycznej. Lista obejmuje'
        + ' nadpis domyślny klucza, a gdy klucz go nie ma, nadpis domyślny konta. Pusta lista oznacza wysyłkę bez'
        + ' nadpisu, z numerem przydzielonym kontu w Multiinfo jako nadawcą.',
      items: {
        type: 'object',
        required: ['orig', 'default'],
        properties: {
          orig: { type: 'string', description: 'Nadpis nadawcy', example: 'Firma Info' },
          default: { type: 'boolean', description: 'Nadpis używany, gdy wysyłka nie podaje pola orig' },
        },
      },
    },
    maxParts: { type: 'integer', description: 'Najwyższa liczba części jednej wiadomości', example: 5 },
    ratePerMin: { type: 'integer', description: 'Limit żądań klucza na minutę', example: 60 },
    links: {
      type: 'object',
      description: 'Skracanie linków przy kluczu, ustawiane w panelu w formularzu klucza',
      required: ['mode', 'domains', 'validityDays', 'utm'],
      properties: {
        mode: {
          type: 'string', enum: ['off', 'sender', 'always'],
          description: 'Tryb skracania: off wyłączone, sender decyduje wysyłający polem shortenLinks, always zawsze',
          example: 'sender',
        },
        domains: {
          type: 'array',
          description: 'Aktywne domeny skracacza klucza w kolejności alfabetycznej. Przy trybie off lista jest pusta',
          items: {
            type: 'object',
            required: ['domain', 'default'],
            properties: {
              domain: { type: 'string', description: 'Domena krótkich linków', example: 'l.firma.pl' },
              default: { type: 'boolean', description: 'Domena używana, gdy wysyłka nie podaje pola linkDomain' },
            },
          },
        },
        validityDays: { type: 'integer', description: 'Domyślna ważność krótkich linków w dniach', example: 90 },
        utm: { type: 'boolean', description: 'Dopisywanie parametrów UTM do adresów docelowych' },
      },
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
      '/v1/key': {
        get: {
          operationId: 'uprawnieniaKlucza',
          summary: 'Uprawnienia klucza',
          description: 'Zwraca uprawnienia klucza, którym wywołanie jest uwierzytelnione: usługi, nadpisy nadawcy'
            + ' i limity. Aplikacja buduje z nich listy wyboru usługi i nadawcy albo sprawdza klucz przed pierwszą'
            + ' wysyłką. Odpowiedź nie zawiera danych konta Multiinfo ani sekretów. Wywołanie liczy się do limitu'
            + ' żądań klucza.',
          security: KLUCZ,
          responses: {
            '200': {
              description: 'Uprawnienia klucza',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/UprawnieniaKlucza' },
                  example: {
                    name: 'Powiadomienia CRM',
                    services: [{ id: '24138', default: true }],
                    origs: [{ orig: 'Firma Alert', default: false }, { orig: 'Firma Info', default: true }],
                    maxParts: 5,
                    ratePerMin: 60,
                    links: { mode: 'sender', domains: [{ domain: 'l.firma.pl', default: true }], validityDays: 90, utm: true },
                  },
                },
              },
            },
            '401': BLAD_KLUCZA,
            '429': blad(
              'Przekroczony limit żądań klucza na minutę',
              'rate_limited',
              'Przekroczono limit 60 żądań na minutę.',
            ),
          },
        },
      },
      '/v1/messages': {
        post: {
          operationId: 'wyslijWiadomosc',
          summary: 'Wysyłka wiadomości',
          description: 'Wysyła jedną wiadomość do jednego numeru albo tę samą treść do kilku numerów, najwyżej 500.'
            + ' Bramka zapisuje wiadomość w kolejce i odpowiada natychmiast. Błędny numer na dowolnej pozycji'
            + ' odrzuca całe żądanie, więc żadna wiadomość nie trafia wtedy do kolejki.',
          security: KLUCZ,
          parameters: [PARAMETR_IDEMPOTENCJI],
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
              'Błąd w body żądania: invalid_body, invalid_phone, invalid_orig, too_many_parts, service_required,'
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
              'Ten sam Idempotency-Key użyty z inną treścią, innym numerem albo przez integrację',
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
          parameters: [PARAMETR_IDEMPOTENCJI],
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
                  schema: PRZYJETA_ROZSYLKA,
                  example: PRZYKLAD_ROZSYLKI,
                },
              },
            },
            '400': blad(
              'Błąd w body żądania: invalid_body, invalid_phone, text_required, invalid_client_id, too_many_parts,'
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
            '409': blad(
              'Ten sam Idempotency-Key użyty z inną rozsyłką albo przez integrację',
              'idempotency_conflict',
              'Ten klucz idempotencji został już użyty z inną rozsyłką albo przez inną integrację.',
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
            + ' wywołanie służy do ponowienia zamówienia, gdy poprzedni raport ma stan failed. Gotowy raport odczytuje się wywołaniem'
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
      '/v1/integrations': {
        get: {
          operationId: 'listaIntegracjiPowerAutomate',
          summary: 'Lista integracji z Power Automate',
          description: 'Zwraca czynne integracje z Power Automate przypisane do klucza, w kolejności nazw. Integracje'
            + ' zakłada administrator w panelu bramki: Integracje, Dodaj integrację, Aplikacja wysyła SMS, Power'
            + ' Automate. Lista podaje nazwę i liczbę odbiorców grupy, bez numerów i nazwisk. Integracja wyłączona'
            + ' w panelu nie występuje na liście. Z tej listy konektor Power Automate buduje pole Integracja.',
          security: KLUCZ,
          responses: {
            '200': {
              description: 'Integracje klucza',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['data'],
                    properties: {
                      data: { type: 'array', items: { $ref: '#/components/schemas/IntegracjaPowerAutomate' }, description: 'Integracje klucza' },
                    },
                  },
                  example: { data: [{ id: 'int_12', name: 'Ekipa serwisowa', recipients: 3 }] },
                },
              },
            },
            '401': BLAD_KLUCZA,
          },
        },
      },
      '/v1/integrations/{id}/messages': {
        post: {
          operationId: 'wyslijSmsIntegracja',
          summary: 'SMS przez integrację',
          description: 'Wysyła jeden SMS na jeden numer przez integrację z Power Automate. Usługę, nadpis nadawcy, limit'
            + ' części i ochronę przed burzą wyznacza integracja. Treść ponad limit części integracja przycina albo'
            + ' odrzuca, zależnie od ustawienia. Każde wywołanie zostawia wpis w dzienniku integracji.',
          security: KLUCZ,
          parameters: [PARAMETR_ID_INTEGRACJI, PARAMETR_IDEMPOTENCJI],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: cialoWysylkiIntegracji(),
                example: { to: '48601000001', text: 'Technik dotrze jutro między 8:00 a 10:00.', requestedBy: 'jan.nowak@firma.pl' },
              },
            },
          },
          responses: {
            '202': {
              description: 'Wiadomość przyjęta do kolejki',
              content: {
                'application/json': {
                  schema: PRZYJETA_WIADOMOSC,
                  example: {
                    id: 'msg_3f9c2a7b1e4d8c6a5b2f', status: 'queued', encoding: 'gsm', parts: 1, characters: 41, slots: 41, slotsRemaining: 119,
                  },
                },
              },
            },
            '400': blad(
              'Błąd w body żądania albo treść ponad limit części integracji: invalid_body, invalid_phone,'
                + ' too_many_parts, valid_to_in_past, valid_to_too_far',
              'too_many_parts',
              'Treść wymaga 4 części, a limit integracji to 3.',
            ),
            ...BLEDY_INTEGRACJI,
            '409': blad(
              'Integracja wyłączona w panelu albo ten sam Idempotency-Key z inną treścią: integration_disabled,'
                + ' idempotency_conflict',
              'integration_disabled',
              'Integracja Ekipa serwisowa jest wyłączona w panelu bramki.',
            ),
          },
        },
      },
      '/v1/integrations/{id}/packages': {
        post: {
          operationId: 'wyslijRozsylkeIntegracja',
          summary: 'Rozsyłka przez integrację',
          description: 'Zleca rozsyłkę do listy odbiorców, najwyżej 5000 pozycji, przez integrację z Power Automate.'
            + ' Pola są takie jak przy zwykłej rozsyłce, bez usługi i nadpisu, które wyznacza integracja. Limit części'
            + ' integracji dotyczy treści wspólnej i każdej treści odbiorcy osobno. Przy ustawieniu „nie wysyłaj”'
            + ' jedna zbyt długa treść odrzuca całą rozsyłkę.',
          security: KLUCZ,
          parameters: [PARAMETR_ID_INTEGRACJI, PARAMETR_IDEMPOTENCJI],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: cialoRozsylkiIntegracji(),
                example: {
                  defaultText: 'Przegląd floty jutro o 8:00 w bazie przy ul. Portowej.',
                  recipients: [{ to: '48601000001' }, { to: '48601000002', text: 'Zmiana grafiku od poniedziałku.', clientId: 'kierowca-14' }],
                  requestedBy: 'kierownik.floty@firma.pl',
                },
              },
            },
          },
          responses: {
            '202': {
              description: 'Rozsyłka przyjęta do kolejki',
              content: { 'application/json': { schema: PRZYJETA_ROZSYLKA, example: PRZYKLAD_ROZSYLKI } },
            },
            '400': blad(
              'Błąd w body żądania albo treść ponad limit części integracji: invalid_body, invalid_phone,'
                + ' text_required, invalid_client_id, too_many_parts, start_at_in_past',
              'too_many_parts',
              'recipients.1: Treść wymaga 4 części, a limit integracji to 3.',
            ),
            ...BLEDY_INTEGRACJI,
            '409': blad(
              'Integracja wyłączona w panelu albo ten sam Idempotency-Key użyty z inną rozsyłką: integration_disabled,'
                + ' idempotency_conflict',
              'integration_disabled',
              'Integracja Ekipa serwisowa jest wyłączona w panelu bramki.',
            ),
          },
        },
      },
      '/v1/integrations/{id}/group': {
        post: {
          operationId: 'wyslijDoGrupyIntegracja',
          summary: 'SMS do odbiorców grupy integracji',
          description: 'Wysyła treść do każdego numeru z listy odbiorców integracji z Power Automate, osobną wiadomością'
            + ' na numer. Listę prowadzi administrator w panelu bramki, w szczegółach integracji. Wysyłka jest'
            + ' przyjmowana w całości albo wcale. Pusta lista kończy wywołanie błędem group_empty.',
          security: KLUCZ,
          parameters: [PARAMETR_ID_INTEGRACJI, PARAMETR_IDEMPOTENCJI],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: cialoGrupyIntegracji(),
                example: { text: 'Awaria w hali B, zgłoszenie 4411. Proszę o kontakt z dyspozytorem.', requestedBy: 'Dyspozytornia' },
              },
            },
          },
          responses: {
            '202': {
              description: 'Wysyłka przyjęta do kolejki',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WysylkaDoGrupy' },
                  example: {
                    integration: { id: 'int_12', name: 'Ekipa serwisowa' },
                    recipients: 2,
                    messages: [
                      { id: 'msg_3f9c2a7b1e4d8c6a5b2f', to: '48601000011', status: 'queued', parts: 1 },
                      { id: 'msg_8a1b2c3d4e5f6a7b8c9d', to: '48601000012', status: 'queued', parts: 1 },
                    ],
                  },
                },
              },
            },
            '400': blad(
              'Błąd w body żądania albo treść ponad limit części integracji: invalid_body, too_many_parts,'
                + ' valid_to_in_past, valid_to_too_far',
              'too_many_parts',
              'Treść wymaga 4 części, a limit integracji to 3.',
            ),
            ...BLEDY_INTEGRACJI,
            '409': blad(
              'Integracja wyłączona w panelu, pusta lista odbiorców albo ten sam Idempotency-Key z inną treścią:'
                + ' integration_disabled, group_empty, idempotency_conflict',
              'group_empty',
              'Integracja Ekipa serwisowa nie ma odbiorców grupy. Listę uzupełnia administrator w panelu bramki.',
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
            + ' Ten sam adres na porcie panelu odpowiada szczegółami. Gdy bramka nie rozpoczęła pracy (tryb'
            + ' awaryjny), stan bramki i każde wywołanie API odpowiadają kodem 503 z kodem błędu unavailable.',
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
            '503': {
              description: 'Tryb awaryjny: bramka nie rozpoczęła pracy, przyczynę pokazuje panel',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/StanNiedostepny' },
                  example: {
                    status: 'unavailable',
                    error: { code: 'unavailable', message: 'Bramka nie rozpoczęła pracy. Przyczynę i sposób jej usunięcia pokazuje panel bramki.' },
                  },
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
            + ' administrator bramki w panelu. Bramka przyjmuje także sam klucz bez przedrostka Bearer.',
        },
      },
      schemas: {
        UprawnieniaKlucza: UPRAWNIENIA_KLUCZA,
        Wiadomosc: WIADOMOSC,
        WiadomoscPrzychodzaca: WIADOMOSC_PRZYCHODZACA,
        Rozsylka: ROZSYLKA,
        WierszRaportu: WIERSZ_RAPORTU,
        IntegracjaPowerAutomate: INTEGRACJA_POWER_AUTOMATE,
        WysylkaDoGrupy: WYSYLKA_DO_GRUPY_INTEGRACJI,
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
        StanNiedostepny: {
          type: 'object',
          description: 'Stan bramki w trybie awaryjnym, razem z opisem błędu w zwykłym kształcie',
          required: ['status', 'error'],
          properties: {
            status: { type: 'string', enum: ['unavailable'], description: 'Bramka nie rozpoczęła pracy' },
            error: { $ref: '#/components/schemas/Blad' },
          },
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
