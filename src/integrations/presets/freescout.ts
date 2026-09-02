import type { Preset } from './types.ts';

export const freescout: Preset = {
  id: 'freescout',
  name: 'FreeScout: rozmowa SMS',
  blurb: 'SMS klienta zakłada rozmowę w skrzynce; odpowiedź agenta wraca SMS-em w wątku',
  kinds: ['webhook_in', 'webhook_out'],
  // Webhook convo.note.created z FreeScouta 1.8 (przycięty): rozmowa „phone” założona przez bramkę, notatka agenta.
  sample: {
    id: 4821, number: 10144, threadsCount: 2, type: 'phone', status: 'active', state: 'published', subject: 'SMS od 48601000001',
    preview: 'Odpowiadamy: sprawdzamy sprawę.', mailboxId: 1,
    customer: { id: 46, type: 'customer', firstName: 'SMS', lastName: '48601000001', photoUrl: '', email: '' },
    source: { type: 'api', via: 'customer' },
    _embedded: {
      threads: [
        { id: 104, type: 'note', status: 'active', state: 'published', body: 'Odpowiadamy: sprawdzamy sprawę.', source: { type: 'web', via: 'user' }, createdAt: '2026-09-02T17:43:15Z' },
        { id: 103, type: 'customer', status: 'active', state: 'published', body: 'Pomocy, nie działa', source: { type: 'api', via: 'customer' }, createdAt: '2026-09-02T17:30:50Z' },
      ],
    },
  },
  fields: [
    { path: 'id', label: 'identyfikator rozmowy (ten sam, który bramka dostała przy założeniu)' },
    { path: 'number', label: 'numer rozmowy widoczny we FreeScoucie' },
    { path: 'type', label: '„phone” dla rozmów zakładanych przez bramkę z SMS-ów' },
    { path: '_embedded.threads[0].type', label: '„note” = notatka agenta, „message” = odpowiedź, „customer” = wiadomość klienta' },
    { path: '_embedded.threads[0].body', label: 'treść najnowszego wątku (notatka jako tekst, odpowiedź jako HTML)' },
    { path: 'customer.lastName', label: 'numer klienta - bramka zakłada klienta „SMS <numer>”' },
  ],
  inbound: {
    to: { fallback: [] },
    ticketRefPath: 'id',
    // Liquid liczy „and” i „or” od prawej: phone and (note or message). Rozmowy e-mailowe i wiadomości klienta odpadają.
    condition: { mode: 'liquid', expr: '{% if p.type == "phone" and p._embedded.threads[0].type == "note" or p._embedded.threads[0].type == "message" %}tak{% endif %}' },
    text: { mode: 'liquid', template: '{{ p._embedded.threads[0].body | html_text }}' },
    maxParts: 3, overflow: 'truncate',
  },
  outbound: {
    url: 'https://freescout.example/api/conversations',
    headers: [{ name: 'X-FreeScout-API-Key', valueRef: 'apiKey' }],
    body: {
      mode: 'json',
      // FreeScout wymaga imienia albo e-maila klienta - sam numer odrzuca kodem 400.
      template: '{"type": "phone", "mailboxId": 1, "subject": {{ "SMS od " | append: from | json }}, "customer": {"firstName": "SMS", "lastName": {{ from | json }}, "phone": {{ from | json }}}, "threads": [{"type": "customer", "text": {{ text | json }}}]}',
    },
    responseRefPath: 'id',
  },
  secrets: [{ ref: 'apiKey', label: 'Klucz API FreeScouta', hint: 'Moduł API & Webhooks, zakładka API Keys' }],
  expect: {
    text: 'Odpowiadamy: sprawdzamy sprawę.',
    outboundJson: { type: 'phone', mailboxId: 1, subject: 'SMS od 48601000001', customer: { firstName: 'SMS', lastName: '48601000001', phone: '48601000001' }, threads: [{ type: 'customer', text: 'Pomocy, nie działa' }] },
  },
  sampleSource: 'FreeScout 1.8, żywa instancja, 2026-09-02: POST /api/conversations (201, id na wierzchu), webhooki convo.created, convo.note.created i convo.agent.reply.created',
  guide: [
    '**Z SMS-a.** Wymaga modułu **API & Webhooks**. W bramce podaj adres `https://<freescout>/api/conversations`, klucz API (zakładka API Keys) jako sekret i w body numer skrzynki (`mailboxId`) zamiast `1`. Bramka zakłada rozmowę typu „phone” z klientem „SMS <numer>” (FreeScout wymaga imienia albo e-maila). Identyfikator rozmowy z odpowiedzi (`id`) trafia do bramki jako identyfikator zgłoszenia i łączy rozmowę z numerem nadawcy.',
    '',
    '**Do SMS.** Klient „SMS <numer>” nie ma e-maila, więc FreeScout nie daje w takiej rozmowie formularza odpowiedzi - agent odpowiada **notatką**. W module webhooków dodaj webhook z adresem wejściowym integracji i zdarzeniami `convo.note.created` oraz `convo.agent.reply.created`. Bramka bierze treść najnowszego wątku, zdejmuje HTML i wysyła SMS do nadawcy odebranego SMS-a, z którego rozmowa powstała (webhook nie przesyła telefonu klienta, numer bierze się z wątku po `id`). Domyślny warunek przepuszcza tylko rozmowy typu „phone” z notatką albo odpowiedzią agenta, więc notatki w rozmowach e-mailowych zostają wewnętrzne. Najlepiej trzymać rozmowy SMS w osobnej skrzynce i ograniczyć do niej webhook.',
  ].join('\n'),
};
