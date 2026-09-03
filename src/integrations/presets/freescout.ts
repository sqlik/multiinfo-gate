import type { Preset } from './types.ts';

export const freescout: Preset = {
  id: 'freescout',
  name: 'FreeScout: zgłoszenie z SMS-a',
  blurb: 'Odebrany SMS zakłada rozmowę w skrzynce FreeScouta',
  kinds: ['webhook_out'],
  fields: [
    { path: 'from', label: 'numer nadawcy' },
    { path: 'text', label: 'treść SMS-a' },
    { path: 'receivedAt', label: 'czas odbioru' },
  ],
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
  simple: {
    outbound: {
      address: { label: 'Adres FreeScouta', hint: 'Adres Twojego FreeScouta z końcówką /api/conversations', placeholder: 'https://pomoc.firma.pl/api/conversations' },
      secrets: [{ ref: 'apiKey', label: 'Klucz API FreeScouta', hint: 'We FreeScoucie: Zarządzaj → API & Webhooks → API Keys', transform: 'raw' }],
      params: [{ key: 'mailboxId', label: 'Numer skrzynki', hint: 'Numer widoczny w adresie ustawień skrzynki we FreeScoucie, np. 1', digits: true }],
      note: 'Każdy odebrany SMS zakłada rozmowę typu „phone” w tej skrzynce; agent widzi numer i treść.',
    },
  },
  expect: {
    outboundJson: { type: 'phone', mailboxId: 1, subject: 'SMS od 48601000001', customer: { firstName: 'SMS', lastName: '48601000001', phone: '48601000001' }, threads: [{ type: 'customer', text: 'Pomocy, nie działa' }] },
  },
  sampleSource: 'FreeScout 1.8, żywa instancja, 2026-09-02: POST /api/conversations (201, id na wierzchu)',
  guide: [
    'Wymaga modułu **API & Webhooks**. W bramce podaj adres `https://<freescout>/api/conversations`, klucz API (zakładka API Keys) jako sekret i w body numer skrzynki (`mailboxId`) zamiast `1`. Bramka zakłada rozmowę typu „phone” z klientem „SMS <numer>” - FreeScout wymaga imienia albo e-maila, a numeru nie dopasowuje do istniejących kontaktów. Identyfikator rozmowy z odpowiedzi (`id`) widać przy odebranej wiadomości w panelu.',
    '',
    'Agent widzi rozmowę w skrzynce i oddzwania albo odpisuje własnym kanałem; bramka nie wysyła odpowiedzi z FreeScouta SMS-em. Żeby agenci dostawali SMS o nowych rozmowach, dodaj osobno ustawienie „FreeScout: nowe zgłoszenie”.',
  ].join('\n'),
};
