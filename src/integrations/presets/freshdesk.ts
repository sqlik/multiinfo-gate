import type { Preset } from './types.ts';

export const freshdesk: Preset = {
  id: 'freshdesk',
  name: 'Freshdesk: rozmowa SMS',
  blurb: 'SMS klienta zakłada zgłoszenie; odpowiedź agenta wraca SMS-em przez regułę automatyzacji',
  kinds: ['webhook_in', 'webhook_out'],
  // Ładunek definiuje reguła automatyzacji („Wysłano odpowiedź”); Freshdesk dokleja do odpowiedzi nazwisko agenta i stopkę.
  sample: {
    ticket_id: '6541', phone: '48601000001', mobile: '',
    text: "Anna Kowalska : <div style='font-family:Helvetica Neue, Helvetica, Arial, sans-serif; font-size:13px'>Dziękujemy, sprawa rozwiązana.<div><br></div><div><div>Pozdrawiam</div><div><strong>Anna Kowalska</strong></div></div></div>",
  },
  fields: [
    { path: 'ticket_id', label: 'numer zgłoszenia (ten sam, który bramka dostała przy założeniu)' },
    { path: 'text', label: 'odpowiedź agenta (HTML) z przedrostkiem „Imię Nazwisko : ” i stopką' },
    { path: 'phone', label: 'telefon zgłaszającego - zgłoszenia zakładane przez bramkę mają go wypełniony' },
    { path: 'mobile', label: 'telefon komórkowy zgłaszającego' },
  ],
  inbound: {
    to: { path: 'phone', fallback: [] }, ticketRefPath: 'ticket_id',
    text: { mode: 'liquid', template: '{{ p.text | html_text }}' },
    maxParts: 3, overflow: 'truncate',
  },
  outbound: {
    url: 'https://firma.freshdesk.com/api/v2/tickets',
    headers: [{ name: 'Authorization', valueRef: 'authorization' }],
    body: {
      mode: 'json',
      template: '{"subject": {{ "SMS od " | append: from | json }}, "description": {{ text | json }}, "phone": {{ from | json }}, "name": {{ "SMS " | append: from | json }}, "status": 2, "priority": 1, "source": 3}',
    },
    responseRefPath: 'id',
  },
  secrets: [{ ref: 'authorization', label: 'Nagłówek Authorization', hint: 'Basic i base64 z „klucz API:X”, np. Basic Zm9vOlg=' }],
  expect: {
    recipients: ['48601000001'], text: 'Anna Kowalska : Dziękujemy, sprawa rozwiązana. Pozdrawiam Anna Kowalska',
    outboundJson: { subject: 'SMS od 48601000001', description: 'Pomocy, nie działa', phone: '48601000001', name: 'SMS 48601000001', status: 2, priority: 1, source: 3 },
  },
  sampleSource: 'Freshdesk, żywa instancja, 2026-09-02: POST /api/v2/tickets (201, id na wierzchu, kontakt z phone) i ładunki reguł automatyzacji',
  guide: [
    '**Z SMS-a.** Adres `https://<firma>.freshdesk.com/api/v2/tickets`. Freshdesk uwierzytelnia basic auth z kluczem API jako loginem i `X` jako hasłem - w sekrecie wpisz gotowy nagłówek `Basic <base64(klucz:X)>`. Body zakłada zgłoszenie ze źródłem „Telefon” (`source: 3`), telefonem i nazwą „SMS <numer>”. Identyfikator z odpowiedzi (`id`) trafia do bramki jako identyfikator zgłoszenia.',
    '',
    '**Do SMS.** **Admin → Workflows → Automations → Aktualizacja zgłoszeń → Nowa reguła**: zdarzenie „Wysłano odpowiedź” wykonane przez Konsultanta, warunek „Źródło jest Telefon” (żeby odpowiedzi w zwykłych zgłoszeniach nie szły SMS-em), akcja **Uruchom element webhook**: POST, adres wejściowy integracji, JSON, Treść „Zaawansowane”:',
    '',
    '```json',
    '{ "ticket_id": "{{ticket.id}}", "phone": "{{ticket.contact.phone}}", "mobile": "{{ticket.contact.mobile}}", "text": "{{ticket.latest_public_comment}}" }',
    '```',
    '',
    'Freshdesk dokleja do treści odpowiedzi „Imię Nazwisko : ” i stopkę agenta - jeśli SMS ma być krótki, wyłącz stopkę agentom obsługującym SMS-y. Gdy `ticket_id` pasuje do zgłoszenia założonego z SMS-a, SMS idzie w wątku do nadawcy; numer z `phone` służy jako zapasowy, gdy zgłoszenie nie pochodzi z bramki.',
  ].join('\n'),
};
