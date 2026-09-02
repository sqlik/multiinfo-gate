import type { Preset } from './types.ts';

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
    text: { mode: 'liquid', template: '{% capture t %}{% if p.event == "odpowiedz" %}Odpowiedź klienta w #{{ p.ticket_id }}{% else %}Nowe zgłoszenie #{{ p.ticket_id }}{% endif %}{% if p.subject %}: {{ p.subject }}{% endif %} - {{ p.text | html_text | sms_truncate: 100 }}{% endcapture %}{{ t | gsm }}' },
    maxParts: 1, overflow: 'truncate',
  },
  expect: { text: 'Nowe zgloszenie #6541 - Dzien dobry, od rana nie moge sie zalogowac do panelu klienta.' },
  sampleSource: 'Freshdesk, prawdziwy ładunek z reguły „Tworzenie zgłoszeń” z żywej instancji, 2026-09-02',
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
    'Numery agentów wpisz w bramce w liście zapasowej. Freshdesk nie ma pola na nagłówki, a żądania przychodzą z różnych adresów chmury AWS, więc uwierzytelnieniem zostaje sekret w adresie i limit burzy.',
  ].join('\n'),
};
