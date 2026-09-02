import type { Preset } from './types.ts';

export const freescout: Preset = {
  id: 'freescout',
  name: 'FreeScout',
  blurb: 'SMS zakłada rozmowę w skrzynce; odpowiedź agenta wraca SMS-em w wątku',
  kinds: ['webhook_in', 'webhook_out'],
  // Webhook convo.agent.reply.created z FreeScouta 1.8 (przycięty): customer bez telefonów, threads[0] to odpowiedź agenta.
  sample: {
    id: 4821, number: 10143, threadsCount: 2, type: 'phone', status: 'active', subject: 'SMS od 48601000001',
    preview: 'Odpowiadamy: sprawdzamy sprawę.', mailboxId: 1,
    customer: { id: 8, type: 'customer', firstName: 'Anna', lastName: 'Nowak', photoUrl: '', email: 'anna@example' },
    _embedded: {
      threads: [
        { id: 101, type: 'message', status: 'active', state: 'published', body: '<div>Odpowiadamy: sprawdzamy sprawę.</div>', source: { type: 'web', via: 'user' }, createdAt: '2026-09-02T17:17:08Z' },
        { id: 100, type: 'customer', status: 'active', state: 'published', body: 'Pomocy, nie działa', source: { type: 'api', via: 'customer' }, createdAt: '2026-09-02T17:16:09Z' },
      ],
    },
  },
  fields: [
    { path: 'id', label: 'identyfikator rozmowy (ten sam, który bramka dostała przy założeniu)' },
    { path: 'number', label: 'numer rozmowy widoczny w FreeScoucie' },
    { path: 'subject', label: 'temat rozmowy' },
    { path: '_embedded.threads[0].type', label: '„message” = odpowiedź agenta, „customer” = wiadomość klienta' },
    { path: '_embedded.threads[0].body', label: 'treść najnowszego wątku (HTML)' },
    { path: 'customer.email', label: 'e-mail klienta; webhook nie przesyła telefonów' },
  ],
  inbound: {
    to: { fallback: [] },
    ticketRefPath: 'id',
    condition: { mode: 'builder', rules: [{ path: '_embedded.threads[0].type', op: 'eq', value: 'message' }] },
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
    text: 'Odpowiadamy: sprawdzamy sprawę.',
    outboundJson: { type: 'phone', mailboxId: 1, subject: 'SMS od 48601000001', customer: { phone: '48601000001' }, threads: [{ type: 'customer', text: 'Pomocy, nie działa' }] },
  },
  sampleSource: 'FreeScout 1.8, prawdziwy webhook convo.agent.reply.created z żywej instancji, 2026-09-02 (kierunek z SMS-a do potwierdzenia)',
  guide: [
    '**Z SMS-a.** Wymaga modułu **API & Webhooks**. W bramce podaj adres `https://<freescout>/api/conversations`, klucz API jako sekret i w body numer skrzynki (`mailboxId`) zamiast `1`. Identyfikator rozmowy z odpowiedzi (`id`) trafia do bramki jako identyfikator zgłoszenia i łączy rozmowę z numerem nadawcy.',
    '',
    '**Do SMS.** W module webhooków dodaj webhook z adresem wejściowym integracji i jednym zdarzeniem: `convo.agent.reply.created`. FreeScout wysyła całą rozmowę z wątkami od najnowszego; bramka zdejmuje HTML z treści najnowszego wątku i wysyła SMS do nadawcy odebranego SMS-a, z którego rozmowa powstała (webhook nie przesyła telefonu klienta, więc numer bierze się z wątku po `id`). Warunek `_embedded.threads[0].type równe message` pilnuje, żeby SMS-a nie wywołała wiadomość klienta, gdyby webhook dostał też inne zdarzenia.',
  ].join('\n'),
};
