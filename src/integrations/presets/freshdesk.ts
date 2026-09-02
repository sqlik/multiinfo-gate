import type { Preset } from './types.ts';

export const freshdesk: Preset = {
  id: 'freshdesk',
  name: 'Freshdesk: zgłoszenie z SMS-a',
  blurb: 'Odebrany SMS zakłada zgłoszenie we Freshdesku (API v2)',
  kinds: ['webhook_out'],
  fields: [
    { path: 'from', label: 'numer nadawcy' },
    { path: 'text', label: 'treść SMS-a' },
    { path: 'receivedAt', label: 'czas odbioru' },
  ],
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
  simple: {
    outbound: {
      address: { label: 'Adres Freshdeska', hint: 'Adres Twojego Freshdeska z końcówką /api/v2/tickets', placeholder: 'https://firma.freshdesk.com/api/v2/tickets' },
      secrets: [{ ref: 'authorization', label: 'Klucz API Freshdeska', hint: 'We Freshdesku: awatar → Ustawienia profilu → Twój klucz API; bramka sama zamieni go na nagłówek', transform: 'basic-x' }],
      params: [],
      note: 'Każdy odebrany SMS zakłada zgłoszenie z numerem nadawcy jako telefonem kontaktu; agent widzi numer i treść.',
    },
  },
  expect: {
    outboundJson: { subject: 'SMS od 48601000001', description: 'Pomocy, nie działa', phone: '48601000001', name: 'SMS 48601000001', status: 2, priority: 1, source: 3 },
  },
  sampleSource: 'Freshdesk, żywa instancja, 2026-09-02: POST /api/v2/tickets (201, id na wierzchu, kontakt z phone)',
  guide: [
    'Adres `https://<firma>.freshdesk.com/api/v2/tickets`. Freshdesk uwierzytelnia basic auth z kluczem API jako loginem i `X` jako hasłem - w sekrecie wpisz gotowy nagłówek `Basic <base64(klucz:X)>` (klucz API: awatar → Ustawienia profilu). Body zakłada zgłoszenie ze źródłem „Telefon”, telefonem i nazwą „SMS <numer>”. Freshdesk dopasowuje kontakt po dokładnym zapisie numeru - kontakty z numerem `48601000001` zostaną rozpoznane, z `601000001` nie i powstanie nowy kontakt bez e-maila.',
    '',
    'Agent widzi zgłoszenie i oddzwania albo odpisuje własnym kanałem; bramka nie wysyła odpowiedzi z Freshdeska SMS-em. Żeby agenci dostawali SMS o nowych zgłoszeniach, dodaj osobno ustawienie „Freshdesk: nowe zgłoszenie”.',
  ].join('\n'),
};
