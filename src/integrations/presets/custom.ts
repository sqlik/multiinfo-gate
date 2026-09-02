import type { Preset } from './types.ts';

export const custom: Preset = {
  id: 'custom',
  name: 'Własne',
  blurb: 'Pusty formularz - aplikacja spoza listy',
  kinds: ['webhook_in', 'webhook_out'],
  fields: [],
  inbound: {},
  outbound: {},
  guide: [
    '**Do SMS.** Wskaż ścieżką pole z numerem (np. `contact.phone`, `alerts[0].labels.phone`) albo zostaw pustą i wpisz numery w liście zapasowej. Treść to ścieżka do pola albo szablon Liquid z ładunkiem pod `p`. Wklej przykładowy ładunek aplikacji w polu próbki i użyj „Sprawdź szablon”.',
    '',
    '**Z SMS-a.** Podaj adres, metodę i nagłówki aplikacji; body jako JSON (pola tekstowe przez filtr `json`), formularz albo surowy tekst. Zmienne: `from`, `to`, `text`, `receivedAt`, `serviceId`, `id`, a dla statusów `status`, `error`, `miStatus`.',
  ].join('\n'),
};
