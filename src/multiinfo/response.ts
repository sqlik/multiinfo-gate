export type ProviderResponse =
  | { ok: true; lines: string[] }
  | { ok: false; code: number; message: string };

export type ErrorKind = 'transient' | 'permanent' | 'certificate';

export class ProviderError extends Error {
  constructor(readonly code: number, message: string, readonly kind: ErrorKind) {
    super(message || `Multiinfo zwróciło kod ${code}`);
    this.name = 'ProviderError';
  }
}

const TRANSIENT = new Set([-10, -15, -71]);

/**
 * Rozdziela kody na trzy kategorie, bo każda wymaga innego postępowania:
 * przejściowe da się ponowić, trwałe nie, a certyfikatowe wstrzymują całe konto.
 */
export function classifyCode(code: number): ErrorKind {
  if (code <= -80 && code >= -86) return 'certificate';
  if (TRANSIENT.has(code)) return 'transient';
  return 'permanent';
}

/**
 * Odpowiedzi Multiinfo są zwykłym tekstem: pierwsza linia to status
 * (0 powodzenie, wartość ujemna błąd), kolejne to dane albo opis błędu.
 * Puste linie w środku są znaczące - infosms.aspx zwraca pusty wiersz nadawcy.
 */
export function parseResponse(body: string): ProviderResponse {
  const lines = body.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const first = lines[0]?.trim() ?? '';
  const code = Number.parseInt(first, 10);

  if (!/^-?\d+$/.test(first) || Number.isNaN(code)) {
    throw new Error(`Odpowiedź Multiinfo ma nieoczekiwany kształt: ${body.slice(0, 120)}`);
  }
  if (code < 0) {
    return { ok: false, code, message: (lines[1] ?? '').trim() };
  }
  return { ok: true, lines: lines.slice(1) };
}

export type PackageFullInfoResponse =
  | { ok: true; packageId: string; reportId: string; generation: 0 | 1 | 2 | 3; minutesLeft: number }
  | { ok: false; code: number; message: string };

/**
 * packagefullinfo.aspx przy powodzeniu zwraca linię statusu `0`, a po niej identyfikator
 * rozsyłki, identyfikator raportu, etap generowania (0 nie rozpoczęto, 1 w toku, 2 gotowy,
 * 3 błąd) i minuty do wygaśnięcia. Dokumentacja PDF pomija linię statusu - prawdziwe
 * Multiinfo ją wysyła (sprawdzone 2026-08-26 na api2), więc obsługujemy oba kształty:
 * rozsyłka nigdy nie ma identyfikatora `0`, więc `0` w pierwszej linii to zawsze status.
 */
export function parsePackageFullInfo(body: string): PackageFullInfoResponse {
  const lines = body.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').map((l) => l.trim());
  const first = lines[0] ?? '';
  if (!/^-?\d+$/.test(first)) {
    throw new Error(`Odpowiedź packagefullinfo ma nieoczekiwany kształt: ${body.slice(0, 120)}`);
  }
  const code = Number.parseInt(first, 10);
  if (code < 0) return { ok: false, code, message: lines[1] ?? '' };
  const fields = code === 0 ? lines.slice(1) : lines;
  const generation = Number.parseInt(fields[2] ?? '', 10);
  return {
    ok: true,
    packageId: fields[0] ?? '',
    reportId: fields[1] ?? '',
    generation: (generation >= 0 && generation <= 3 ? generation : 3) as 0 | 1 | 2 | 3,
    minutesLeft: Number.parseInt(fields[3] ?? '0', 10) || 0,
  };
}

export interface InboundSms {
  miId: string; sender: string; dest: string; kind: 'text' | 'binary'; content: string;
  protocolId: number; codingScheme: number; serviceId: string; connectorId: string;
  /** yyyyMMddhhmmss w czasie polskim, tak jak podał Plus. */
  receivedAt: string;
}

/** Numery wierszy odpowiedzi getsms.aspx po zdjęciu linii statusu (§3.1). */
const INBOUND_LINE = { miId: 0, sender: 1, dest: 2, kind: 3, content: 4, protocolId: 5, codingScheme: 6, serviceId: 7, connectorId: 8, receivedAt: 9 } as const;

/** Treść tekstowa jest zakodowana jak w formularzu; zły bajt nie może zgubić wiadomości. */
function decodeForm(raw: string): string {
  const spaced = raw.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return raw;
  }
}

/**
 * Wiersze getsms.aspx po zdjęciu linii statusu; `null` dla identyfikatora -1 (brak wiadomości).
 * Treść tekstowa przychodzi zakodowana jak w formularzu (spacja jako plus). Binarna to hex
 * „nagłówek[spacja]dane” i zostaje bez zmian - bramka jej nie interpretuje.
 */
export function parseInboundSms(lines: string[]): InboundSms | null {
  const miId = (lines[INBOUND_LINE.miId] ?? '').trim();
  if (miId === '-1' || miId === '') return null;
  const kind = (lines[INBOUND_LINE.kind] ?? '1').trim() === '2' ? 'binary' : 'text';
  const raw = lines[INBOUND_LINE.content] ?? '';
  const content = kind === 'text' ? decodeForm(raw) : raw.trim();
  return {
    miId,
    sender: (lines[INBOUND_LINE.sender] ?? '').trim(),
    dest: (lines[INBOUND_LINE.dest] ?? '').trim(),
    kind,
    content,
    protocolId: Number.parseInt(lines[INBOUND_LINE.protocolId] ?? '0', 10) || 0,
    codingScheme: Number.parseInt(lines[INBOUND_LINE.codingScheme] ?? '0', 10) || 0,
    serviceId: (lines[INBOUND_LINE.serviceId] ?? '').trim(),
    connectorId: (lines[INBOUND_LINE.connectorId] ?? '').trim(),
    receivedAt: (lines[INBOUND_LINE.receivedAt] ?? '').trim(),
  };
}
