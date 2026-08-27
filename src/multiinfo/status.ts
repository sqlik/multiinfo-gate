export type GatewayStatus =
  | 'queued' | 'sent' | 'delivered' | 'failed'
  | 'expired' | 'cancelled' | 'blocked' | 'throttled' | 'unknown';

/** Statusy powyżej dziesięciu są w Multiinfo ostateczne i nie zmienią się już. */
export function isFinal(status: number): boolean {
  return status > 10;
}

export function mapStatus(status: number, substatus: number): GatewayStatus {
  switch (status) {
    case 0:
    case 1:
      return 'queued';
    case 3:
      return 'sent';
    case 7:
      return 'throttled';
    case 11:
      return 'failed';
    case 12:
      return 'expired';
    case 13:
      return 'cancelled';
    case 14:
    case 20:
    case 22:
      return 'blocked';
    case 21:
      // Substatus 0 znaczy „wysłano bez żądania potwierdzenia" - doręczenia nie znamy.
      // Substatus 4 znaczy „przekazana dalej", co też nie jest potwierdzeniem odbioru.
      return substatus === 1 || substatus === 2 || substatus === 3 ? 'delivered' : 'sent';
    default:
      return 'unknown';
  }
}

const SUBSTATUS: Record<string, string> = {
  '0/0': 'Oczekiwanie na rozpoczęcie przetwarzania',
  '0/1': 'Oczekiwanie na rozpoczęcie synchronicznego przetwarzania',
  '1/0': 'Oczekiwanie na raport doręczenia',
  '3/0': 'Oczekuje w SMSC',
  '7/0': 'Limit został przekroczony',
  '11/0': 'Wystąpił błąd wewnętrzny',
  '11/1': 'Wiadomość została przedawniona',
  '11/2': 'Wiadomość nie została doręczona',
  '11/3': 'Wiadomość nieprawidłowa',
  '11/4': 'SMSC - brak odpowiedzi',
  '11/5': 'SMSC - ostatni brak odpowiedzi',
  '11/6': 'SMSC - wiadomość anulowana',
  '11/7': 'SMSC - wiadomość usunięta',
  '11/8': 'SMSC - wiadomość usunięta przez anulowanie',
  '11/9': 'Nieprzekazana',
  '11/10': 'Brak konfiguracji',
  '13/0': 'Wiadomość została anulowana',
  '14/0': 'Numer nadawcy znajduje się na czarnej liście',
  '20/0': 'Numer odbiorcy znajduje się na czarnej liście',
  '21/0': 'Wysłano bez żądania potwierdzenia',
  '21/1': 'Otrzymano raport doręczenia',
  '21/2': 'Odebrana automatycznie',
  '21/3': 'Odebrana',
  '21/4': 'Przekazana',
  '22/0': 'Numer na czarnej liście',
};

export function describeSubstatus(status: number, substatus: number): string {
  return SUBSTATUS[`${status}/${substatus}`] ?? `Nieznany status ${status} / ${substatus}`;
}

/** Statusy przesądzające o całości wiadomości, w kolejności ważności. */
const BLOCKING: GatewayStatus[] = ['failed', 'expired', 'blocked', 'cancelled'];

/**
 * Składa status wiadomości wieloczęściowej. Wiadomość jest doręczona dopiero wtedy,
 * gdy doręczone są wszystkie części; jedna nieudana część przesądza o całości.
 */
export function combineStatuses(parts: GatewayStatus[]): GatewayStatus {
  if (parts.length === 0) return 'queued';
  for (const blocking of BLOCKING) {
    if (parts.includes(blocking)) return blocking;
  }
  if (parts.includes('unknown')) return 'unknown';
  if (parts.includes('queued')) return 'queued';
  if (parts.includes('throttled')) return 'throttled';
  if (parts.every((p) => p === 'delivered')) return 'delivered';
  return 'sent';
}
