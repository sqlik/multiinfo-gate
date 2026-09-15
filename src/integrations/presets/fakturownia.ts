import type { InboundConfig } from '../config.ts';
import type { Preset } from './types.ts';

/** Domyślna treść - pierwszy wariant w trybie prostym i szablon w zaawansowanym. */
const TEKST: InboundConfig['text'] = {
  mode: 'liquid',
  template: 'Faktura {{ p.deal.invoice_no }} na {{ p.deal.price }} {{ p.deal.currency }} dla {{ p.deal.client.name | gsm | sms_truncate: 40 }}',
};

/**
 * Warunek odsiewający: ładunek ma numer faktury. Fakturownia wysyła webhooki także dla zdarzeń
 * klienta oraz produktu, a te mają zupełnie inny kształt i wyszedłby z nich SMS bez treści.
 */
export const MA_FAKTURE = { path: 'deal.invoice_no', op: 'exists' as const, value: '' };

/** Ładunek zdarzenia invoice:create przycięty do pól, które coś znaczą, z danymi przykładowymi. */
export const PROBKA_FAKTURY = {
  id: 564047351,
  deal: {
    name: 'Usluga testowa', price: '123.0', paid: false, date: '2026-09-15',
    invoice_no: '1/09/2026', kind: 'vat', status: 'issued', currency: 'PLN',
    url: 'https://firma.fakturownia.net/f/1-09-2026/przykladowyodnosnik',
    client: { name: 'Anna Kowalska', external_ids: { fakturownia: 276200905 } },
  },
  app_name: 'fakturownia', api_token: 'token-z-ustawien', locale: 'pl',
};

export const fakturownia: Preset = {
  id: 'fakturownia',
  name: 'Fakturownia: powiadomienie obsługi',
  blurb: 'SMS na Twój numer, gdy w Fakturowni powstaje nowa faktura',
  kinds: ['webhook_in'],
  sample: PROBKA_FAKTURY,
  fields: [
    { path: 'deal.invoice_no', label: 'numer faktury' },
    { path: 'deal.price', label: 'kwota brutto, tekst z kropką dziesiętną' },
    { path: 'deal.currency', label: 'waluta' },
    { path: 'deal.client.name', label: 'nazwa nabywcy' },
    { path: 'deal.url', label: 'odnośnik do dokumentu dla klienta' },
    { path: 'deal.status', label: 'status faktury, np. issued, paid' },
    { path: 'deal.paid', label: 'czy faktura jest opłacona' },
  ],
  inbound: {
    condition: { mode: 'builder', rules: [MA_FAKTURE] },
    to: { fallback: [] },
    text: TEKST,
    auth: { sources: [], payload: { path: 'api_token', valueRef: 'payloadToken' } },
    // Faktury wychodzą seriami, na przykład przy miesięcznym fakturowaniu - dziesięć na dziesięć minut byłoby za mało.
    throttle: { limit: 60, windowMinutes: 10 },
    maxParts: 1, overflow: 'truncate',
  },
  secrets: [{ ref: 'payloadToken', label: 'Token z webhooka', hint: 'Ta sama wartość, którą wpisujesz w Fakturowni w polu „Api token”' }],
  expect: { recipients: [], text: 'Faktura 1/09/2026 na 123.0 PLN dla Anna Kowalska' },
  sampleSource: 'Fakturownia 6.152.8, konto próbne, 2026-09-15: webhook invoice:create po wystawieniu faktury w panelu',
  simple: {
    inbound: {
      addressField: 'w Fakturowni w Ustawieniach konta, w zakładce Integracja, w sekcji Webhooki, w polu Adres',
      recipients: { source: 'list', note: 'SMS idzie na numery wpisane tutaj, czyli do Ciebie albo do Twojej obsługi. Faktura nie niesie numeru klienta.' },
      when: [
        { id: 'wystawienie', label: 'przy wystawieniu faktury', condition: { mode: 'builder', rules: [MA_FAKTURE] } },
        { id: 'tylko-nieoplacone', label: 'tylko przy fakturach jeszcze nieopłaconych', condition: { mode: 'builder', rules: [MA_FAKTURE, { path: 'deal.paid', op: 'ne', value: 'true' }] } },
      ],
      text: [
        { id: 'numer-kwota', label: 'numer faktury z kwotą', text: TEKST },
        { id: 'numer-odnosnik', label: 'numer faktury z odnośnikiem do dokumentu', text: { mode: 'liquid', template: 'Faktura {{ p.deal.invoice_no }}: {{ p.deal.url }}' } },
      ],
      auth: {
        kind: 'payload', path: 'api_token',
        label: 'Token, który Fakturownia wyśle w treści',
        where: 'w Fakturowni w tym samym wierszu webhooka, w polu „Api token” - wpisz tam dowolne długie hasło i powtórz je tutaj',
      },
    },
  },
  warning: 'Zdarzenie wybierz na invoice:create. Inne rodzaje webhooka mają inny kształt i zostaną pominięte.',
  guide: [
    '**Gdzie to ustawić.** W Fakturowni wejdź w **Ustawienia**, potem **Ustawienia konta**, zakładka **Integracja**. Na dole strony znajdziesz sekcję **Webhooki**.',
    '',
    'W pierwszym wolnym wierszu ustaw **Rodzaj** na `invoice:create`. W polu **Adres** wklej adres wejściowy integracji. W polu **Api token** wpisz to samo hasło, które podałeś w bramce. Zaznacz **Aktywny** i zapisz stronę.',
    '',
    '**Czego się spodziewać.** Fakturownia wysyła webhooka z opóźnieniem do minuty od zapisania faktury. Ładunek zawiera numer dokumentu, kwotę oraz nazwę nabywcy, ale nie zawiera jego numeru telefonu. Dlatego to ustawienie wysyła SMS na numery wpisane w bramce.',
    '',
    'Jeśli chcesz powiadamiać klienta, użyj ustawienia **Fakturownia: powiadomienie klienta**. Ono dopytuje Fakturownię o kartotekę nabywcy.',
  ].join('\n'),
};
