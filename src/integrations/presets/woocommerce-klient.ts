import type { InboundConfig } from '../config.ts';
import type { Preset } from './types.ts';

const TEKST: InboundConfig['text'] = { mode: 'liquid', template: '{{ p.billing.first_name | gsm }}, Twoje zamowienie #{{ p.number }} jest w realizacji' };

/**
 * Warunek wspólny dla każdego wariantu: zamówienie ma numer wewnętrzny `id`.
 * Odsiewa żądanie próbne, które sklep wysyła po zapisaniu webhooka; ma ono ciało `webhook_id=1`
 * w formacie formularza, więc bez tego warunku bramka szukałaby w nim telefonu kupującego.
 */
const MA_ZAMOWIENIE = { path: 'id', op: 'exists' as const, value: '' };

export const woocommerceKlient: Preset = {
  id: 'woocommerce-klient',
  name: 'WooCommerce: status do klienta',
  blurb: 'SMS do kupującego, gdy zmienia się status zamówienia (webhook Order updated)',
  kinds: ['webhook_in'],
  // Ładunek Order updated z żywego sklepu, zmiana statusu na „W trakcie realizacji”.
  sample: {
    id: 14, number: '14', status: 'processing', currency: 'PLN', total: '49.00',
    date_modified: '2026-09-14T15:34:45',
    billing: { first_name: 'Anna', last_name: 'Kowalska', phone: '+48 601 000 001', email: 'anna.kowalska@example.test', city: 'Warszawa' },
    line_items: [{ id: 3, name: 'Kubek testowy', quantity: 1, total: '49.00' }],
  },
  fields: [
    { path: 'number', label: 'numer zamówienia widoczny w sklepie' },
    { path: 'status', label: 'nowy status zamówienia' },
    { path: 'billing.first_name', label: 'imię kupującego' },
    { path: 'billing.phone', label: 'telefon kupującego; puste, gdy nie podał' },
    { path: 'total', label: 'kwota łączna' },
    { path: 'date_modified', label: 'czas zmiany' },
  ],
  inbound: {
    to: { path: 'billing.phone', fallback: [] },
    text: TEKST,
    condition: { mode: 'builder', rules: [MA_ZAMOWIENIE, { path: 'status', op: 'eq', value: 'processing' }] },
    throttle: { limit: 60, windowMinutes: 10 },
    maxParts: 1, overflow: 'truncate',
  },
  expect: { recipients: ['48601000001'], text: 'Anna, Twoje zamowienie #14 jest w realizacji' },
  sampleSource: 'WooCommerce 11.1.0, WordPress 7.1, żywy sklep lokalnie, 2026-09-14: webhook Order updated, zmiana statusu na „W trakcie realizacji”',
  warning: 'Jeśli masz w Polkomtel uruchomiony Dynamiczny Nadpis, możesz go użyć w miejsce numeru nadawcy. W innym przypadku klient zobaczy numer przypisany do Twojego konta Multiinfo w formacie 486610xxxxx. Nadpis nie jest obowiązkowy. Wiadomość o treści marketingowej wymaga zgody odbiorcy.',
  simple: {
    inbound: {
      addressField: 'w sklepie w polu Adres dostarczenia webhooka',
      recipients: { source: 'payload', note: 'Numer bierzemy z danych kupującego. Lista zapasowa zostaje pusta: gdy kupujący nie podał telefonu, SMS nie ma iść do nikogo innego.' },
      when: [
        { id: 'realizacja', label: 'gdy zamówienie trafia do realizacji', condition: { mode: 'builder', rules: [MA_ZAMOWIENIE, { path: 'status', op: 'eq', value: 'processing' }] } },
        { id: 'zrealizowane', label: 'gdy zamówienie jest zrealizowane', condition: { mode: 'builder', rules: [MA_ZAMOWIENIE, { path: 'status', op: 'eq', value: 'completed' }] } },
        { id: 'kazda-zmiana', label: 'przy każdej zmianie statusu', condition: { mode: 'builder', rules: [MA_ZAMOWIENIE] } },
      ],
      text: [
        { id: 'krotkie', label: 'imię oraz numer zamówienia', text: TEKST },
        { id: 'z-kwota', label: 'imię, numer zamówienia oraz kwota', text: { mode: 'liquid', template: '{{ p.billing.first_name | gsm }}, zamowienie #{{ p.number }} na {{ p.total }} {{ p.currency }} jest w realizacji' } },
        { id: 'zrealizowane', label: 'wiadomość o wysyłce', text: { mode: 'liquid', template: '{{ p.billing.first_name | gsm }}, zamowienie #{{ p.number }} zostalo wyslane' } },
      ],
      auth: { kind: 'none', note: 'WooCommerce nie pozwala dodać własnego nagłówka ani hasła, więc integracji broni sam adres wejściowy. Trzymaj go w tajemnicy, a gdy wycieknie, wymień go przyciskiem obok adresu.' },
    },
  },
  guide: [
    'W sklepie wybierz **WooCommerce → Ustawienia → Zaawansowane → Webhooki → Dodaj webhook**. **Status** ustaw na `Aktywny`, **Temat** na `Order updated`, a **Adres dostarczenia** to adres wejściowy integracji.',
    '',
    'WooCommerce wysyła żądanie przy każdej zmianie zamówienia, nie tylko przy zmianie statusu. Dlatego warunek integracji zawęża wysyłkę do wybranego statusu. Bez warunku klient dostanie SMS także po edycji adresu albo notatki.',
    '',
    'Sklep wysyła jedno żądanie na jedną zmianę, ale kilka zmian pod rząd potrafi zlać w jedno. Gdy w ciągu kilkunastu sekund przestawisz zamówienie z „W trakcie realizacji” na „Zrealizowane”, do bramki dojdzie tylko stan końcowy. Jeśli klient ma dostać obie wiadomości, zmieniaj status dopiero wtedy, gdy naprawdę się zmienia.',
    '',
    'Numer telefonu bierzemy z pola rozliczeniowego zamówienia. Jeśli kupujący go nie podał, integracja zapisuje błąd w dzienniku i nic nie wysyła. Aby telefon był zawsze, ustaw go jako pole wymagane w **WooCommerce → Ustawienia → Ogólne**.',
    '',
    'Adres bramki musi kończyć się portem 443, 80 albo 8080, bo WordPress nie dostarcza webhooków na inne porty.',
  ].join('\n'),
};
