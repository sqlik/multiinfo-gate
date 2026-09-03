import type { InboundConfig } from '../config.ts';
import type { Preset } from './types.ts';

/** Domyślna treść SMS-a - pierwszy wariant w trybie prostym i szablon w zaawansowanym. */
// Odpowiedź klienta z e-maila niesie cytowaną korespondencję (blockquote po „----- Original message -----”) - ucinamy przed nią.
const TEKST: InboundConfig['text'] = { mode: 'liquid', template: '{% assign tresc = p.text | split: "<blockquote" | first | split: "----- Original message -----" | first %}{% capture t %}{% if p.event == "odpowiedz" %}Odpowiedź klienta w #{{ p.ticket_id }}{% else %}Nowe zgłoszenie #{{ p.ticket_id }}{% endif %}{% if p.subject %}: {{ p.subject }}{% endif %} - {{ tresc | html_text | sms_truncate: 100 }}{% endcapture %}{{ t | gsm }}' };

export const freshdeskZgloszenie: Preset = {
  id: 'freshdesk-zgloszenie',
  name: 'Freshdesk: nowe zgłoszenie',
  blurb: 'SMS do agentów o nowym zgłoszeniu albo odpowiedzi klienta we Freshdesku',
  kinds: ['webhook_in'],
  // Ładunek definiuje reguła automatyzacji Freshdeska (treść zaawansowana); ten przyszedł z żywej instancji.
  sample: { event: 'nowe', ticket_id: '6541', phone: '', mobile: '601000001', text: '<div>Dzień dobry, od rana nie mogę się zalogować do panelu klienta.</div>\n\n' },
  fields: [
    { path: 'event', label: '„nowe” albo „odpowiedz” - wpisane na stałe w treści każdej z dwóch reguł' },
    { path: 'ticket_id', label: 'numer zgłoszenia' },
    { path: 'text', label: 'opis zgłoszenia (HTML)' },
    { path: 'mobile', label: 'telefon komórkowy zgłaszającego; często tylko to pole jest wypełnione' },
    { path: 'phone', label: 'telefon stacjonarny zgłaszającego' },
    { path: 'subject', label: 'temat - gdy dodasz do reguły pole "subject": "{{ticket.subject}}"' },
  ],
  inbound: {
    to: { fallback: [] },
    text: TEKST,
    maxParts: 1, overflow: 'truncate',
  },
  expect: { text: 'Nowe zgloszenie #6541 - Dzien dobry, od rana nie moge sie zalogowac do panelu klienta.' },
  sampleSource: 'Freshdesk, żywa instancja, 2026-09-02: ładunki reguł „Tworzenie zgłoszeń” i „Wysłano odpowiedź” przez Zgłaszającego (z cytowaną korespondencją)',
  simple: {
    inbound: {
      addressField: 'we Freshdesku w obu regułach automatyzacji jako adres elementu webhook',
      recipients: { source: 'list', note: 'Freshdesk nie przesyła numerów agentów, więc SMS idzie zawsze na numery wpisane tutaj.' },
      when: [
        { id: 'nowe-i-odpowiedzi', label: 'przy nowym zgłoszeniu i przy odpowiedzi klienta', condition: { mode: 'builder', rules: [] } },
        { id: 'tylko-nowe', label: 'tylko przy nowym zgłoszeniu', condition: { mode: 'builder', rules: [{ path: 'event', op: 'eq', value: 'nowe' }] } },
      ],
      text: [
        { id: 'z-trescia', label: 'numer zgłoszenia i początek treści', text: TEKST },
        { id: 'krotko', label: 'tylko numer zgłoszenia', text: { mode: 'liquid', template: '{% if p.event == "odpowiedz" %}Odpowiedź klienta w #{{ p.ticket_id }}{% else %}Nowe zgłoszenie #{{ p.ticket_id }}{% endif %}' } },
      ],
      auth: { kind: 'none', note: 'Freshdesk nie ma pola na hasło ani nagłówki, a żądania przychodzą z różnych adresów chmury. Zabezpieczeniem jest sekret w adresie wejściowym i limit burzy.' },
    },
  },
  guide: [
    'We Freshdesku **Admin → Workflows → Automations**. Dwie reguły, obie z akcją **Uruchom element webhook**: POST, adres wejściowy integracji, Szyfrowanie JSON, Treść „Zaawansowane”.',
    '',
    '**Tworzenie zgłoszeń → Nowa reguła**, warunek „Źródło jest” ze wszystkimi źródłami (reguła bez warunku się nie zapisze), treść:',
    '',
    '```json',
    '{ "event": "nowe", "ticket_id": "{{ticket.id}}", "subject": "{{ticket.subject}}", "phone": "{{ticket.contact.phone}}", "mobile": "{{ticket.contact.mobile}}", "text": "{{ticket.description}}" }',
    '```',
    '',
    '**Aktualizacja zgłoszeń → Nowa reguła**, zdarzenie „Wysłano odpowiedź” wykonane przez Zgłaszającego, treść:',
    '',
    '```json',
    '{ "event": "odpowiedz", "ticket_id": "{{ticket.id}}", "subject": "{{ticket.subject}}", "phone": "{{ticket.contact.phone}}", "mobile": "{{ticket.contact.mobile}}", "text": "{{ticket.latest_public_comment}}" }',
    '```',
    '',
    'Freshdesk nie ma pola na hasło ani nagłówki, a żądania przychodzą z różnych adresów chmury - chroni sekret w adresie wejściowym i limit burzy.',
  ].join('\n'),
};
