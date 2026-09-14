import type { InboundConfig } from '../config.ts';
import type { Preset } from './types.ts';

/** Domyślna treść - pierwszy wariant w trybie prostym i szablon w zaawansowanym. */
const TEKST: InboundConfig['text'] = { mode: 'liquid', template: 'Nowe zamowienie #{{ p.number }} na {{ p.total }} {{ p.currency }} od {{ p.billing.first_name | gsm }} {{ p.billing.last_name | gsm }}' };

/**
 * Warunek wspólny dla każdego wariantu: zamówienie ma numer wewnętrzny `id`.
 * Po zapisaniu webhooka sklep wysyła żądanie próbne z ciałem `webhook_id=1` w formacie formularza.
 * Bez tego warunku bramka wzięłaby je za zamówienie i wysłała SMS bez treści, a sklep pokazałby błąd,
 * bo żądanie próbne uznaje za udane wyłącznie odpowiedź z kodem 200.
 */
const MA_ZAMOWIENIE = { path: 'id', op: 'exists' as const, value: '' };

export const woocommerce: Preset = {
  id: 'woocommerce',
  name: 'WooCommerce: nowe zamówienie',
  blurb: 'SMS do obsługi sklepu o każdym nowym zamówieniu (webhook Order created)',
  kinds: ['webhook_in'],
  // Ładunek Order created z żywego sklepu przycięty do pól, które coś znaczą (pełny ma 47 pól zamówienia).
  sample: {
    id: 14, number: '14', status: 'processing', currency: 'PLN', total: '49.00',
    date_created: '2026-09-14T15:33:48', payment_method_title: 'Płatność przy odbiorze',
    billing: { first_name: 'Anna', last_name: 'Kowalska', phone: '+48 601 000 001', email: 'anna.kowalska@example.test', city: 'Warszawa' },
    line_items: [{ id: 3, name: 'Kubek testowy', quantity: 1, total: '49.00' }],
  },
  fields: [
    { path: 'number', label: 'numer zamówienia widoczny w sklepie' },
    { path: 'status', label: 'status zamówienia, np. pending, processing, completed' },
    { path: 'total', label: 'kwota łączna, tekst z dwoma miejscami po przecinku' },
    { path: 'currency', label: 'waluta' },
    { path: 'payment_method_title', label: 'nazwa sposobu płatności' },
    { path: 'billing.first_name', label: 'imię kupującego' },
    { path: 'billing.last_name', label: 'nazwisko kupującego' },
    { path: 'billing.phone', label: 'telefon kupującego; pusty tekst, gdy nie podał' },
    { path: 'line_items', label: 'pozycje zamówienia' },
  ],
  inbound: {
    to: { fallback: [] },
    text: TEKST,
    condition: { mode: 'builder', rules: [MA_ZAMOWIENIE] },
    throttle: { limit: 60, windowMinutes: 10 },
    maxParts: 1, overflow: 'truncate',
  },
  expect: { text: 'Nowe zamowienie #14 na 49.00 PLN od Anna Kowalska' },
  sampleSource: 'WooCommerce 11.1.0, WordPress 7.1, żywy sklep lokalnie, 2026-09-14: webhook Order created',
  simple: {
    inbound: {
      addressField: 'w sklepie w polu Adres dostarczenia webhooka',
      recipients: { source: 'list', note: 'SMS o nowym zamówieniu idzie do obsługi sklepu, więc numery wpisujesz tutaj.' },
      when: [
        { id: 'kazde', label: 'przy każdym nowym zamówieniu', condition: { mode: 'builder', rules: [MA_ZAMOWIENIE] } },
        { id: 'poza-czekajacymi', label: 'bez zamówień czekających na płatność', condition: { mode: 'builder', rules: [MA_ZAMOWIENIE, { path: 'status', op: 'ne', value: 'pending' }] } },
      ],
      text: [
        { id: 'numer-kwota', label: 'numer, kwota, kupujący', text: TEKST },
        { id: 'z-platnoscia', label: 'numer, kwota, kupujący, sposób płatności', text: { mode: 'liquid', template: 'Nowe zamowienie #{{ p.number }} na {{ p.total }} {{ p.currency }} od {{ p.billing.first_name | gsm }} {{ p.billing.last_name | gsm }}, {{ p.payment_method_title | gsm }}' } },
        { id: 'z-pozycjami', label: 'numer, kwota, liczba pozycji', text: { mode: 'liquid', template: 'Nowe zamowienie #{{ p.number }} na {{ p.total }} {{ p.currency }}, pozycji: {{ p.line_items.size }}' } },
      ],
      auth: { kind: 'none', note: 'WooCommerce nie pozwala dodać własnego nagłówka ani hasła, więc integracji broni sam adres wejściowy. Trzymaj go w tajemnicy, a gdy wycieknie, wymień go przyciskiem obok adresu.' },
    },
  },
  guide: [
    'W sklepie wybierz **WooCommerce → Ustawienia → Zaawansowane → Webhooki → Dodaj webhook**. **Status** ustaw na `Aktywny`, **Temat** na `Order created`, a **Adres dostarczenia** to adres wejściowy integracji. **Wersję API** zostaw najnowszą z listy.',
    '',
    'WooCommerce wysyła całe zamówienie jako JSON. Pole **Klucz** służy do podpisywania żądań; bramka będzie go sprawdzać od wersji 1.8, na razie zostaw wygenerowaną wartość.',
    '',
    'Adres bramki musi kończyć się portem 443, 80 albo 8080. WordPress nie dostarcza webhooków na inne porty i w dzienniku sklepu zapisuje wtedy „Podano nieprawidłowy adres URL”. Przy zwykłym adresie z certyfikatem nie musisz nic robić, bo to jest port 443.',
    '',
    'Zaraz po zapisaniu webhooka sklep wysyła pod ten adres żądanie próbne. Bramka odpowiada na nie kodem 200 i nie wysyła z niego SMS-a, więc zapis kończy się bez błędu.',
    '',
    'Jeśli bramka będzie długo nieosiągalna, sklep sam wyłączy webhook po siódmej nieudanej próbie z rzędu. Wtedy trzeba wrócić do listy webhooków i przestawić **Status** z powrotem na `Aktywny`.',
  ].join('\n'),
};
