import type { InboundConfig } from '../config.ts';
import { MA_FAKTURE, PROBKA_FAKTURY } from './fakturownia.ts';
import type { Preset } from './types.ts';

const TEKST: InboundConfig['text'] = {
  mode: 'liquid',
  template: '{{ p.deal.client.name | gsm | sms_truncate: 30 }}, faktura {{ p.deal.invoice_no }} na {{ p.deal.price }} {{ p.deal.currency }}: {{ p.deal.url }}',
};

/**
 * Znacznik nazwy konta w adresie zapytania. Nazwa konta nie przychodzi w ładunku: pole `app_name`
 * to zawsze wyraz „fakturownia”, a odnośnik do dokumentu prowadzi na inną domenę. Podaje ją więc
 * użytkownik, a formularz podmienia znacznik przy zapisie.
 */
const ZNACZNIK_KONTA = 'NAZWA-KONTA';

export const fakturowniaKlient: Preset = {
  id: 'fakturownia-klient',
  name: 'Fakturownia: powiadomienie klienta',
  blurb: 'SMS do nabywcy z numerem faktury oraz odnośnikiem do dokumentu',
  kinds: ['webhook_in'],
  sample: PROBKA_FAKTURY,
  /** Kartoteka nabywcy z odpowiedzi GET /clients/<id>.json, przycięta do pól w użyciu. */
  enrichSample: { id: 276200905, name: 'Anna Kowalska', phone: '+48 22 123 45 67', mobile_phone: '+48 601 000 001' },
  fields: [
    { path: 'deal.invoice_no', label: 'numer faktury' },
    { path: 'deal.price', label: 'kwota brutto' },
    { path: 'deal.currency', label: 'waluta' },
    { path: 'deal.url', label: 'odnośnik do dokumentu dla klienta' },
    { path: 'deal.client.name', label: 'nazwa nabywcy z faktury' },
    { path: 'deal.client.external_ids.fakturownia', label: 'identyfikator nabywcy, po nim bramka pyta o kartotekę' },
    { path: 'e.mobile_phone', label: 'komórka nabywcy z kartoteki, z zapytania uzupełniającego' },
    { path: 'e.name', label: 'nazwa nabywcy z kartoteki' },
  ],
  inbound: {
    condition: { mode: 'builder', rules: [MA_FAKTURE] },
    to: { path: 'e.mobile_phone', fallback: [] },
    text: TEKST,
    auth: { sources: [], payload: { path: 'api_token', valueRef: 'payloadToken' } },
    enrich: {
      url: `https://${ZNACZNIK_KONTA}.fakturownia.pl/clients/{{ p.deal.client.external_ids.fakturownia | url_encode }}.json`,
      method: 'GET', headers: [], query: [{ name: 'api_token', valueRef: 'enrichToken' }],
      // Kartoteka bez komórki albo chwilowa niedostępność aplikacji ma pominąć fakturę, a nie zgłosić błąd:
      // Fakturownia wyłącza webhooka po serii nieudanych dostarczeń.
      timeoutMs: 2000, as: 'e', onError: 'skip',
    },
    invalidRecipient: 'skip',
    throttle: { limit: 60, windowMinutes: 10 },
    maxParts: 2, overflow: 'truncate',
  },
  secrets: [
    { ref: 'payloadToken', label: 'Token z webhooka', hint: 'Ta sama wartość, która jest wpisana w Fakturowni w polu „Api token”' },
    { ref: 'enrichToken', label: 'Kod autoryzacyjny API', hint: 'W Fakturowni: Ustawienia, Ustawienia konta, zakładka Integracja, przycisk „Zobacz ApiTokeny”' },
  ],
  expect: {
    recipients: ['48601000001'],
    text: 'Anna Kowalska, faktura 1/09/2026 na 123.0 PLN: https://firma.fakturownia.net/f/1-09-2026/przykladowyodnosnik',
  },
  sampleSource: 'Fakturownia 6.152.8, konto próbne, 2026-09-15: webhook invoice:create oraz odpowiedź GET /clients/<id>.json z kartoteką nabywcy',
  warning: 'SMS trafia do klienta. Nazwa nadawcy musi być zarejestrowana, a wysyłka na numer klienta musi mieć podstawę prawną.',
  simple: {
    inbound: {
      addressField: 'w Fakturowni w Ustawieniach konta, w zakładce Integracja, w sekcji Webhooki, w polu Adres',
      recipients: {
        source: 'payload',
        note: 'Numer pochodzi z kartoteki nabywcy w Fakturowni, z pola „Telefon komórkowy”. Lista zapasowa pozostaje pusta: gdy kartoteka nie zawiera numeru komórkowego, SMS nie jest wysyłany.',
      },
      when: [
        { id: 'wystawienie', label: 'przy wystawieniu faktury', condition: { mode: 'builder', rules: [MA_FAKTURE] } },
        { id: 'tylko-nieoplacone', label: 'tylko przy fakturach jeszcze nieopłaconych', condition: { mode: 'builder', rules: [MA_FAKTURE, { path: 'deal.paid', op: 'ne', value: 'true' }] } },
      ],
      text: [
        { id: 'nabywca-numer-odnosnik', label: 'nazwa nabywcy, numer faktury oraz odnośnik', text: TEKST },
        { id: 'numer-odnosnik', label: 'numer faktury oraz odnośnik', text: { mode: 'liquid', template: 'Faktura {{ p.deal.invoice_no }} na {{ p.deal.price }} {{ p.deal.currency }}: {{ p.deal.url }}' } },
      ],
      auth: {
        kind: 'payload', path: 'api_token',
        label: 'Token, który Fakturownia wyśle w treści',
        where: 'w Fakturowni, w tym samym wierszu webhooka, w polu „Api token”',
      },
      enrich: {
        secretLabel: 'Kod autoryzacyjny API',
        where: 'w Fakturowni: Ustawienia, Ustawienia konta, zakładka Integracja, przycisk „Zobacz ApiTokeny”',
        account: {
          label: 'Nazwa konta w Fakturowni',
          hint: 'Pierwszy człon adresu panelu: dla firma.fakturownia.pl jest to firma',
          placeholder: 'firma', marker: ZNACZNIK_KONTA,
        },
      },
    },
  },
  guide: [
    '**Gdzie to ustawić.** W Fakturowni wejdź w **Ustawienia**, potem **Ustawienia konta**, zakładka **Integracja**. Na dole strony znajdziesz sekcję **Webhooki**.',
    '',
    'W pierwszym wolnym wierszu ustaw **Rodzaj** na `invoice:create`. W polu **Adres** wklej adres wejściowy integracji. W polu **Api token** wpisz to samo hasło, które zostało wpisane w bramce. Zaznacz **Aktywny** i zapisz stronę.',
    '',
    '**Źródło numeru klienta.** Webhook faktury nie niesie numeru telefonu nabywcy, tylko jego identyfikator. Dlatego bramka pyta Fakturownię o kartotekę tego nabywcy i odczytuje z niej pole **Telefon komórkowy**. Do zapytania potrzebuje dwóch rzeczy: nazwy konta oraz kodu autoryzacyjnego API.',
    '',
    'Kod autoryzacyjny znajdziesz w tym samym miejscu: **Ustawienia**, **Ustawienia konta**, zakładka **Integracja**, przycisk **Zobacz ApiTokeny**. Wklej go do bramki. Bramka przechowuje go w postaci zaszyfrowanej.',
    '',
    `W trybie zaawansowanym adres zapytania trzyma znacznik \`${ZNACZNIK_KONTA}\`. Zastąp go nazwą konta, tą samą, która występuje w adresie panelu Fakturowni. Tryb prosty wykonuje tę podmianę automatycznie.`,
    '',
    '**Czego się spodziewać.** Klient otrzyma SMS w ciągu minuty od wystawienia faktury. Kartoteka bez numeru komórkowego oznacza pominięcie faktury: bramka zapisze wpis w dzienniku i odpowie Fakturowni kodem 200, żeby ta nie wyłączyła webhooka. Numer stacjonarny z pola **Telefon** nie jest brany pod uwagę, ponieważ SMS nie zostanie na niego doręczony.',
    '',
    'Do powiadamiania obsługi zamiast klienta służy ustawienie **Fakturownia: powiadomienie obsługi**.',
  ].join('\n'),
};
