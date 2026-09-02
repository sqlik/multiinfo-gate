import type { Preset } from './types.ts';

export const freshdesk: Preset = {
  id: 'freshdesk',
  name: 'Freshdesk',
  blurb: 'SMS zakłada zgłoszenie; odpowiedź agenta wraca SMS-em przez automatyzację',
  kinds: ['webhook_in', 'webhook_out'],
  sample: { ticket_id: '4821', phone: '+48 601 000 001', text: 'Dziękujemy, sprawa rozwiązana.' },
  fields: [
    { path: 'ticket_id', label: 'identyfikator zgłoszenia' },
    { path: 'phone', label: 'telefon kontaktu' },
    { path: 'text', label: 'treść odpowiedzi agenta' },
  ],
  inbound: {
    to: { path: 'phone', fallback: [] }, ticketRefPath: 'ticket_id',
    text: { mode: 'liquid', template: '{{ p.text | strip_html | strip }}' },
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
    recipients: ['48601000001'], text: 'Dziękujemy, sprawa rozwiązana.',
    outboundJson: { subject: 'SMS od 48601000001', description: 'Pomocy, nie działa', phone: '48601000001', name: 'SMS 48601000001', status: 2, priority: 1, source: 3 },
  },
  sampleSource: 'Freshdesk API v2 - do potwierdzenia na instancji',
  guide: [
    '**Z SMS-a.** Adres `https://<firma>.freshdesk.com/api/v2/tickets`. Freshdesk uwierzytelnia basic auth z kluczem API jako loginem i `X` jako hasłem - w sekrecie wpisz gotowy nagłówek `Basic <base64(klucz:X)>`. Identyfikator zgłoszenia z odpowiedzi (`id`) trafia do bramki.',
    '',
    '**Do SMS.** W Freshdesku **Admin → Automations → Ticket updates**: przy odpowiedzi agenta akcja **Trigger webhook**, `POST`, `application/json`, adres wejściowy integracji, treść:',
    '',
    '```json',
    '{ "ticket_id": "{{ticket.id}}", "phone": "{{ticket.contact.phone}}", "text": "{{ticket.latest_public_comment}}" }',
    '```',
    '',
    'Bramka wysyła SMS jako odpowiedź w wątku, gdy `ticket_id` pasuje do zgłoszenia założonego wcześniej z SMS-a.',
  ].join('\n'),
};
