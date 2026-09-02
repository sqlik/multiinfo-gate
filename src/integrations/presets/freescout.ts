import type { Preset } from './types.ts';

export const freescout: Preset = {
  id: 'freescout',
  name: 'FreeScout',
  blurb: 'SMS zakłada rozmowę w skrzynce; odpowiedź agenta wraca SMS-em w wątku',
  kinds: ['webhook_in', 'webhook_out'],
  sample: {
    id: 4821,
    customer: { phones: [{ value: '+48 601 000 001', type: 1 }] },
    _embedded: { threads: [{ type: 'message', body: '<p>Odpowiadamy: sprawdzamy sprawę.</p>' }] },
  },
  fields: [
    { path: 'id', label: 'identyfikator rozmowy (zgłoszenia)' },
    { path: 'customer.phones[0].value', label: 'numer klienta' },
    { path: '_embedded.threads[0].body', label: 'treść odpowiedzi agenta (HTML)' },
  ],
  inbound: {
    to: { path: 'customer.phones[0].value', fallback: [] },
    ticketRefPath: 'id',
    text: { mode: 'liquid', template: '{{ p._embedded.threads[0].body | strip_html | strip }}' },
    maxParts: 3, overflow: 'truncate',
  },
  outbound: {
    url: 'https://freescout.example/api/conversations',
    headers: [{ name: 'X-FreeScout-API-Key', valueRef: 'apiKey' }],
    body: {
      mode: 'json',
      template: '{"type": "phone", "mailboxId": 1, "subject": {{ "SMS od " | append: from | json }}, "customer": {"phone": {{ from | json }}}, "threads": [{"type": "customer", "text": {{ text | json }}}]}',
    },
    responseRefPath: 'id',
  },
  secrets: [{ ref: 'apiKey', label: 'Klucz API FreeScouta', hint: 'Moduł API & Webhooks, zakładka API Keys' }],
  expect: {
    recipients: ['48601000001'], text: 'Odpowiadamy: sprawdzamy sprawę.',
    outboundJson: { type: 'phone', mailboxId: 1, subject: 'SMS od 48601000001', customer: { phone: '48601000001' }, threads: [{ type: 'customer', text: 'Pomocy, nie działa' }] },
  },
  sampleSource: 'FreeScout API & Webhooks - do potwierdzenia na instancji',
  guide: [
    '**Z SMS-a.** Wymaga modułu **API & Webhooks**. W bramce podaj adres `https://<freescout>/api/conversations`, klucz API jako sekret i w body numer skrzynki (`mailboxId`) zamiast `1`. Identyfikator rozmowy z odpowiedzi trafia do bramki jako identyfikator zgłoszenia.',
    '',
    '**Do SMS.** W module webhooków dodaj zdarzenie `convo.agent.reply` z adresem wejściowym integracji. FreeScout wysyła rozmowę z ostatnim wątkiem; bramka bierze numer z pierwszego telefonu klienta, zdejmuje HTML z treści i wysyła SMS jako odpowiedź w wątku, gdy identyfikator rozmowy pasuje do wcześniej odebranej.',
  ].join('\n'),
};
