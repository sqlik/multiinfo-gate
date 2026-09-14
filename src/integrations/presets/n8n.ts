import type { Preset } from './types.ts';

export const n8n: Preset = {
  id: 'n8n',
  name: 'n8n',
  blurb: 'SMS z przepływu n8n oraz odebrany SMS jako wyzwalacz przepływu',
  kinds: ['webhook_in', 'webhook_out'],
  sample: { to: '48601000001', text: 'Zadanie zakonczone bledem' },
  fields: [
    { path: 'to', label: 'numer albo lista numerów' },
    { path: 'text', label: 'treść SMS-a' },
    { path: 'eventId', label: 'identyfikator zdarzenia do idempotencji (opcjonalny)' },
  ],
  inbound: { to: { path: 'to', fallback: [] }, text: { mode: 'path', path: 'text' }, eventIdPath: 'eventId', maxParts: 3, overflow: 'reject' },
  outbound: { body: { mode: 'json', template: '{{ p | json }}' } },
  expect: {
    recipients: ['48601000001'], text: 'Zadanie zakonczone bledem',
    outboundJson: { event: 'message.received', at: '2026-09-02T10:00:00.000Z', id: 'in_1', serviceId: '24138', from: '48601000001', to: '7968', kind: 'text', text: 'Pomocy, nie działa', receivedAt: '2026-09-02T10:00:00.000Z', relatedMessageId: null },
  },
  sampleSource: 'n8n 2.35.7, żywa instancja, 2026-09-14: węzeł HTTP Request przyjęty przez bramkę (202), węzeł Webhook odebrał zdarzenie w przepływie aktywnym',
  simple: {
    inbound: {
      addressField: 'w n8n w węźle HTTP Request w polu URL',
      recipients: { source: 'payload', note: 'Numer przychodzi w polu to z przepływu. Numery wpisane tutaj są zapasowe, gdy przepływ numeru nie prześle.' },
      when: [{ id: 'zawsze', label: 'przy każdym żądaniu z przepływu', condition: { mode: 'builder', rules: [] } }],
      text: [{ id: 'pole-text', label: 'treść z pola text', text: { mode: 'path', path: 'text' } }],
      auth: { kind: 'header', name: 'Authorization', prefix: 'Bearer ', label: 'Hasło, które n8n wyśle w nagłówku', where: 'w n8n w węźle HTTP Request: Authentication → Generic Credential Type → Header Auth, nazwa Authorization, wartość Bearer <hasło>' },
    },
    outbound: {
      address: { label: 'Adres webhooka n8n', hint: 'Adres produkcyjny z węzła Webhook w przepływie', placeholder: 'https://n8n.firma.pl/webhook/sms' },
      secrets: [], params: [],
      note: 'Bramka wysyła całe zdarzenie jako JSON. Węzeł Webhook wkłada je do pola body, więc w przepływie czytasz je wyrażeniem $json.body.text.',
    },
  },
  guide: [
    '**Do SMS.** W przepływie dodaj węzeł **HTTP Request**. **Method** ustaw na `POST`, **URL** to adres wejściowy integracji, **Send Body** włącz, **Body Content Type** ustaw na `JSON`. W ciele podaj dwa pola: `to` z numerem oraz `text` z treścią. Wartości z poprzedniego węzła wstawisz wyrażeniem, na przykład `{{ $json.telefon }}`.',
    '',
    'Hasło ustaw w **Authentication → Generic Credential Type → Header Auth**: nazwa `Authorization`, wartość `Bearer <hasło z bramki>`.',
    '',
    '**Z SMS-a.** W przepływie dodaj węzeł **Webhook**, **HTTP Method** ustaw na `POST`, skopiuj adres produkcyjny i wklej go jako adres integracji wychodzącej. Węzeł Webhook wkłada całe zdarzenie do pola `body`, więc pola odczytasz wyrażeniami `{{ $json.body.from }}` oraz `{{ $json.body.text }}`. Przepływ musi być zapisany oraz aktywny, bo adres testowy działa tylko przy otwartym oknie.',
    '',
    'n8n stoi zwykle w sieci prywatnej. Bramka domyślnie nie woła adresów prywatnych. Ustaw `MIG_WEBHOOK_ALLOW_PRIVATE=1` albo wystaw n8n pod adresem publicznym.',
  ].join('\n'),
};
